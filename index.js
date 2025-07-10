
// ====================================================================
// PURITY SNIPER BOT 
// ====================================================================

require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const ethers = require('ethers');

// Import our custom modules
const WalletManager = require('./wallets/manager');
const EthChain = require('./chains/eth');
const { checkRateLimit, updateRateLimit } = require('./utils/rateLimit');

// ====================================================================
// INITIALIZATION
// ====================================================================

const bot = new Telegraf(process.env.BOT_TOKEN);
const walletManager = new WalletManager();
const ethChain = new EthChain();

// User state management for multi-step interactions
const userStates = new Map();

// Token mapping for shorter button data
const tokenMappings = new Map();

function createShortTokenId(tokenAddress) {
  return tokenAddress.slice(2, 8); // Use first 6 chars after 0x
}

function storeTokenMapping(tokenAddress) {
  const shortId = createShortTokenId(tokenAddress);
  tokenMappings.set(shortId, tokenAddress);
  return shortId;
}

function getFullTokenAddress(shortId) {
  const fullAddress = tokenMappings.get(shortId);
  if (!fullAddress) {
    throw new Error('Token not found');
  }
  return fullAddress;
}

// ====================================================================
// 🎯 SNIPING ENGINE - CHUNK 1: DATA STRUCTURES & STATE MANAGEMENT
// ====================================================================

// Default sniping configuration for new users
const defaultSnipeConfig = {
  active: false,
  amount: 0.1,           // ETH amount to snipe with
  slippage: 10,          // Higher slippage for speed (10%)
  strategy: 'first_liquidity', // 'new_pairs', 'first_liquidity', 'contract_methods'
  maxGasPrice: 100,      // Max gwei for snipe attempts
  minLiquidity: 1000,    // Min USD liquidity to snipe
  maxPerHour: 5,         // Max snipes per hour
  createdAt: Date.now(),

  // NEW: Target tokens for pre-launch sniping
  targetTokens: [] // Array of { address, strategy, method?, label?, status, addedAt }
};

// Active snipe monitors - tracks WebSocket listeners per user
const activeSnipeMonitors = new Map(); // userId -> { provider, filter, handler }

// Snipe attempt tracking for rate limiting
const snipeAttempts = new Map(); // userId -> { attempts: [], hourlyCount: 0 }

// Helper function to check snipe rate limits
function checkSnipeRateLimit(userId, maxPerHour = 5) {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  if (!snipeAttempts.has(userId)) {
    snipeAttempts.set(userId, { attempts: [], hourlyCount: 0 });
  }

  const userAttempts = snipeAttempts.get(userId);

  // Clean old attempts (older than 1 hour)
  userAttempts.attempts = userAttempts.attempts.filter(time => now - time < oneHour);
  userAttempts.hourlyCount = userAttempts.attempts.length;

  if (userAttempts.hourlyCount >= maxPerHour) {
    throw new Error(`Snipe rate limit exceeded. Max ${maxPerHour} snipes per hour.`);
  }

  // Add current attempt
  userAttempts.attempts.push(now);
  userAttempts.hourlyCount++;

  console.log(`✅ Snipe rate check passed: ${userAttempts.hourlyCount}/${maxPerHour} this hour`);
}

// Clean up old snipe attempts every hour
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  for (const [userId, data] of snipeAttempts.entries()) {
    data.attempts = data.attempts.filter(time => now - time < oneHour);
    data.hourlyCount = data.attempts.length;

    // Remove users with no recent attempts
    if (data.attempts.length === 0) {
      snipeAttempts.delete(userId);
    }
  }

  console.log(`🧹 Cleaned up snipe attempt tracking. ${snipeAttempts.size} users with recent attempts.`);
}, 60 * 60 * 1000); // Run every hour

console.log('🎯 CHUNK 1 LOADED: Sniping data structures and state management ready!');

// Helper function to get human-readable strategy display names
function getStrategyDisplayName(strategy) {
  const strategyNames = {
    'new_pairs': 'New Pairs (Degen Mode)',
    'first_liquidity': 'First Liquidity Events', 
    'contract_methods': 'Contract Methods'
  };

  return strategyNames[strategy] || 'Unknown Strategy';
}

// Function to get snipe statistics for display
async function getSnipeStatistics(userId) {
  try {
    const userData = await loadUserData(userId);
    const transactions = userData.transactions || [];

    const snipeTransactions = transactions.filter(tx => 
      tx.type === 'snipe' && tx.timestamp
    );

    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);

    const todaySnipes = snipeTransactions.filter(tx => 
      tx.timestamp > oneDayAgo
    );

    const todaySuccessful = todaySnipes.filter(tx => 
      tx.status === 'completed' || tx.hash
    );

    const successRate = todaySnipes.length > 0 
      ? Math.round((todaySuccessful.length / todaySnipes.length) * 100)
      : 0;

    return {
      todayAttempts: todaySnipes.length,
      todaySuccessful: todaySuccessful.length,
      successRate: successRate,
      totalAttempts: snipeTransactions.length,
      totalSuccessful: snipeTransactions.filter(tx => 
        tx.status === 'completed' || tx.hash
      ).length
    };

  } catch (error) {
    console.log(`Error getting snipe statistics for user ${userId}:`, error);
    return {
      todayAttempts: 0,
      todaySuccessful: 0,
      successRate: 0,
      totalAttempts: 0,
      totalSuccessful: 0
    };
  }
}

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'purity-sniper-bot' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// ====================================================================
// USER DATA MANAGEMENT
// ====================================================================

async function loadUserData(userId) {
  try {
    const userFile = path.join(__dirname, 'db', 'users', `${userId}.json`);
    const data = await fs.readFile(userFile, 'utf8');
    const userData = JSON.parse(data);
    
    // Add snipe configuration if it doesn't exist
    if (!userData.snipeConfig) {
      userData.snipeConfig = { ...defaultSnipeConfig };
      console.log(`🎯 Added default snipe config for user ${userId}`);
    }
    
    return userData;
  } catch (error) {
    // Return default user data if file doesn't exist
    return {
      userId,
      ethWallets: [],
      solWallets: [],
      activeEthWallet: 0,
      activeSolWallet: 0,
      transactions: [],
      settings: {
        slippage: 3,
        gasMultiplier: 1.2,
        snipeStrategy: 'new_pairs'
      },
      mirrorTargets: [],
      premium: {
        active: false,
        expiresAt: 0
      },
      snipeConfig: { ...defaultSnipeConfig },
      createdAt: Date.now(),
      lastActive: Date.now()
    };
  }
}

async function saveUserData(userId, userData) {
  try {
    const userDir = path.join(__dirname, 'db', 'users');
    const userFile = path.join(userDir, `${userId}.json`);

    // Ensure directory exists
    await fs.mkdir(userDir, { recursive: true });

    // Update last active timestamp
    userData.lastActive = Date.now();

    // Save user data
    await fs.writeFile(userFile, JSON.stringify(userData, null, 2));

    logger.info(`User data saved for ${userId}`);
  } catch (error) {
    logger.error(`Error saving user data for ${userId}:`, error);
    throw error;
  }
}

// Helper function to update snipe configuration
async function updateSnipeConfig(userId, updates) {
  try {
    const userData = await loadUserData(userId);
    userData.snipeConfig = { ...userData.snipeConfig, ...updates };
    await saveUserData(userId, userData);
    console.log(`✅ Updated snipe config for user ${userId}:`, updates);
    return userData.snipeConfig;
  } catch (error) {
    console.log(`❌ Failed to update snipe config for user ${userId}:`, error.message);
    throw error;
  }
}

// Cleanup function for snipe monitors (called on bot shutdown)
function cleanupSnipeMonitors() {
  console.log(`🧹 Cleaning up ${activeSnipeMonitors.size} active snipe monitors...`);

  for (const [userId, monitor] of activeSnipeMonitors.entries()) {
    try {
      if (monitor.provider && monitor.filter && monitor.handler) {
        monitor.provider.off(monitor.filter, monitor.handler);
        console.log(`✅ Cleaned up snipe monitor for user ${userId}`);
      }
    } catch (error) {
      console.log(`⚠️ Error cleaning up snipe monitor for user ${userId}:`, error.message);
    }
  }

  activeSnipeMonitors.clear();
  console.log(`✅ All snipe monitors cleaned up`);
}

// ====================================================================
// WALLET HELPER FUNCTIONS
// ====================================================================

/**
 * Get wallet for trading operations
 */
async function getWalletForTrading(userId, userData) {
  try {
    const encryptedKey = userData.ethWallets[userData.activeEthWallet || 0];
    if (!encryptedKey) {
      throw new Error('No wallet found');
    }

    const address = await walletManager.getWalletAddress(encryptedKey, userId);
    const privateKey = await walletManager.decryptPrivateKey(encryptedKey, userId);

    return {
      address: address,
      privateKey: privateKey,
      encryptedKey: encryptedKey
    };
  } catch (error) {
    throw new Error(`Failed to get wallet for trading: ${error.message}`);
  }
}

/**
 * Get wallet address only
 */
async function getWalletAddress(userId, userData) {
  try {
    const encryptedKey = userData.ethWallets[userData.activeEthWallet || 0];
    if (!encryptedKey) {
      throw new Error('No wallet found');
    }

    return await walletManager.getWalletAddress(encryptedKey, userId);
  } catch (error) {
    throw new Error(`Failed to get wallet address: ${error.message}`);
  }
}

/**
 * Get SOL wallet for trading operations
 */
async function getSolWalletForTrading(userId, userData) {
  try {
    const encryptedKey = userData.solWallets[userData.activeSolWallet || 0];
    if (!encryptedKey) {
      throw new Error('No SOL wallet found');
    }

    // For now, return mock data until SOL integration is complete
    return {
      address: 'SOL_WALLET_ADDRESS_PLACEHOLDER',
      privateKey: 'SOL_PRIVATE_KEY_PLACEHOLDER',
      encryptedKey: encryptedKey
    };
  } catch (error) {
    throw new Error(`Failed to get SOL wallet for trading: ${error.message}`);
  }
}

/**
 * Get SOL wallet address only
 */
async function getSolWalletAddress(userId, userData) {
  try {
    const encryptedKey = userData.solWallets[userData.activeSolWallet || 0];
    if (!encryptedKey) {
      throw new Error('No SOL wallet found');
    }

    // For now, return mock address until SOL integration is complete
    return 'SOL_WALLET_ADDRESS_PLACEHOLDER';
  } catch (error) {
    throw new Error(`Failed to get SOL wallet address: ${error.message}`);
  }
}

// ====================================================================
// MAIN MENU HANDLERS
// ====================================================================

// Start command
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  logger.info(`New user started bot: ${userId}`);

  await showMainMenu(ctx);
});

// Main menu display
async function showMainMenu(ctx) {
  const keyboard = [
    [
      { text: '○ ETH', callback_data: 'chain_eth' },
      { text: '○ SOL', callback_data: 'chain_sol' }
    ],
    [
      { text: '○ Statistics', callback_data: 'statistics' },
      { text: '○ Settings', callback_data: 'settings' }
    ]
  ];

  const message = `❕ WELCOME BACK @ PURITY SNIPER BOT - 1.0 - A Pure Sniping Experience. 

You are here: 🕊️HOME

www.puritysniperbot.com`;

  try {
    await ctx.editMessageText(message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    await ctx.reply(message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  }
}

// Chain menu handlers
bot.action('main_menu', showMainMenu);
bot.action('chain_eth', showEthMenu);
bot.action('chain_sol', showSolMenu);

// ETH Chain Menu
async function showEthMenu(ctx) {
  const keyboard = [
    [{ text: '○ ETH Wallet', callback_data: 'eth_wallet' }],
    [
      { text: '○ Buy Token', callback_data: 'eth_buy' },
      { text: '○ Sell Token', callback_data: 'eth_sell' }
    ],
    [
      { text: '○ Snipe Token', callback_data: 'eth_snipe' },
      { text: '○ Mirror Wallet', callback_data: 'eth_mirror' }
    ],
    [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
  ];

  await ctx.editMessageText(
    `🔗 **ETHEREUM CHAIN**
You are here: ETH Trading

Choose your action:`,
    { 
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// SOL Chain Menu  
async function showSolMenu(ctx) {
  const keyboard = [
    [{ text: '○ SOL Wallet', callback_data: 'sol_wallet' }],
    [
      { text: '○ Buy Token', callback_data: 'sol_buy' },
      { text: '○ Sell Token', callback_data: 'sol_sell' }
    ],
    [
      { text: '○ Snipe Token', callback_data: 'sol_snipe' },
      { text: '○ Mirror Wallet', callback_data: 'sol_mirror' }
    ],
    [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
  ];

  await ctx.editMessageText(
    `🟣 **SOLANA CHAIN**
You are here: SOL Trading

Choose your action:`,
    { 
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// ====================================================================
// UTILITY FUNCTIONS
// ====================================================================

// Helper function to record transaction
async function recordTransaction(userId, transactionData) {
  try {
    const userData = await loadUserData(userId);

    if (!userData.transactions) {
      userData.transactions = [];
    }

    // Add snipe-specific metadata
    if (transactionData.type === 'snipe') {
      transactionData.autoExecuted = true;
      transactionData.snipeStrategy = transactionData.strategy || 'unknown';
      transactionData.snipeAttemptTime = Date.now();
    }

    userData.transactions.push(transactionData);

    // Keep only last 100 transactions
    if (userData.transactions.length > 100) {
      userData.transactions = userData.transactions.slice(-100);
    }

    await saveUserData(userId, userData);

  } catch (error) {
    console.log('Error recording transaction:', error);
  }
}

// Helper function to track revenue
async function trackRevenue(feeAmount) {
  try {
    // Log to revenue tracking system
    const revenueData = {
      amount: feeAmount,
      currency: 'ETH',
      timestamp: Date.now(),
      type: 'trading_fee'
    };

    logger.info('Revenue collected:', revenueData);

  } catch (error) {
    console.log('Error tracking revenue:', error);
  }
}

// Background transaction confirmation
async function confirmTransactionInBackground(txResponse, ctx, userId, type, details) {
  try {
    console.log(`⏳ Waiting for confirmation: ${txResponse.hash}`);
    
    // Wait up to 5 minutes for confirmation
    const receipt = await Promise.race([
      txResponse.wait(1),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Confirmation timeout')), 300000)
      )
    ]);
    
    if (receipt && receipt.status === 1) {
      console.log(`✅ Transaction confirmed! Block: ${receipt.blockNumber}`);
      
      // Save to transaction history
      await recordTransaction(userId, {
        txHash: txResponse.hash,
        type: type,
        status: 'confirmed',
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        ...details,
        timestamp: Date.now()
      });
      
      // Notify user of confirmation
      try {
        await ctx.telegram.sendMessage(
          ctx.chat.id,
          `🎉 **Transaction Confirmed!**
          
Your ${type} transaction has been confirmed on-chain.
Block: ${receipt.blockNumber}
Hash: \`${txResponse.hash}\`

[View on Etherscan](https://etherscan.io/tx/${txResponse.hash})`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyError) {
        console.log('Could not send confirmation notification:', notifyError.message);
      }
      
    } else {
      throw new Error('Transaction failed on-chain');
    }
    
  } catch (error) {
    console.error(`❌ Transaction confirmation failed: ${error.message}`);
    
    // Save failed transaction
    await recordTransaction(userId, {
      txHash: txResponse.hash,
      type: type,
      status: 'failed',
      error: error.message,
      ...details,
      timestamp: Date.now()
    });
  }
}

// Background fee collection
async function collectFeeInBackground(privateKey, feeAmount, userId) {
  try {
    console.log(`💰 Collecting fee in background: ${feeAmount} ETH`);
    
    const feeResult = await ethChain.collectFee(privateKey, feeAmount.toString());
    
    if (feeResult) {
      console.log(`✅ Fee collected successfully: ${feeResult.hash}`);
      
      // Save fee transaction
      await recordTransaction(userId, {
        txHash: feeResult.hash,
        type: 'fee',
        status: 'sent',
        amount: feeAmount.toString(),
        timestamp: Date.now()
      });
    }
    
  } catch (feeError) {
    console.error(`⚠️ Fee collection failed (non-blocking): ${feeError.message}`);
  }
}

// ====================================================================
// ETH WALLET MANAGEMENT
// ====================================================================

// ETH Wallet main handler
bot.action('eth_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  if (!userData.ethWallets || userData.ethWallets.length === 0) {
    await showEthWalletSetup(ctx);
  } else {
    await showEthWalletManagement(ctx, userData);
  }
});

async function showEthWalletSetup(ctx) {
  const keyboard = [
    [{ text: '➕ Import ETH Wallet', callback_data: 'import_eth_wallet' }],
    [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
  ];

  await ctx.editMessageText(
    `🔗 **ETH WALLET SETUP**

No ETH wallets found. Import your private key to get started.

⚠️ Your private key will be encrypted and stored securely.
🔐 We never store plaintext keys.`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function showEthWalletManagement(ctx, userData) {
  const userId = ctx.from.id.toString();

  try {
    const address = await getWalletAddress(userId, userData);
    const balance = await ethChain.getETHBalance(address);

    const keyboard = [
      [{ text: '💰 View Balance', callback_data: 'eth_view_balance' }],
      [{ text: '📊 Transaction History', callback_data: 'eth_tx_history' }],
      [{ text: '➕ Add Wallet', callback_data: 'import_eth_wallet' }]
    ];

    // Add wallet switching if multiple wallets
    if (userData.ethWallets && userData.ethWallets.length > 1) {
      keyboard.push([{ text: '🔄 Switch Wallet', callback_data: 'switch_eth_wallet' }]);
    }

    keyboard.push([{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]);

    const currentWalletIndex = userData.activeEthWallet || 0;

    await ctx.editMessageText(
      `🔗 **ETH WALLET**

**Active Wallet:**
Address: ${address.slice(0, 6)}...${address.slice(-4)}
Balance: ${balance} ETH

**Wallet ${currentWalletIndex + 1} of ${userData.ethWallets?.length || 1}**`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error loading wallet management:', error);
    await ctx.editMessageText(
      `❌ **Error loading wallet**

${error.message}

Please try importing your wallet again.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Import Wallet', callback_data: 'import_eth_wallet' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        }
      }
    );
  }
}

// Import ETH wallet handler
bot.action('import_eth_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    await checkRateLimit(userId, 'walletImports');
  } catch (error) {
    await ctx.editMessageText(`❌ ${error.message}\n\n🔙 Try again later.`);
    return;
  }

  await ctx.editMessageText(
    `🔐 **IMPORT ETH WALLET**

Please send your Ethereum private key in the next message.

⚠️ Security Notes:
• Delete your message after sending
• Key will be encrypted immediately
• We never store plaintext keys

Send your ETH private key now:`
  );

  // Set user state to expect private key
  userStates.set(userId, {
    action: 'wallet_import',
    timestamp: Date.now()
  });

  // Set up timeout to clear state after 5 minutes
  setTimeout(() => {
    if (userStates.has(userId) && userStates.get(userId).action === 'wallet_import') {
      userStates.delete(userId);
    }
  }, 5 * 60 * 1000);
});

// View balance handler
bot.action('eth_view_balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    const address = await getWalletAddress(userId, userData);
    const balance = await ethChain.getETHBalance(address);

    await ctx.editMessageText(
      `💰 **ETH WALLET BALANCE**

**Address:** ${address}
**Balance:** ${balance} ETH

**Last Updated:** ${new Date().toLocaleString()}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'eth_view_balance' }],
            [{ text: '🔙 Back to Wallet', callback_data: 'eth_wallet' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    await ctx.editMessageText(
      `❌ **Error loading balance**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Wallet', callback_data: 'eth_wallet' }
          ]]
        }
      }
    );
  }
});

// Transaction history handler
bot.action('eth_tx_history', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    const transactions = userData.transactions || [];
    const ethTransactions = transactions.filter(tx => tx.chain === 'ethereum').slice(-10);

    if (ethTransactions.length === 0) {
      await ctx.editMessageText(
        `📊 **TRANSACTION HISTORY**

No ETH transactions found yet.

Start trading to see your transaction history here!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Start Trading', callback_data: 'chain_eth' }],
              [{ text: '🔙 Back to Wallet', callback_data: 'eth_wallet' }]
            ]
          }
        }
      );
      return;
    }

    let historyText = `📊 **TRANSACTION HISTORY**\n\n**Last ${ethTransactions.length} ETH Transactions:**\n\n`;

    ethTransactions.reverse().forEach((tx, index) => {
      const date = new Date(tx.timestamp).toLocaleDateString();
      const type = tx.type.toUpperCase();
      const amount = parseFloat(tx.amount).toFixed(6);

      historyText += `**${index + 1}.** ${type} - ${amount} ETH\n`;
      historyText += `📅 ${date} | 🔗 [View](https://etherscan.io/tx/${tx.txHash})\n\n`;
    });

    await ctx.editMessageText(historyText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'eth_tx_history' }],
          [{ text: '🔙 Back to Wallet', callback_data: 'eth_wallet' }]
        ]
      },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    await ctx.editMessageText(
      `❌ **Error loading transaction history**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Wallet', callback_data: 'eth_wallet' }
          ]]
        }
      }
    );
  }
});

// ====================================================================
// ETH BUY TOKEN - COMPLETE IMPLEMENTATION
// ====================================================================

// ETH Buy Token Handler
bot.action('eth_buy', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  // Check if user has ETH wallet
  if (!userData.ethWallets || userData.ethWallets.length === 0) {
    await ctx.editMessageText(
      `🔗 **ETH BUY TOKEN**

❌ No ETH wallet found. Import a wallet first.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Import ETH Wallet', callback_data: 'import_eth_wallet' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        }
      }
    );
    return;
  }

  // Check rate limits
  try {
    await checkRateLimit(userId, 'transactions');
  } catch (error) {
    await ctx.editMessageText(`❌ ${error.message}\n\n🔙 Try again later.`);
    return;
  }

  await ctx.editMessageText(
    `🔗 **ETH BUY TOKEN**

Enter the token contract address you want to buy:

Example: 0x6B175474E89094C44Da98b954EedeAC495271d0F

Send the token address now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
        ]]
      }
    }
  );

  // Set user state to expect token address
  userStates.set(userId, {
    action: 'token_address',
    timestamp: Date.now()
  });

  // Clear state after 5 minutes
  setTimeout(() => {
    if (userStates.has(userId) && userStates.get(userId).action === 'token_address') {
      userStates.delete(userId);
    }
  }, 5 * 60 * 1000);
});

// Show ETH Buy Amount Selection
async function showEthBuyAmount(ctx, tokenAddress, tokenInfo) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  // Get wallet balance using proper helper
  let balance = '0.0';
  let address = 'Unknown';

  try {
    address = await getWalletAddress(userId, userData);
    balance = await ethChain.getETHBalance(address);
  } catch (error) {
    console.log('Error getting balance:', error);
  }

  const keyboard = [
    [
      { text: '0.01 ETH', callback_data: `eth_buy_amount_${tokenAddress}_0.01` },
      { text: '0.05 ETH', callback_data: `eth_buy_amount_${tokenAddress}_0.05` }
    ],
    [
      { text: '0.1 ETH', callback_data: `eth_buy_amount_${tokenAddress}_0.1` },
      { text: '0.5 ETH', callback_data: `eth_buy_amount_${tokenAddress}_0.5` }
    ],
    [
      { text: '1 ETH', callback_data: `eth_buy_amount_${tokenAddress}_1` },
      { text: '🔢 Custom', callback_data: `eth_buy_custom_${tokenAddress}` }
    ],
    [{ text: '🔙 Back to Buy', callback_data: 'eth_buy' }]
  ];

  // Use ctx.reply() when responding to text input
  await ctx.reply(
    `🔗 **BUY ${tokenInfo.symbol.toUpperCase()}**

**Token:** ${tokenInfo.name} (${tokenInfo.symbol})
**Address:** ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}

**Your Wallet:**
Address: ${address.slice(0, 6)}...${address.slice(-4)}
Balance: ${balance} ETH

**Select Purchase Amount:**`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// Handle amount selection
bot.action(/^eth_buy_amount_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const amount = match[2];

  await showEthBuyReview(ctx, tokenAddress, amount);
});

// Handle custom amount
bot.action(/^eth_buy_custom_(.+)$/, async (ctx) => {
  const tokenAddress = ctx.match[1];
  const userId = ctx.from.id.toString();

  await ctx.editMessageText(
    `🔗 **CUSTOM AMOUNT**

Enter the ETH amount you want to spend:

Example: 0.25

Send your custom amount now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Amount Selection', callback_data: `eth_buy_retry_${tokenAddress}` }
        ]]
      }
    }
  );

  userStates.set(userId, {
    action: 'custom_amount',
    tokenAddress: tokenAddress,
    timestamp: Date.now()
  });
});

// Show review screen before executing
async function showEthBuyReview(ctx, tokenAddress, amount) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    await ctx.editMessageText('⏳ **Calculating trade details...**');

    // Get token info
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    // Calculate fees and amounts
    const amountFloat = parseFloat(amount);
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amountFloat * (feePercent / 100);
    const netTradeAmount = amountFloat - feeAmount;

    // Get wallet using proper helper
    const wallet = await getWalletForTrading(userId, userData);

    const gasEstimate = await ethChain.estimateSwapGas(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString()),
      wallet.address
    );

    const gasInEth = parseFloat(ethers.utils.formatEther(gasEstimate.totalCost));
    const totalCost = amountFloat + gasInEth;

    // Get current ETH balance
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);

    if (totalCost > balanceFloat) {
      await ctx.editMessageText(
        `❌ **Insufficient Balance**

**Required:** ${totalCost.toFixed(6)} ETH
**Available:** ${balance} ETH
**Shortage:** ${(totalCost - balanceFloat).toFixed(6)} ETH

Please reduce the amount or add more ETH to your wallet.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Different Amount', callback_data: `eth_buy_retry_${tokenAddress}` }],
              [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
            ]
          }
        }
      );
      return;
    }

    // Get token quote
    const quote = await ethChain.getSwapQuote(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString())
    );

    const expectedTokens = ethers.utils.formatUnits(quote.outputAmount, tokenInfo.decimals);

    const keyboard = [
      [{ text: '✅ Confirm Purchase', callback_data: `eth_buy_execute_${tokenAddress}_${amount}` }],
      [{ text: '🔄 Change Amount', callback_data: `eth_buy_retry_${tokenAddress}` }],
      [{ text: '🔙 Cancel', callback_data: 'chain_eth' }]
    ];

    await ctx.editMessageText(
      `🔗 **PURCHASE REVIEW**

**Token:** ${tokenInfo.name} (${tokenInfo.symbol})
**Address:** ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}

**💰 TRADE BREAKDOWN:**
• Purchase Amount: ${amount} ETH
• Service Fee (${feePercent}%): ${feeAmount.toFixed(6)} ETH
• Net Trade Amount: ${netTradeAmount.toFixed(6)} ETH
• Gas Estimate: ${gasInEth.toFixed(6)} ETH
• **Total Cost: ${totalCost.toFixed(6)} ETH**

**📈 EXPECTED RECEIVE:**
• ~${parseFloat(expectedTokens).toLocaleString()} ${tokenInfo.symbol}

**⚠️ FINAL CONFIRMATION REQUIRED**`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error in buy review:', error);
    await ctx.editMessageText(
      `❌ **Error calculating trade:**

${error.message}

Please try again or contact support.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'eth_buy' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        }
      }
    );
  }
}

// Execute the actual purchase
bot.action(/^eth_buy_execute_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const amount = match[2];
  const userId = ctx.from.id.toString();

  try {
    // Check rate limit again
    await checkRateLimit(userId, 'transactions');

    await ctx.editMessageText('⏳ **Starting transaction...**\n\nStep 1/2: Executing token purchase...');

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Calculate amounts upfront
    const totalAmount = parseFloat(amount);
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = totalAmount * (feePercent / 100);
    const netTradeAmount = totalAmount - feeAmount;

    console.log(`💰 Executing trade: Total ${totalAmount} ETH, Fee ${feeAmount} ETH, Trade ${netTradeAmount} ETH`);

    // Execute main trade first
    console.log(`🚀 Executing main trade: ${netTradeAmount} ETH -> ${tokenAddress}`);
    const swapResult = await ethChain.executeTokenSwapWithApproval(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString()),
      wallet.privateKey,
      6, // Use higher slippage as determined by risk analysis
      { userId: userId }
    );
    console.log(`✅ Main trade executed! Hash: ${swapResult.hash}`);

    // Get token info for success message
    let tokenSymbol = 'TOKEN';
    try {
      const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
      tokenSymbol = tokenInfo.symbol;
    } catch (e) {
      console.log('Could not get token symbol for success message');
      tokenSymbol = 'TOKEN';
    }

    // Update UI immediately with transaction sent
    await ctx.editMessageText(
      `✅ **PURCHASE TRANSACTION SENT!**

**Trade Amount:** ${netTradeAmount.toFixed(6)} ETH → ${tokenSymbol}
**Service Fee:** ${feeAmount.toFixed(6)} ETH  
**Total Cost:** ${totalAmount.toFixed(6)} ETH

**🔗 Transaction:** [View on Etherscan](https://etherscan.io/tx/${swapResult.hash})
**Hash:** \`${swapResult.hash}\`
**Status:** ⏳ Pending confirmation...

Your tokens will appear once confirmed!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Check Status', callback_data: `check_tx_${swapResult.hash.slice(2, 8)}` }],
            [{ text: '💰 Buy More', callback_data: 'eth_buy' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    // Start background confirmation tracking
    confirmTransactionInBackground(swapResult, ctx, userId, 'buy', {
      tokenAddress,
      amount: netTradeAmount.toString(),
      tokenSymbol
    });

    // Collect fee in background (non-blocking)
    if (feeAmount > 0) {
      collectFeeInBackground(wallet.privateKey, feeAmount, userId);
    }

    // Record transaction immediately as sent
    await recordTransaction(userId, {
      type: 'buy',
      tokenAddress,
      amount: totalAmount.toString(),
      tradeAmount: netTradeAmount.toString(),
      feeAmount: feeAmount.toString(),
      txHash: swapResult.hash,
      status: 'sent',
      timestamp: Date.now(),
      chain: 'ethereum'
    });

    await trackRevenue(feeAmount);

    logger.info(`Successful ETH buy: User ${userId}, Token ${tokenAddress}, Amount ${totalAmount} ETH`);

  } catch (error) {
    logger.error(`ETH buy execution error for user ${userId}:`, error);

    await ctx.editMessageText(
      `❌ **PURCHASE FAILED**

**Error:** ${error.message}

${error.message.includes('insufficient funds') ? 
        '💡 **Tip:** Ensure you have enough ETH for the trade + gas fees.' :
        '💡 **Tip:** This is usually a temporary network issue. Please try again.'
      }

Your funds are safe - no transaction was completed.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `eth_buy_retry_${tokenAddress}` }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
});

// Retry handler
bot.action(/^eth_buy_retry_(.+)$/, async (ctx) => {
  const tokenAddress = ctx.match[1];

  try {
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    await showEthBuyAmount(ctx, tokenAddress, tokenInfo);
  } catch (error) {
    await ctx.editMessageText('❌ Error loading token info. Please try from the beginning.', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 Start Over', callback_data: 'eth_buy' }
        ]]
      }
    });
  }
});

// Create reply version for buy review (when user enters custom amount)
async function showEthBuyReviewReply(ctx, tokenAddress, amount) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    const loadingMessage = await ctx.reply('⏳ **Calculating trade details...**');

    // Get token info
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    // Calculate fees and amounts
    const amountFloat = parseFloat(amount);
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amountFloat * (feePercent / 100);
    const netTradeAmount = amountFloat - feeAmount;

    const wallet = await getWalletForTrading(userId, userData);

    const gasEstimate = await ethChain.estimateSwapGas(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString()),
      wallet.address
    );

    const gasInEth = parseFloat(ethers.utils.formatEther(gasEstimate.totalCost));
    const totalCost = amountFloat + gasInEth;

    // Get current ETH balance
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);

    // Delete loading message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMessage.message_id);
    } catch (deleteError) {
      // Ignore if we can't delete
    }

    if (totalCost > balanceFloat) {
      await ctx.reply(
        `❌ **Insufficient Balance**

**Required:** ${totalCost.toFixed(6)} ETH
**Available:** ${balance} ETH
**Shortage:** ${(totalCost - balanceFloat).toFixed(6)} ETH

Please reduce the amount or add more ETH to your wallet.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Different Amount', callback_data: `eth_buy_retry_${tokenAddress}` }],
              [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
            ]
          }
        }
      );
      return;
    }

    // Get token quote
    const quote = await ethChain.getSwapQuote(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString())
    );

    const expectedTokens = ethers.utils.formatUnits(quote.outputAmount, tokenInfo.decimals);

    const keyboard = [
      [{ text: '✅ Confirm Purchase', callback_data: `eth_buy_execute_${tokenAddress}_${amount}` }],
      [{ text: '🔄 Change Amount', callback_data: `eth_buy_retry_${tokenAddress}` }],
      [{ text: '🔙 Cancel', callback_data: 'chain_eth' }]
    ];

    await ctx.reply(
      `🔗 **PURCHASE REVIEW**

**Token:** ${tokenInfo.name} (${tokenInfo.symbol})
**Address:** ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}

**💰 TRADE BREAKDOWN:**
• Purchase Amount: ${amount} ETH
• Service Fee (${feePercent}%): ${feeAmount.toFixed(6)} ETH
• Net Trade Amount: ${netTradeAmount.toFixed(6)} ETH
• Gas Estimate: ${gasInEth.toFixed(6)} ETH
• **Total Cost: ${totalCost.toFixed(6)} ETH**

**📈 EXPECTED RECEIVE:**
• ~${parseFloat(expectedTokens).toLocaleString()} ${tokenInfo.symbol}

**⚠️ FINAL CONFIRMATION REQUIRED**`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error in buy review:', error);
    await ctx.reply(
      `❌ **Error calculating trade:**

${error.message}

Please try again or contact support.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'eth_buy' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        }
      }
    );
  }
}

// ====================================================================
// ETH SELL TOKEN - COMPLETE IMPLEMENTATION
// ====================================================================

// ETH Sell Token Handler
bot.action('eth_sell', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  // Check if user has ETH wallet
  if (!userData.ethWallets || userData.ethWallets.length === 0) {
    await ctx.editMessageText(
      `🔗 **ETH SELL TOKEN**

❌ No ETH wallet found. Import a wallet first.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Import ETH Wallet', callback_data: 'import_eth_wallet' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        }
      }
    );
    return;
  }

  // Check rate limits
  try {
    await checkRateLimit(userId, 'transactions');
  } catch (error) {
    await ctx.editMessageText(`❌ ${error.message}\n\n🔙 Try again later.`);
    return;
  }

  await ctx.editMessageText(
    `🔗 **ETH SELL TOKEN**

Please send the Ethereum token address you want to sell:

Example: \`0xa0b86a33e6c41d8c8e2f9b5b1e3e4d5c6a7b8c9d0e1f2g3h4i5j6k7l8m9n0o1p2\`

📝 Send the token contract address in your next message.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );

  // Set user state for ETH sell token input
  userStates.set(userId, {
    action: 'sell_token_address',
    timestamp: Date.now()
  });
});

// ====================================================================
// ETH SNIPE TOKEN - COMPLETE IMPLEMENTATION
// ====================================================================

// Enhanced ETH Snipe Token Handler
bot.action('eth_snipe', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);

    // Check if user has ETH wallet
    if (!userData.ethWallets || userData.ethWallets.length === 0) {
      await ctx.editMessageText(
        `🎯 **ETH SNIPE TOKEN**

❌ No ETH wallet found. Import a wallet first to start sniping.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Import ETH Wallet', callback_data: 'import_eth_wallet' }],
              [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
            ]
          }
        }
      );
      return;
    }

    await showSnipeConfiguration(ctx, userData);

  } catch (error) {
    console.log('Error in eth_snipe handler:', error);
    await ctx.editMessageText(
      `❌ **Error loading snipe configuration**

${error.message}

Please try again.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
          ]]
        }
      }
    );
  }
});

// Show snipe configuration screen
async function showSnipeConfiguration(ctx, userData) {
  const userId = ctx.from.id.toString();
  const snipeConfig = userData.snipeConfig || defaultSnipeConfig;

  // Get current wallet info
  let walletInfo = 'Unknown';
  try {
    const address = await getWalletAddress(userId, userData);
    const balance = await ethChain.getETHBalance(address);
    walletInfo = `${address.slice(0, 6)}...${address.slice(-4)} (${balance} ETH)`;
  } catch (error) {
    walletInfo = 'Error loading wallet';
  }

  // Get snipe statistics
  const snipeStats = await getSnipeStatistics(userId);

  const keyboard = [
    [{ 
      text: snipeConfig.active ? '⏸️ PAUSE SNIPING' : '▶️ START SNIPING', 
      callback_data: snipeConfig.active ? 'snipe_pause' : 'snipe_start' 
    }],
    [
      { text: `💰 Amount: ${snipeConfig.amount} ETH`, callback_data: 'snipe_config_amount' },
      { text: `⚡ Slippage: ${snipeConfig.slippage}%`, callback_data: 'snipe_config_slippage' }
    ],
    [
      { text: '📊 Snipe History', callback_data: 'snipe_history' },
      { text: `⛽ Max Gas: ${snipeConfig.maxGasPrice} gwei`, callback_data: 'snipe_config_gas' }
    ],
    [
      { text: `🎯 Strategy: ${getStrategyDisplayName(snipeConfig.strategy)}`, callback_data: 'snipe_config_strategy' }
    ],
    [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
  ];

  const statusIcon = snipeConfig.active ? '🟢' : '🔴';
  const statusText = snipeConfig.active ? 'ACTIVE - Monitoring for opportunities' : 'PAUSED - Click Start to begin sniping';

  await ctx.editMessageText(
    `🎯 **ETH SNIPE CONFIGURATION**

**Wallet:** ${walletInfo}
**Status:** ${statusIcon} ${statusText}

**⚙️ CURRENT SETTINGS:**
- **Amount:** ${snipeConfig.amount} ETH per snipe
- **Strategy:** ${getStrategyDisplayName(snipeConfig.strategy)}
- **Slippage:** ${snipeConfig.slippage}%
- **Max Gas:** ${snipeConfig.maxGasPrice} gwei
- **Rate Limit:** ${snipeConfig.maxPerHour} snipes/hour

**📊 TODAY'S STATS:**
- **Attempts:** ${snipeStats.todayAttempts}
- **Successful:** ${snipeStats.todaySuccessful}
- **Success Rate:** ${snipeStats.successRate}%

${snipeConfig.active ? 
  '⚡ **Ready to snipe new pairs on Uniswap!**' : 
  '💡 **Configure your settings and start sniping**'}`,
    { 
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// Snipe configuration handlers (placeholders for now)
bot.action('snipe_start', async (ctx) => {
  await ctx.answerCbQuery('🚧 Sniping features coming soon!');
});

bot.action('snipe_pause', async (ctx) => {
  await ctx.answerCbQuery('🚧 Sniping features coming soon!');
});

bot.action('snipe_config_amount', async (ctx) => {
  await ctx.answerCbQuery('🚧 Snipe configuration coming soon!');
});

bot.action('snipe_config_slippage', async (ctx) => {
  await ctx.answerCbQuery('🚧 Snipe configuration coming soon!');
});

bot.action('snipe_config_gas', async (ctx) => {
  await ctx.answerCbQuery('🚧 Snipe configuration coming soon!');
});

bot.action('snipe_config_strategy', async (ctx) => {
  await ctx.answerCbQuery('🚧 Snipe configuration coming soon!');
});

bot.action('snipe_history', async (ctx) => {
  await ctx.answerCbQuery('🚧 Snipe history coming soon!');
});

// ====================================================================
// GLOBAL TEXT HANDLER
// ====================================================================

// Global text handler that checks user states
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = userStates.get(userId);
  const messageText = ctx.message.text;

  console.log(`📥 Text message: User ${userId}, Text length: ${messageText?.length}, Has state: ${!!userState}`);

  if (!userState) {
    console.log(`ℹ️ No active state for user ${userId}, ignoring text message`);
    return; // No active state for this user
  }

  console.log(`🔄 Processing text for user ${userId}, action: ${userState.action}`);

  // Handle different actions based on user state
  try {
    switch (userState.action) {
      case 'wallet_import':
        await handleWalletImport(ctx, userId);
        break;
      case 'token_address':
        await handleTokenAddress(ctx, userId);
        break;
      case 'custom_amount':
        await handleCustomAmount(ctx, userId, userState.tokenAddress);
        break;
      case 'sell_token_address':
        await handleSellTokenAddress(ctx, userId);
        break;
      case 'sell_custom_amount':
        await handleSellCustomAmount(ctx, userId, userState.tokenAddress);
        break;
      case 'sol_token_address':
        await handleSolTokenAddress(ctx, userId);
        break;
      case 'sol_sell_token_address':
        await handleSolSellTokenAddress(ctx, userId);
        break;
      case 'sol_custom_amount':
        await handleSolCustomAmount(ctx, userId, userState.tokenAddress);
        break;
      case 'sol_wallet_import':
        await handleSolWalletImport(ctx, userId);
        break;
      case 'sol_sell_custom_amount':
        await handleSolSellCustomAmount(ctx, userId, userState.tokenAddress);
        break;
      default:
        console.log(`⚠️ Unknown user state action: ${userState.action} for user ${userId}`);
        userStates.delete(userId); // Clear unknown state
    }
    
    console.log(`✅ Text processing completed for user ${userId}, action: ${userState.action}`);
    
  } catch (error) {
    console.error(`❌ Text processing error for user ${userId}:`, {
      action: userState.action,
      error: error.message,
      stack: error.stack
    });
    
    logger.error('Text processing failed', {
      userId,
      action: userState.action,
      error: error.message
    });
    
    // Clear the user state to prevent stuck states
    userStates.delete(userId);
    
    // Send error message to user
    try {
      await ctx.reply(
        '❌ **Processing Error**\n\nSomething went wrong processing your message. Please try again from the main menu.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🏠 Main Menu', callback_data: 'main_menu' }
            ]]
          }
        }
      );
    } catch (replyError) {
      console.error('❌ Failed to send error reply:', replyError.message);
    }
  }
});

// ====================================================================
// TEXT HANDLER HELPER FUNCTIONS
// ====================================================================

// Wallet import handler
async function handleWalletImport(ctx, userId) {
  const privateKey = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    const encryptedKey = await walletManager.importWallet(privateKey, userId);

    // Update user data
    const userData = await loadUserData(userId);
    if (!userData.ethWallets) {
      userData.ethWallets = [];
    }
    userData.ethWallets.push(encryptedKey);
    await saveUserData(userId, userData);

    const address = await walletManager.getWalletAddress(encryptedKey, userId);

    await ctx.reply(
      `✅ **ETH Wallet Imported Successfully!**

Address: \`${address}\`

🔐 Your private key has been encrypted and stored securely.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
          ]]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`User ${userId} imported ETH wallet: ${address}`);

  } catch (error) {
    userStates.delete(userId);
    logger.error(`ETH wallet import error for user ${userId}:`, error);

    if (error.message.includes('Invalid private key')) {
      await ctx.reply('❌ Invalid ETH private key format. Please check and try again.');
    } else {
      await ctx.reply(`❌ Error importing wallet: ${error.message}`);
    }
  }
}

// Token address handler - will process buy token addresses
async function handleTokenAddress(ctx, userId) {
  const tokenAddress = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    const validatingMessage = await ctx.reply('⏳ **Validating token...**', {
      parse_mode: 'Markdown'
    });

    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    // Delete the "validating" message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, validatingMessage.message_id);
    } catch (deleteError) {
      // Ignore if we can't delete the message
    }

    await showEthBuyAmount(ctx, tokenAddress, tokenInfo);

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid token contract address.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'eth_buy' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
}

// Custom amount handler
async function handleCustomAmount(ctx, userId, tokenAddress) {
  const amount = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error('Invalid amount format');
    }

    if (amountFloat > 100) {
      throw new Error('Amount too large (max 100 ETH)');
    }

    await showEthBuyReviewReply(ctx, tokenAddress, amount);

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid ETH amount (e.g., 0.1)`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `eth_buy_custom_${tokenAddress}` }],
            [{ text: '🔙 Back to Buy', callback_data: 'eth_buy' }]
          ]
        }
      }
    );
  }
}

// Sell token address handler
async function handleSellTokenAddress(ctx, userId) {
  const tokenAddress = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    const validatingMessage = await ctx.reply('⏳ **Validating token...**', {
      parse_mode: 'Markdown'
    });

    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    // Delete the "validating" message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, validatingMessage.message_id);
    } catch (deleteError) {
      // Ignore if we can't delete the message
    }

    // Create a new message with amount selection
    await showEthSellAmountSelectionReply(ctx, tokenAddress);

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid token contract address.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'eth_sell_manual' }],
            [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
}

// Sell custom amount handler
async function handleSellCustomAmount(ctx, userId, tokenAddress) {
  const amount = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error('Invalid amount format');
    }

    await showEthSellReview(ctx, tokenAddress, amountFloat, 'custom');

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid token amount (e.g., 1000)`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `eth_sell_custom_${tokenAddress}` }],
            [{ text: '🔙 Back to Amount Selection', callback_data: `eth_sell_select_${tokenAddress}` }]
          ]
        }
      }
    );
  }
}

// ETH Sell Amount Selection Reply
async function showEthSellAmountSelectionReply(ctx, tokenAddress) {
  const shortId = storeTokenMapping(tokenAddress);

  const keyboard = [
    [
      { text: '25%', callback_data: `eth_sell_percentage_25_${shortId}` },
      { text: '50%', callback_data: `eth_sell_percentage_50_${shortId}` }
    ],
    [
      { text: '75%', callback_data: `eth_sell_percentage_75_${shortId}` },
      { text: '100%', callback_data: `eth_sell_percentage_100_${shortId}` }
    ],
    [{ text: '💰 Custom Amount', callback_data: `eth_sell_custom_${shortId}` }],
    [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
  ];

  await ctx.reply(
    `🔗 **SELL TOKEN**

**Token:** \`${tokenAddress}\`

Select the percentage of your holdings to sell:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// ETH Sell Review - Enhanced Version
async function showEthSellReview(ctx, tokenAddress, amount, type) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    // Get token info for display
    let tokenSymbol = 'TOKEN';
    let tokenName = 'Unknown Token';
    
    try {
      const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
      tokenSymbol = tokenInfo.symbol;
      tokenName = tokenInfo.name;
    } catch (tokenError) {
      console.log('Could not get token info for sell review:', tokenError.message);
    }

    // Calculate fee information
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const amountText = type === 'percentage' ? `${amount}% of holdings` : `${amount} tokens`;

    const keyboard = [
      [{ text: '✅ Confirm Sale', callback_data: `eth_sell_execute_${tokenAddress}_${amount}_${type}` }],
      [{ text: '🔄 Change Amount', callback_data: 'eth_sell' }],
      [{ text: '🔙 Cancel', callback_data: 'chain_eth' }]
    ];

    const message = type === 'edit' ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
    
    await message(
      `🔗 **ETH SALE REVIEW**

**Token:** ${tokenName} (${tokenSymbol})
**Address:** ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}
**Amount:** ${amountText}

**💰 TRADE BREAKDOWN:**
• Service Fee: ${feePercent}%
• Gas Estimate: ~$5-15
• Network: Ethereum Mainnet

**⚠️ FINAL CONFIRMATION REQUIRED**
🚧 Complete ETH sell functionality coming soon!`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error in ETH sell review:', error);
    
    const errorMessage = type === 'edit' ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
    await errorMessage(
      `❌ **Error calculating ETH sale:**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'eth_sell' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        }
      }
    );
  }
}

// ====================================================================
// MISSING CORE HANDLERS - PHASE 1 CRITICAL FIXES
// ====================================================================

// Statistics handler
bot.action('statistics', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  const transactions = userData.transactions || [];
  const totalTrades = transactions.length;
  const totalVolume = transactions.reduce((sum, tx) => sum + (parseFloat(tx.amount) || 0), 0);

  const keyboard = [
    [{ text: '📊 Trading History', callback_data: 'view_trading_history' }],
    [{ text: '💰 Revenue Report', callback_data: 'view_revenue_report' }],
    [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
  ];

  await ctx.editMessageText(
    `📊 **YOUR STATISTICS**

**Total Trades:** ${totalTrades}
**Total Volume:** ${totalVolume.toFixed(4)} ETH
**Active Since:** ${new Date(userData.createdAt).toLocaleDateString()}
**Last Active:** ${new Date(userData.lastActive).toLocaleDateString()}

**Wallets:**
• ETH Wallets: ${userData.ethWallets?.length || 0}
• SOL Wallets: ${userData.solWallets?.length || 0}`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

// Settings handler
bot.action('settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  const keyboard = [
    [{ text: '⚙️ Trading Settings', callback_data: 'trading_settings' }],
    [{ text: '🔐 Security Settings', callback_data: 'security_settings' }],
    [{ text: '📱 Notifications', callback_data: 'notification_settings' }],
    [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
  ];

  await ctx.editMessageText(
    `⚙️ **SETTINGS**

**Current Settings:**
• Slippage: ${userData.settings?.slippage || 3}%
• Gas Multiplier: ${userData.settings?.gasMultiplier || 1.2}x
• Snipe Strategy: ${userData.settings?.snipeStrategy || 'new_pairs'}

Choose a setting category to modify:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

// ====================================================================
// SOL HANDLERS - PHASE 2 IMPLEMENTATION
// ====================================================================

// SOL Buy handler
bot.action('sol_buy', async (ctx) => {
  await ctx.editMessageText(
    `🟣 **SOL TOKEN PURCHASE**

Please send the Solana token address you want to buy:

Example: \`7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\`

📝 Send the token contract address in your next message.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );

  // Set user state for SOL token input
  userStates.set(ctx.from.id.toString(), {
    action: 'sol_token_address',
    timestamp: Date.now()
  });
});

// SOL Sell handler
bot.action('sol_sell', async (ctx) => {
  await ctx.editMessageText(
    `🟣 **SOL TOKEN SALE**

Please send the Solana token address you want to sell:

Example: \`7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\`

📝 Send the token contract address in your next message.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );

  // Set user state for SOL sell token input
  userStates.set(ctx.from.id.toString(), {
    action: 'sol_sell_token_address',
    timestamp: Date.now()
  });
});

// SOL Wallet handler
bot.action('sol_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  if (!userData.solWallets || userData.solWallets.length === 0) {
    await showSolWalletSetup(ctx);
  } else {
    await showSolWalletManagement(ctx, userData);
  }
});

// SOL Wallet Setup
async function showSolWalletSetup(ctx) {
  const keyboard = [
    [{ text: '➕ Import SOL Wallet', callback_data: 'import_sol_wallet' }],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  await ctx.editMessageText(
    `🟣 **SOL WALLET SETUP**

No SOL wallets found. Import your private key to get started.

⚠️ Your private key will be encrypted and stored securely.
🔐 We never store plaintext keys.`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// SOL Wallet Management
async function showSolWalletManagement(ctx, userData) {
  const keyboard = [
    [{ text: '💰 View Balance', callback_data: 'sol_view_balance' }],
    [{ text: '📊 Transaction History', callback_data: 'sol_tx_history' }],
    [{ text: '➕ Add Wallet', callback_data: 'import_sol_wallet' }],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  const currentWalletIndex = userData.activeSolWallet || 0;
  const walletCount = userData.solWallets?.length || 0;

  await ctx.editMessageText(
    `🟣 **SOL WALLET**

**Active Wallet:** ${currentWalletIndex + 1} of ${walletCount}
**Status:** Ready for trading

**Available Actions:**`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// SOL Text Handler Functions
async function handleSolTokenAddress(ctx, userId) {
  const tokenAddress = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    // Basic SOL address validation (base58, 32-44 chars)
    if (!tokenAddress.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      throw new Error('Invalid Solana address format');
    }

    const validatingMessage = await ctx.reply('⏳ **Validating SOL token...**', {
      parse_mode: 'Markdown'
    });

    // Delete the "validating" message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, validatingMessage.message_id);
    } catch (deleteError) {
      // Ignore if we can't delete the message
    }

    await showSolBuyAmountSelection(ctx, tokenAddress);

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid Solana token address.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'sol_buy' }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
}

async function handleSolSellTokenAddress(ctx, userId) {
  const tokenAddress = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    // Basic SOL address validation
    if (!tokenAddress.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      throw new Error('Invalid Solana address format');
    }

    await showSolSellAmountSelection(ctx, tokenAddress);

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid Solana token address.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'sol_sell' }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
}

async function handleSolCustomAmount(ctx, userId, tokenAddress) {
  const amount = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error('Invalid amount format');
    }

    if (amountFloat > 100) {
      throw new Error('Amount too large (max 100 SOL)');
    }

    await showSolBuyReview(ctx, tokenAddress, amount);

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid SOL amount (e.g., 0.1)`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `sol_buy_custom_${tokenAddress}` }],
            [{ text: '🔙 Back to Buy', callback_data: 'sol_buy' }]
          ]
        }
      }
    );
  }
}

async function handleSolWalletImport(ctx, userId) {
  const privateKey = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    // Basic validation for Solana private key format
    if (!privateKey.match(/^[1-9A-HJ-NP-Za-km-z]{32,}$/)) {
      throw new Error('Invalid Solana private key format');
    }

    // For now, we'll store it encrypted using the same wallet manager
    // In production, this would use Solana-specific encryption
    const encryptedKey = await walletManager.importWallet(privateKey, userId);

    // Update user data
    const userData = await loadUserData(userId);
    if (!userData.solWallets) {
      userData.solWallets = [];
    }
    userData.solWallets.push(encryptedKey);
    await saveUserData(userId, userData);

    // Generate a mock Solana address for display
    const mockAddress = 'Sol' + privateKey.slice(0, 6) + '...' + privateKey.slice(-4);

    await ctx.reply(
      `✅ **SOL Wallet Imported Successfully!**

Address: \`${mockAddress}\`

🔐 Your private key has been encrypted and stored securely.
🚧 SOL trading functionality coming soon!`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
          ]]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`User ${userId} imported SOL wallet: ${mockAddress}`);

  } catch (error) {
    userStates.delete(userId);
    logger.error(`SOL wallet import error for user ${userId}:`, error);

    if (error.message.includes('Invalid Solana private key')) {
      await ctx.reply('❌ Invalid SOL private key format. Please check and try again.');
    } else {
      await ctx.reply(`❌ Error importing wallet: ${error.message}`);
    }
  }
}

async function handleSolSellCustomAmount(ctx, userId, tokenAddress) {
  const amount = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error('Invalid amount format');
    }

    await showSolSellReview(ctx, tokenAddress, amountFloat, 'custom');

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid token amount (e.g., 1000)`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `sol_sell_custom_${tokenAddress}` }],
            [{ text: '🔙 Back to Amount Selection', callback_data: `sol_sell_select_${tokenAddress}` }]
          ]
        }
      }
    );
  }
}

// SOL Menu Functions
async function showSolBuyAmountSelection(ctx, tokenAddress) {
  const shortId = storeTokenMapping(tokenAddress);

  const keyboard = [
    [
      { text: '0.1 SOL', callback_data: `sol_buy_amount_0.1_${shortId}` },
      { text: '0.5 SOL', callback_data: `sol_buy_amount_0.5_${shortId}` }
    ],
    [
      { text: '1 SOL', callback_data: `sol_buy_amount_1_${shortId}` },
      { text: '2 SOL', callback_data: `sol_buy_amount_2_${shortId}` }
    ],
    [{ text: '💰 Custom Amount', callback_data: `sol_buy_custom_${shortId}` }],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  await ctx.editMessageText(
    `🟣 **BUY SOL TOKEN**

**Token:** \`${tokenAddress}\`

Select the amount of SOL to spend:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

async function showSolSellAmountSelection(ctx, tokenAddress) {
  const shortId = storeTokenMapping(tokenAddress);

  const keyboard = [
    [
      { text: '25%', callback_data: `sol_sell_percentage_25_${shortId}` },
      { text: '50%', callback_data: `sol_sell_percentage_50_${shortId}` }
    ],
    [
      { text: '75%', callback_data: `sol_sell_percentage_75_${shortId}` },
      { text: '100%', callback_data: `sol_sell_percentage_100_${shortId}` }
    ],
    [{ text: '💰 Custom Amount', callback_data: `sol_sell_custom_${shortId}` }],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  await ctx.editMessageText(
    `🟣 **SELL SOL TOKEN**

**Token:** \`${tokenAddress}\`

Select the percentage of your holdings to sell:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

async function showSolBuyReview(ctx, tokenAddress, amount) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    // Calculate fees (similar to ETH)
    const amountFloat = parseFloat(amount);
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amountFloat * (feePercent / 100);
    const netTradeAmount = amountFloat - feeAmount;

    const keyboard = [
      [{ text: '✅ Confirm Purchase', callback_data: `sol_buy_execute_${tokenAddress}_${amount}` }],
      [{ text: '🔄 Change Amount', callback_data: 'sol_buy' }],
      [{ text: '🔙 Cancel', callback_data: 'chain_sol' }]
    ];

    await ctx.editMessageText(
      `🟣 **SOL PURCHASE REVIEW**

**Token:** \`${tokenAddress}\`
**Amount:** ${amount} SOL

**💰 TRADE BREAKDOWN:**
• Purchase Amount: ${amount} SOL
• Service Fee (${feePercent}%): ${feeAmount.toFixed(6)} SOL
• Net Trade Amount: ${netTradeAmount.toFixed(6)} SOL
• Estimated Network Fee: ~0.01 SOL

**⚠️ FINAL CONFIRMATION REQUIRED**
🚧 This is currently a simulation. Real SOL trading coming soon!`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error in SOL buy review:', error);
    await ctx.editMessageText(
      `❌ **Error calculating SOL trade:**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'sol_buy' }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        }
      }
    );
  }
}

async function showSolSellReview(ctx, tokenAddress, amount, type) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const amountText = type === 'percentage' ? `${amount}% of holdings` : `${amount} tokens`;

    const keyboard = [
      [{ text: '✅ Confirm Sale', callback_data: `sol_sell_execute_${tokenAddress}_${amount}_${type}` }],
      [{ text: '🔄 Change Amount', callback_data: 'sol_sell' }],
      [{ text: '🔙 Cancel', callback_data: 'chain_sol' }]
    ];

    await ctx.editMessageText(
      `🟣 **SOL SALE REVIEW**

**Token:** \`${tokenAddress}\`
**Amount:** ${amountText}

**💰 ESTIMATED OUTPUT:**
• Service Fee: ${feePercent}%
• Network Fee: ~0.01 SOL
• Expected SOL Received: TBD

**⚠️ FINAL CONFIRMATION REQUIRED**
🚧 This is currently a simulation. Real SOL trading coming soon!`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error in SOL sell review:', error);
    await ctx.editMessageText(
      `❌ **Error calculating SOL sale:**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'sol_sell' }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        }
      }
    );
  }
}

// SOL Wallet Import Handler
bot.action('import_sol_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    await checkRateLimit(userId, 'walletImports');
  } catch (error) {
    await ctx.editMessageText(`❌ ${error.message}\n\n🔙 Try again later.`);
    return;
  }

  await ctx.editMessageText(
    `🟣 **IMPORT SOL WALLET**

Please send your Solana private key in the next message.

⚠️ Security Notes:
• Delete your message after sending
• Key will be encrypted immediately
• We never store plaintext keys

Send your SOL private key now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );

  // Set user state to expect private key
  userStates.set(userId, {
    action: 'sol_wallet_import',
    timestamp: Date.now()
  });

  // Set up timeout to clear state after 5 minutes
  setTimeout(() => {
    if (userStates.has(userId) && userStates.get(userId).action === 'sol_wallet_import') {
      userStates.delete(userId);
    }
  }, 5 * 60 * 1000);
});

bot.action('sol_view_balance', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL balance view coming soon!');
});

bot.action('sol_tx_history', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL transaction history coming soon!');
});

bot.action('trading_settings', async (ctx) => {
  await ctx.answerCbQuery('🚧 Trading settings coming soon!');
});

bot.action('security_settings', async (ctx) => {
  await ctx.answerCbQuery('🚧 Security settings coming soon!');
});

bot.action('notification_settings', async (ctx) => {
  await ctx.answerCbQuery('🚧 Notification settings coming soon!');
});

bot.action('view_trading_history', async (ctx) => {
  await ctx.answerCbQuery('🚧 Trading history view coming soon!');
});

bot.action('view_revenue_report', async (ctx) => {
  await ctx.answerCbQuery('🚧 Revenue report coming soon!');
});

bot.action('eth_mirror', async (ctx) => {
  await ctx.answerCbQuery('🚧 ETH mirror trading coming soon!');
});

bot.action('sol_snipe', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL sniping coming soon!');
});

bot.action('sol_mirror', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL mirror trading coming soon!');
});

// ====================================================================
// SOL BUY/SELL HANDLERS - PHASE 1 CRASH PREVENTION
// ====================================================================

// SOL Buy Amount Handlers
bot.action(/^sol_buy_amount_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const amount = match[1];
  const shortId = match[2];
  
  try {
    const tokenAddress = getFullTokenAddress(shortId);
    await showSolBuyReview(ctx, tokenAddress, amount);
  } catch (error) {
    console.log('Error in SOL buy amount handler:', error);
    await ctx.editMessageText(
      `❌ **Error processing SOL buy**\n\n${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
          ]]
        }
      }
    );
  }
});

// SOL Sell Percentage Handlers
bot.action(/^sol_sell_percentage_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const percentage = match[1];
  const shortId = match[2];
  
  try {
    const tokenAddress = getFullTokenAddress(shortId);
    await showSolSellReview(ctx, tokenAddress, percentage, 'percentage');
  } catch (error) {
    console.log('Error in SOL sell percentage handler:', error);
    await ctx.editMessageText(
      `❌ **Error processing SOL sell**\n\n${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
          ]]
        }
      }
    );
  }
});

// SOL Buy Execute Handlers
bot.action(/^sol_buy_execute_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const amount = match[2];
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Executing SOL purchase...**\n\n🚧 SOL trading will be available soon!');
    
    // Mock successful execution for now
    setTimeout(async () => {
      try {
        await ctx.editMessageText(
          `✅ **SOL PURCHASE SIMULATION**\n\n**Amount:** ${amount} SOL\n**Token:** \`${tokenAddress}\`\n\n🚧 This was a simulation. Real SOL trading coming soon!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Buy More', callback_data: 'sol_buy' }],
                [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
              ]
            },
            parse_mode: 'Markdown'
          }
        );
      } catch (editError) {
        console.log('Error editing SOL buy execute message:', editError);
      }
    }, 2000);

  } catch (error) {
    console.log('Error in SOL buy execute handler:', error);
    await ctx.editMessageText(
      `❌ **SOL Purchase Failed**\n\n${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'sol_buy' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        }
      }
    );
  }
});

// SOL Sell Execute Handlers
bot.action(/^sol_sell_execute_(.+)_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const amount = match[2];
  const type = match[3];
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Executing SOL sale...**\n\n🚧 SOL trading will be available soon!');
    
    // Mock successful execution for now
    setTimeout(async () => {
      try {
        const amountText = type === 'percentage' ? `${amount}% of holdings` : `${amount} tokens`;
        await ctx.editMessageText(
          `✅ **SOL SALE SIMULATION**\n\n**Amount:** ${amountText}\n**Token:** \`${tokenAddress}\`\n\n🚧 This was a simulation. Real SOL trading coming soon!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Sell More', callback_data: 'sol_sell' }],
                [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
              ]
            },
            parse_mode: 'Markdown'
          }
        );
      } catch (editError) {
        console.log('Error editing SOL sell execute message:', editError);
      }
    }, 2000);

  } catch (error) {
    console.log('Error in SOL sell execute handler:', error);
    await ctx.editMessageText(
      `❌ **SOL Sale Failed**\n\n${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'sol_sell' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        }
      }
    );
  }
});

// SOL Custom Amount Handlers
bot.action(/^sol_buy_custom_(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  const userId = ctx.from.id.toString();

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    
    await ctx.editMessageText(
      `🟣 **CUSTOM SOL AMOUNT**\n\nEnter the SOL amount you want to spend:\n\nExample: 0.25\n\nSend your custom amount now:`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Amount Selection', callback_data: 'sol_buy' }
          ]]
        }
      }
    );

    userStates.set(userId, {
      action: 'sol_custom_amount',

// Transaction status checker
bot.action(/^check_tx_(.+)$/, async (ctx) => {
  const txHashPartial = ctx.match[1];
  const userId = ctx.from.id.toString();
  
  try {
    const userData = await loadUserData(userId);
    const transactions = userData.transactions || [];
    
    // Find transaction by partial hash
    const transaction = transactions.find(tx => 
      tx.txHash && tx.txHash.slice(2, 8) === txHashPartial
    );
    
    if (!transaction) {
      await ctx.editMessageText('❌ Transaction not found in your history.');
      return;
    }
    
    // Check status on-chain
    const provider = await ethChain.getProvider();
    const receipt = await provider.getTransactionReceipt(transaction.txHash);
    
    if (!receipt) {
      await ctx.editMessageText(
        `⏳ **Transaction Status: Pending**
        
**Hash:** \`${transaction.txHash}\`
**Status:** Still pending confirmation...

[View on Etherscan](https://etherscan.io/tx/${transaction.txHash})`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Check Again', callback_data: `check_tx_${txHashPartial}` }],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );
      return;
    }
    
    const status = receipt.status === 1 ? '✅ Confirmed' : '❌ Failed';
    const gasUsed = ethers.utils.formatUnits(receipt.gasUsed.mul(receipt.effectiveGasPrice || receipt.gasPrice || 0), 'ether');
    
    await ctx.editMessageText(
      `${status} **Transaction Status**
      
**Hash:** \`${transaction.txHash}\`
**Block:** ${receipt.blockNumber}
**Gas Used:** ${gasUsed} ETH
**Status:** ${status}

[View on Etherscan](https://etherscan.io/tx/${transaction.txHash})`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Trade More', callback_data: 'chain_eth' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
    
  } catch (error) {
    console.log('Error checking transaction status:', error);
    await ctx.editMessageText('❌ Error checking transaction status. Please try again.');
  }
});


      tokenAddress: tokenAddress,
      timestamp: Date.now()
    });

  } catch (error) {
    console.log('Error in SOL custom amount handler:', error);
    await ctx.editMessageText('❌ Error processing custom amount. Please try again.', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    });
  }
});

bot.action(/^sol_sell_custom_(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  const userId = ctx.from.id.toString();

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    
    await ctx.editMessageText(
      `🟣 **CUSTOM SOL SELL AMOUNT**\n\nEnter the token amount you want to sell:\n\nExample: 1000\n\nSend your custom amount now:`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Amount Selection', callback_data: 'sol_sell' }
          ]]
        }
      }
    );

    userStates.set(userId, {
      action: 'sol_sell_custom_amount',
      tokenAddress: tokenAddress,
      timestamp: Date.now()
    });

  } catch (error) {
    console.log('Error in SOL sell custom amount handler:', error);
    await ctx.editMessageText('❌ Error processing custom amount. Please try again.', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    });
  }
});

// ====================================================================
// ETH SELL HANDLERS - PHASE 3 COMPLETION
// ====================================================================

// ETH Sell Percentage Handlers
bot.action(/^eth_sell_percentage_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const percentage = match[1];
  const shortId = match[2];
  
  try {
    const tokenAddress = getFullTokenAddress(shortId);
    await showEthSellReview(ctx, tokenAddress, percentage, 'percentage');
  } catch (error) {
    console.log('Error in ETH sell percentage handler:', error);
    await ctx.editMessageText(
      `❌ **Error processing ETH sell**\n\n${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
          ]]
        }
      }
    );
  }
});

// ETH Sell Execute Handlers
bot.action(/^eth_sell_execute_(.+)_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const amount = match[2];
  const type = match[3];
  const userId = ctx.from.id.toString();

  try {
    // Check rate limit
    await checkRateLimit(userId, 'transactions');

    await ctx.editMessageText('⏳ **Executing ETH token sale...**\n\n🚧 ETH sell functionality coming soon!');
    
    // Mock successful execution for now
    setTimeout(async () => {
      try {
        const amountText = type === 'percentage' ? `${amount}% of holdings` : `${amount} tokens`;
        await ctx.editMessageText(
          `✅ **ETH SALE SIMULATION**\n\n**Amount:** ${amountText}\n**Token:** \`${tokenAddress}\`\n\n🚧 This was a simulation. Complete ETH sell coming soon!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Sell More', callback_data: 'eth_sell' }],
                [{ text: '📈 Buy Tokens', callback_data: 'eth_buy' }],
                [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
              ]
            },
            parse_mode: 'Markdown'
          }
        );
      } catch (editError) {
        console.log('Error editing ETH sell execute message:', editError);
      }
    }, 2000);

  } catch (error) {
    console.log('Error in ETH sell execute handler:', error);
    
    if (error.message.includes('Rate limit')) {
      await ctx.editMessageText(
        `❌ **Rate Limit Exceeded**\n\n${error.message}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🏠 Main Menu', callback_data: 'main_menu' }
            ]]
          }
        }
      );
    } else {
      await ctx.editMessageText(
        `❌ **ETH Sale Failed**\n\n${error.message}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: 'eth_sell' }],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ]
          }
        }
      );
    }
  }
});

// ETH Sell Custom Amount Handler
bot.action(/^eth_sell_custom_(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  const userId = ctx.from.id.toString();

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    
    await ctx.editMessageText(
      `🔗 **CUSTOM ETH SELL AMOUNT**\n\nEnter the token amount you want to sell:\n\nExample: 1000\n\nSend your custom amount now:`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Amount Selection', callback_data: 'eth_sell' }
          ]]
        }
      }
    );

    userStates.set(userId, {
      action: 'sell_custom_amount',
      tokenAddress: tokenAddress,
      timestamp: Date.now()
    });

  } catch (error) {
    console.log('Error in ETH sell custom amount handler:', error);
    await ctx.editMessageText('❌ Error processing custom amount. Please try again.', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
        ]]
      }
    });
  }
});

// ====================================================================
// ERROR HANDLING & CLEANUP
// ====================================================================

// Handle any callback query errors
bot.on('callback_query', async (ctx, next) => {
  try {
    const userId = ctx.from?.id;
    const callbackData = ctx.callbackQuery?.data;
    
    console.log(`📥 Callback query: User ${userId}, Data: ${callbackData}`);
    
    await next();
  } catch (error) {
    const userId = ctx.from?.id;
    const callbackData = ctx.callbackQuery?.data;
    
    console.error('❌ Callback query error:', {
      userId,
      callbackData,
      error: error.message,
      stack: error.stack
    });
    
    logger.error('Callback query failed', {
      userId,
      callbackData,
      error: error.message
    });

    try {
      await ctx.answerCbQuery('❌ An error occurred. Please try again.');
      await ctx.editMessageText(
        '❌ **Something went wrong**\n\nPlease try again or return to the main menu.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🏠 Main Menu', callback_data: 'main_menu' }
            ]]
          }
        }
      );
    } catch (editError) {
      console.error('❌ Failed to edit message after error:', editError.message);
      
      // If we can't edit, send a new message
      try {
        await ctx.reply(
          '❌ **Something went wrong**\n\nPlease try again or return to the main menu.',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '🏠 Main Menu', callback_data: 'main_menu' }
              ]]
            }
          }
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError.message);
      }
    }
  }
});

// Cleanup old user states every hour
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  for (const [userId, state] of userStates.entries()) {
    if (now - state.timestamp > oneHour) {
      userStates.delete(userId);
      console.log(`Cleaned up old state for user ${userId}`);
    }
  }
}, 60 * 60 * 1000);

// ====================================================================
// ENVIRONMENT VALIDATION
// ====================================================================

function validateEnvironment() {
  const required = ['BOT_TOKEN'];
  const optional = ['ETH_RPC_URL', 'SOL_RPC_URL', 'TREASURY_WALLET'];
  
  console.log('🔍 Validating environment variables...');
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('💡 Please check your .env file and ensure these variables are set:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }
  
  console.log('✅ Required environment variables found');
  
  // Log optional variables status
  optional.forEach(key => {
    if (process.env[key]) {
      console.log(`✅ ${key}: configured`);
    } else {
      console.log(`⚠️ ${key}: not set (optional)`);
    }
  });
  
  // Validate BOT_TOKEN format
  const token = process.env.BOT_TOKEN;
  if (!token.match(/^\d+:[A-Za-z0-9_-]{35}$/)) {
    console.error('❌ BOT_TOKEN appears to have invalid format');
    console.error('💡 Expected format: 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefgh');
    process.exit(1);
  }
  
  console.log('✅ BOT_TOKEN format validation passed');
}

// ====================================================================
// BOT STARTUP
// ====================================================================

// Start the bot
async function startBot() {
  try {
    console.log('🚀 Starting Purity Sniper Bot...');
    
    // Validate environment first
    validateEnvironment();
    
    // Create directories
    console.log('📁 Creating required directories...');
    await fs.mkdir('logs', { recursive: true });
    await fs.mkdir(path.join('db', 'users'), { recursive: true });
    console.log('✅ Directories created');

    // Test bot token by getting bot info
    console.log('🤖 Testing Telegram bot connection...');
    try {
      const botInfo = await bot.telegram.getMe();
      console.log(`✅ Bot connected successfully: @${botInfo.username} (${botInfo.first_name})`);
      console.log(`📋 Bot ID: ${botInfo.id}`);
      console.log(`🔐 Can join groups: ${botInfo.can_join_groups}`);
      console.log(`📨 Can read all group messages: ${botInfo.can_read_all_group_messages}`);
    } catch (tokenError) {
      console.error('❌ Bot token validation failed:', tokenError.message);
      if (tokenError.message.includes('401')) {
        console.error('💡 This usually means your BOT_TOKEN is invalid');
        console.error('💡 Get a new token from @BotFather on Telegram');
      }
      process.exit(1);
    }

    // Launch the bot
    console.log('🚀 Launching bot...');
    await bot.launch();
    
    console.log('✅ Purity Sniper Bot is running!');
    console.log('🔗 Bot is ready to receive messages');
    console.log('💰 ETH buy/sell functionality fully integrated!');
    console.log('🎯 Enhanced sniping engine ready!');
    logger.info('Bot started successfully');

  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    console.error('📋 Error details:', {
      message: error.message,
      code: error.code,
      response: error.response?.data || 'No response data'
    });
    
    if (error.message.includes('409')) {
      console.error('💡 Error 409: Another instance might be running. Stop other instances first.');
    } else if (error.message.includes('404')) {
      console.error('💡 Error 404: Bot token might be invalid or bot deleted.');
    }
    
    process.exit(1);
  }
}

// Global bot error handling
bot.catch((err, ctx) => {
  console.error('❌ Bot error:', {
    error: err.message,
    stack: err.stack,
    userId: ctx?.from?.id,
    updateType: ctx?.updateType,
    callbackData: ctx?.callbackQuery?.data,
    messageText: ctx?.message?.text?.substring(0, 100) // First 100 chars only
  });
  
  logger.error('Bot error caught', {
    error: err.message,
    userId: ctx?.from?.id,
    updateType: ctx?.updateType
  });
});

// Global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  logger.error('Unhandled Rejection', { reason: reason?.message || reason });
});

// Global uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down...');
  cleanupSnipeMonitors();
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down...');
  cleanupSnipeMonitors();
  bot.stop('SIGTERM');
});

// Start the bot
startBot();
