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

// Enhanced loadUserData function with snipe config
const originalLoadUserData = loadUserData;

// Override loadUserData to include snipe configuration
async function loadUserData(userId) {
  const userData = await originalLoadUserData(userId);

  // Add snipe configuration if it doesn't exist
  if (!userData.snipeConfig) {
    userData.snipeConfig = { ...defaultSnipeConfig };
    console.log(`🎯 Added default snipe config for user ${userId}`);
  }

  return userData;
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

// Helper function to validate snipe configuration
function validateSnipeConfig(config) {
  const errors = [];

  if (config.amount <= 0 || config.amount > 10) {
    errors.push('Amount must be between 0.001 and 10 ETH');
  }

  if (config.slippage < 1 || config.slippage > 50) {
    errors.push('Slippage must be between 1% and 50%');
  }

  if (config.maxGasPrice < 20 || config.maxGasPrice > 500) {
    errors.push('Max gas price must be between 20 and 500 gwei');
  }

  if (!['new_pairs', 'first_liquidity', 'contract_methods'].includes(config.strategy)) {
    errors.push('Invalid strategy. Must be new_pairs, first_liquidity, or contract_methods');
  }

  return errors;
}

// Enhanced recordTransaction to include snipe tracking
const originalRecordTransaction = recordTransaction;

async function recordTransaction(userId, transactionData) {
  // Add snipe-specific metadata
  if (transactionData.type === 'snipe') {
    transactionData.autoExecuted = true;
    transactionData.snipeStrategy = transactionData.strategy || 'unknown';
    transactionData.snipeAttemptTime = Date.now();
  }

  return await originalRecordTransaction(userId, transactionData);
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
    return JSON.parse(data);
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
// GLOBAL TEXT HANDLER
// ====================================================================

// Global text handler that checks user states
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = userStates.get(userId);

  if (!userState) {
    return; // No active state for this user
  }

  console.log(`DEBUG: Processing text for user ${userId}, action: ${userState.action}`);

  // Handle different actions based on user state
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
      userStates.delete(userId); // Clear unknown state
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

// ETH Buy handler
bot.action('eth_buy', async (ctx) => {
  await ctx.editMessageText(
    `🔗 **ETH TOKEN PURCHASE**

Please send the Ethereum token address you want to buy:

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

  // Set user state for ETH token input
  userStates.set(ctx.from.id.toString(), {
    action: 'token_address',
    timestamp: Date.now()
  });
});

// ETH Sell handler
bot.action('eth_sell', async (ctx) => {
  await ctx.editMessageText(
    `🔗 **ETH TOKEN SALE**

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
  userStates.set(ctx.from.id.toString(), {
    action: 'sell_token_address',
    timestamp: Date.now()
  });
});

// ====================================================================
// MISSING UTILITY FUNCTIONS - PHASE 1 CRITICAL FIXES
// ====================================================================

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

// ETH Buy Amount Selection
async function showEthBuyAmount(ctx, tokenAddress, tokenInfo) {
  const shortId = storeTokenMapping(tokenAddress);

  const keyboard = [
    [
      { text: '0.1 ETH', callback_data: `eth_buy_amount_0.1_${shortId}` },
      { text: '0.5 ETH', callback_data: `eth_buy_amount_0.5_${shortId}` }
    ],
    [
      { text: '1 ETH', callback_data: `eth_buy_amount_1_${shortId}` },
      { text: '2 ETH', callback_data: `eth_buy_amount_2_${shortId}` }
    ],
    [{ text: '💰 Custom Amount', callback_data: `eth_buy_custom_${shortId}` }],
    [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
  ];

  await ctx.editMessageText(
    `🔗 **BUY ${tokenInfo?.symbol || 'TOKEN'}**

**Token:** ${tokenInfo?.name || 'Unknown Token'}
**Address:** \`${tokenAddress}\`

Select the amount of ETH to spend:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// ETH Buy Review
async function showEthBuyReviewReply(ctx, tokenAddress, amount) {
  const keyboard = [
    [{ text: '✅ Confirm Purchase', callback_data: `eth_buy_execute_${tokenAddress}_${amount}` }],
    [{ text: '🔙 Back to Amount Selection', callback_data: 'eth_buy' }]
  ];

  await ctx.editMessageText(
    `🔗 **CONFIRM ETH PURCHASE**

**Amount:** ${amount} ETH
**Token:** \`${tokenAddress}\`
**Estimated Gas:** ~$5-15

⚠️ **Warning:** This will execute immediately. Double-check the token address.

Ready to proceed?`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// ETH Sell Amount Selection
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

  await ctx.editMessageText(
    `🔗 **SELL TOKEN**

**Token:** \`${tokenAddress}\`

Select the percentage of your holdings to sell:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// ETH Sell Review
async function showEthSellReview(ctx, tokenAddress, amount, type) {
  const keyboard = [
    [{ text: '✅ Confirm Sale', callback_data: `eth_sell_execute_${tokenAddress}_${amount}_${type}` }],
    [{ text: '🔙 Back to Amount Selection', callback_data: `eth_sell_select_${tokenAddress}` }]
  ];

  await ctx.editMessageText(
    `🔗 **CONFIRM ETH SALE**

**Token:** \`${tokenAddress}\`
**Amount:** ${type === 'percentage' ? `${amount}% of holdings` : `${amount} tokens`}
**Estimated Gas:** ~$5-15

⚠️ **Warning:** This will execute immediately.

Ready to proceed?`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// ====================================================================
// SOL SNIPE AND MIRROR CONFIGURATION FUNCTIONS
// ====================================================================

// Show SOL Snipe Configuration
async function showSolSnipeConfiguration(ctx, userData) {
  const snipeConfig = userData.snipeConfig || defaultSnipeConfig;
  const stats = await getSnipeStatistics(ctx.from.id.toString());

  const keyboard = [
    [
      { text: snipeConfig.active ? '🟢 Active' : '🔴 Inactive', callback_data: 'sol_snipe_toggle' },
      { text: '⚙️ Configure', callback_data: 'sol_snipe_configure' }
    ],
    [
      { text: '🎯 Add Target', callback_data: 'sol_snipe_add_target' },
      { text: '📊 View Targets', callback_data: 'sol_snipe_view_targets' }
    ],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  await ctx.editMessageText(
    `🎯 **SOL SNIPE CONFIGURATION**

**Status:** ${snipeConfig.active ? '🟢 Active' : '🔴 Inactive'}
**Strategy:** ${getStrategyDisplayName(snipeConfig.strategy)}
**Amount:** ${snipeConfig.amount} SOL per snipe
**Max Fee:** ${snipeConfig.maxGasPrice} lamports

**Statistics (24h):**
📈 Attempts: ${stats.todayAttempts}
✅ Successful: ${stats.todaySuccessful}
📊 Success Rate: ${stats.successRate}%

**Target Tokens:** ${snipeConfig.targetTokens?.length || 0}`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// Show SOL Mirror Configuration
async function showSolMirrorConfiguration(ctx, userData) {
  const mirrorTargets = userData.mirrorTargets || [];

  const keyboard = [
    [
      { text: '➕ Add Wallet', callback_data: 'sol_mirror_add_wallet' },
      { text: '📊 View Targets', callback_data: 'sol_mirror_view_targets' }
    ],
    [
      { text: '⚙️ Settings', callback_data: 'sol_mirror_settings' },
      { text: '📈 Statistics', callback_data: 'sol_mirror_stats' }
    ],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  await ctx.editMessageText(
    `🪞 **SOL MIRROR TRADING**

Monitor and copy trades from successful Solana wallets.

**Active Mirrors:** ${mirrorTargets.length}
**Status:** ${mirrorTargets.length > 0 ? '🟢 Active' : '🔴 Inactive'}

**How it works:**
• Add SOL wallet addresses to monitor
• Bot copies their trades automatically
• Set copy percentage and filters
• Follow Jupiter aggregator trades`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// SOL Snipe placeholder handlers
bot.action('sol_snipe_toggle', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL sniping features coming soon!');
});

bot.action('sol_snipe_configure', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL snipe configuration coming soon!');
});

bot.action('sol_snipe_add_target', async (ctx) => {
  await ctx.answerCbQuery('🚧 Add SOL snipe targets coming soon!');
});

bot.action('sol_snipe_view_targets', async (ctx) => {
  await ctx.answerCbQuery('🚧 View SOL snipe targets coming soon!');
});

// SOL Mirror placeholder handlers
bot.action('sol_mirror_add_wallet', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL mirror trading coming soon!');
});

bot.action('sol_mirror_view_targets', async (ctx) => {
  await ctx.answerCbQuery('🚧 View SOL mirror targets coming soon!');
});

bot.action('sol_mirror_settings', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL mirror settings coming soon!');
});

bot.action('sol_mirror_stats', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL mirror statistics coming soon!');
});

// Additional placeholder handlers to prevent crashes
bot.action('import_sol_wallet', async (ctx) => {
  await ctx.answerCbQuery('🚧 SOL wallet import coming soon!');
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

// ====================================================================
// SOL BUY/SELL HANDLERS - PHASE 2 IMPLEMENTATION
// ====================================================================

// SOL Buy Amount Handlers
bot.action(/^sol_buy_amount_(.+)_(.+)$/, async (ctx) => {
  const amount = ctx.match[1];
  const shortId = ctx.match[2];

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    await showSolBuyReview(ctx, tokenAddress, amount);
  } catch (error) {
    await ctx.answerCbQuery('❌ Error loading buy review');
  }
});

// SOL Buy Custom Amount Handler
bot.action(/^sol_buy_custom_(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    await ctx.editMessageText(
      `🟣 **CUSTOM SOL AMOUNT**

**Token:** \`${tokenAddress}\`

Please send the amount of SOL you want to spend:

Example: \`0.5\` (for 0.5 SOL)`,
      { parse_mode: 'Markdown' }
    );

    // Set user state for custom amount input
    userStates.set(ctx.from.id.toString(), {
      action: 'sol_custom_amount',
      tokenAddress: tokenAddress,
      timestamp: Date.now()
    });

  } catch (error) {
    await ctx.answerCbQuery('❌ Error setting up custom amount');
  }
});

// SOL Buy Execute Handler
bot.action(/^sol_buy_execute_(.+)_(.+)$/, async (ctx) => {
  const tokenAddress = ctx.match[1];
  const amount = ctx.match[2];
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Executing SOL purchase...**', { parse_mode: 'Markdown' });

    const userData = await loadUserData(userId);

    if (!userData.solWallets || userData.solWallets.length === 0) {
      throw new Error('No SOL wallet found. Please import a wallet first.');
    }

    // Simulate SOL purchase execution (Phase 2 implementation)
    const executionResult = await executeSolBuy(userId, userData, tokenAddress, amount);

    if (executionResult.success) {
      await ctx.editMessageText(
        `✅ **SOL PURCHASE SUCCESSFUL!**

**Token:** \`${tokenAddress}\`
**Amount:** ${amount} SOL
**Transaction:** [View on Solscan](https://solscan.io/tx/${executionResult.signature})
**Fee:** ${executionResult.fee} SOL

🎉 Purchase completed successfully!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );

      // Record transaction
      await recordTransaction(userId, {
        type: 'buy',
        chain: 'solana',
        amount: amount,
        tokenAddress: tokenAddress,
        txHash: executionResult.signature,
        timestamp: Date.now(),
        fee: executionResult.fee,
        status: 'completed'
      });

    } else {
      throw new Error(executionResult.error || 'Purchase failed');
    }

  } catch (error) {
    await ctx.editMessageText(
      `❌ **SOL PURCHASE FAILED**

Error: ${error.message}

Please try again or contact support.`,
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
});

// SOL Sell Percentage Handlers
bot.action(/^sol_sell_percentage_(.+)_(.+)$/, async (ctx) => {
  const percentage = ctx.match[1];
  const shortId = ctx.match[2];

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    await showSolSellReview(ctx, tokenAddress, percentage, 'percentage');
  } catch (error) {
    await ctx.answerCbQuery('❌ Error loading sell review');
  }
});

// SOL Sell Custom Amount Handler
bot.action(/^sol_sell_custom_(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    await ctx.editMessageText(
      `🟣 **CUSTOM SOL SELL AMOUNT**

**Token:** \`${tokenAddress}\`

Please send the amount of tokens you want to sell:

Example: \`1000\` (for 1000 tokens)`,
      { parse_mode: 'Markdown' }
    );

    // Set user state for custom sell amount input
    userStates.set(ctx.from.id.toString(), {
      action: 'sol_sell_custom_amount',
      tokenAddress: tokenAddress,
      timestamp: Date.now()
    });

  } catch (error) {
    await ctx.answerCbQuery('❌ Error setting up custom sell amount');
  }
});

// SOL Sell Execute Handler
bot.action(/^sol_sell_execute_(.+)_(.+)_(.+)$/, async (ctx) => {
  const tokenAddress = ctx.match[1];
  const amount = ctx.match[2];
  const type = ctx.match[3];
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Executing SOL sale...**', { parse_mode: 'Markdown' });

    const userData = await loadUserData(userId);

    if (!userData.solWallets || userData.solWallets.length === 0) {
      throw new Error('No SOL wallet found. Please import a wallet first.');
    }

    // Simulate SOL sell execution (Phase 2 implementation)
    const executionResult = await executeSolSell(userId, userData, tokenAddress, amount, type);

    if (executionResult.success) {
      await ctx.editMessageText(
        `✅ **SOL SALE SUCCESSFUL!**

**Token:** \`${tokenAddress}\`
**Amount:** ${type === 'percentage' ? `${amount}% of holdings` : `${amount} tokens`}
**Received:** ${executionResult.receivedSOL} SOL
**Transaction:** [View on Solscan](https://solscan.io/tx/${executionResult.signature})
**Fee:** ${executionResult.fee} SOL

🎉 Sale completed successfully!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );

      // Record transaction
      await recordTransaction(userId, {
        type: 'sell',
        chain: 'solana',
        amount: amount,
        amountType: type,
        tokenAddress: tokenAddress,
        txHash: executionResult.signature,
        timestamp: Date.now(),
        fee: executionResult.fee,
        received: executionResult.receivedSOL,
        status: 'completed'
      });

    } else {
      throw new Error(executionResult.error || 'Sale failed');
    }

  } catch (error) {
    await ctx.editMessageText(
      `❌ **SOL SALE FAILED**

Error: ${error.message}

Please try again or contact support.`,
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
});

// ====================================================================
// ETH TRADING EXECUTION FUNCTIONS - PHASE 3 IMPLEMENTATION
// ====================================================================

// Execute ETH Buy Trade
async function executeEthBuy(userId, userData, tokenAddress, amount) {
  try {
    console.log(`🔗 Executing ETH buy: ${amount} ETH -> ${tokenAddress}`);

    // Get user's ETH wallet
    const wallet = await getWalletForTrading(userId, userData);

    // Check ETH balance
    const balance = await ethChain.getETHBalance(wallet.address);
    const requiredAmount = parseFloat(amount) + 0.01; // Add buffer for fees

    if (parseFloat(balance) < requiredAmount) {
      throw new Error(`Insufficient ETH balance. Required: ${requiredAmount} ETH, Available: ${balance} ETH`);
    }

    // Calculate fee (1.5% of purchase amount)
    const feeCalculation = ethChain.calculateFeeBreakdown(amount, 1.5);
    const netAmount = feeCalculation.netAmount;

    // Execute swap using Uniswap
    const swapResult = await ethChain.executeTokenSwap(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netAmount),
      wallet.privateKey,
      5 // 5% slippage for ETH trades
    );

    // Send fee to treasury
    const feeResult = await ethChain.collectFee(wallet.privateKey, feeCalculation.feeAmount);

    // Track revenue
    await trackRevenue(feeCalculation.feeAmount);

    console.log(`✅ ETH buy completed: ${swapResult.hash}`);

    return {
      success: true,
      hash: swapResult.hash,
      fee: feeCalculation.feeAmount,
      outputAmount: swapResult.outputAmount
    };

  } catch (error) {
    console.log(`❌ ETH buy failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// Execute ETH Sell Trade
async function executeEthSell(userId, userData, tokenAddress, amount, type) {
  try {
    console.log(`🔗 Executing ETH sell: ${amount} (${type}) ${tokenAddress} -> ETH`);

    // Get user's ETH wallet
    const wallet = await getWalletForTrading(userId, userData);

    // Get token holdings
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    if (tokenBalance.isZero()) {
      throw new Error('No tokens found in wallet to sell');
    }

    // Calculate sell amount
    let sellAmount;
    if (type === 'percentage') {
      const percentage = parseFloat(amount);
      sellAmount = ethChain.calculateSmartSellAmount(tokenBalance, percentage, tokenInfo.decimals);
    } else {
      sellAmount = ethers.utils.parseUnits(amount.toString(), tokenInfo.decimals);
    }

    if (sellAmount.gt(tokenBalance)) {
      throw new Error(`Insufficient token balance. Requested: ${amount}, Available: ${ethChain.formatTokenBalance(tokenBalance, tokenInfo.decimals)}`);
    }

    // Approve token for trading
    await ethChain.smartApproveToken(
      tokenAddress, 
      ethChain.contracts.UNISWAP_V2_ROUTER, 
      sellAmount, 
      wallet.privateKey
    );

    // Execute swap using Uniswap
    const swapResult = await ethChain.executeTokenSwap(
      tokenAddress,
      ethChain.contracts.WETH,
      sellAmount,
      wallet.privateKey,
      5 // 5% slippage for ETH trades
    );

    // Calculate fee (1.5% of received ETH)
    const receivedEth = ethers.utils.formatEther(swapResult.value || ethers.BigNumber.from(0));
    const feeCalculation = ethChain.calculateFeeBreakdown(receivedEth, 1.5);

    // Send fee to treasury
    const feeResult = await ethChain.collectFee(wallet.privateKey, feeCalculation.feeAmount);

    // Track revenue
    await trackRevenue(feeCalculation.feeAmount);

    console.log(`✅ ETH sell completed: ${swapResult.hash}`);

    return {
      success: true,
      hash: swapResult.hash,
      fee: feeCalculation.feeAmount,
      receivedETH: feeCalculation.netAmount
    };

  } catch (error) {
    console.log(`❌ ETH sell failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// ====================================================================
// SOL TRADING EXECUTION FUNCTIONS - PHASE 2 IMPLEMENTATION
// ====================================================================

// Import SOL Chain for trading operations
const SolChain = require('./chains/sol');
const solChain = new SolChain();

// Execute SOL Buy Trade
async function executeSolBuy(userId, userData, tokenAddress, amount) {
  try {
    console.log(`🟣 Executing SOL buy: ${amount} SOL -> ${tokenAddress}`);

    // Get user's SOL wallet
    const encryptedKey = userData.solWallets[userData.activeSolWallet || 0];
    if (!encryptedKey) {
      throw new Error('No SOL wallet available');
    }

    const privateKey = await walletManager.decryptPrivateKey(encryptedKey, userId);
    const wallet = solChain.createWalletFromPrivateKey(privateKey);

    // Check SOL balance
    const balance = await solChain.getBalance(wallet.publicKey.toString());
    const requiredAmount = parseFloat(amount) + 0.01; // Add buffer for fees

    if (parseFloat(balance) < requiredAmount) {
      throw new Error(`Insufficient SOL balance. Required: ${requiredAmount} SOL, Available: ${balance} SOL`);
    }

    // Calculate fee (1% of purchase amount)
    const feeCalculation = solChain.calculateFee(amount, 1.0);
    const netAmount = feeCalculation.netAmount;

    // Execute swap using Jupiter
    const swapResult = await solChain.executeSwap(
      wallet,
      'sol',
      tokenAddress,
      netAmount
    );

    // Send fee to treasury
    await solChain.sendFeeToTreasury(wallet, feeCalculation.feeAmount);

    // Track revenue
    await trackRevenue(feeCalculation.feeAmount);

    console.log(`✅ SOL buy completed: ${swapResult.signature}`);

    return {
      success: true,
      signature: swapResult.signature,
      fee: feeCalculation.feeAmount,
      outputAmount: swapResult.outputAmount
    };

  } catch (error) {
    console.log(`❌ SOL buy failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// Execute SOL Sell Trade
async function executeSolSell(userId, userData, tokenAddress, amount, type) {
  try {
    console.log(`🟣 Executing SOL sell: ${amount} (${type}) ${tokenAddress} -> SOL`);

    // Get user's SOL wallet
    const encryptedKey = userData.solWallets[userData.activeSolWallet || 0];
    if (!encryptedKey) {
      throw new Error('No SOL wallet available');
    }

    const privateKey = await walletManager.decryptPrivateKey(encryptedKey, userId);
    const wallet = solChain.createWalletFromPrivateKey(privateKey);

    // Get token holdings
    const holdings = await solChain.getTokenHoldings(wallet.publicKey.toString());
    const tokenHolding = holdings.find(h => h.mint === tokenAddress);

    if (!tokenHolding || tokenHolding.balance === 0) {
      throw new Error('No tokens found in wallet to sell');
    }

    // Calculate sell amount
    let sellAmount;
    if (type === 'percentage') {
      const percentage = parseFloat(amount) / 100;
      sellAmount = tokenHolding.balance * percentage;
    } else {
      sellAmount = parseFloat(amount);
    }

    if (sellAmount > tokenHolding.balance) {
      throw new Error(`Insufficient token balance. Requested: ${sellAmount}, Available: ${tokenHolding.balance}`);
    }

    // Execute swap using Jupiter
    const swapResult = await solChain.executeSwap(
      wallet,
      tokenAddress,
      'sol',
      sellAmount.toString()
    );

    // Calculate fee (1% of received SOL)
    const feeCalculation = solChain.calculateFee(swapResult.outputAmount, 1.0);

    // Send fee to treasury
    await solChain.sendFeeToTreasury(wallet, feeCalculation.feeAmount);

    // Track revenue
    await trackRevenue(feeCalculation.feeAmount);

    console.log(`✅ SOL sell completed: ${swapResult.signature}`);

    return {
      success: true,
      signature: swapResult.signature,
      fee: feeCalculation.feeAmount,
      receivedSOL: feeCalculation.netAmount
    };

  } catch (error) {
    console.log(`❌ SOL sell failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// ====================================================================
// SOL WALLET MANAGEMENT HANDLERS - PHASE 2 IMPLEMENTATION
// ====================================================================

// Import SOL wallet handler
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

Send your SOL private key now (base58 format):`
  );

  // Set user state to expect SOL private key
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

// SOL View balance handler
bot.action('sol_view_balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    if (!userData.solWallets || userData.solWallets.length === 0) {
      throw new Error('No SOL wallet found');
    }

    const encryptedKey = userData.solWallets[userData.activeSolWallet || 0];
    const address = await walletManager.getWalletAddress(encryptedKey, userId);
    const balance = await solChain.getBalance(address);

    await ctx.editMessageText(
      `💰 **SOL WALLET BALANCE**

**Address:** ${address}
**Balance:** ${balance} SOL

**Last Updated:** ${new Date().toLocaleString()}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'sol_view_balance' }],
            [{ text: '🔙 Back to Wallet', callback_data: 'sol_wallet' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    await ctx.editMessageText(
      `❌ **Error loading SOL balance**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Wallet', callback_data: 'sol_wallet' }
          ]]
        }
      }
    );
  }
});

// SOL Transaction history handler
bot.action('sol_tx_history', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    const transactions = userData.transactions || [];
    const solTransactions = transactions.filter(tx => tx.chain === 'solana').slice(-10);

    if (solTransactions.length === 0) {
      await ctx.editMessageText(
        `📊 **SOL TRANSACTION HISTORY**

No SOL transactions found yet.

Start trading to see your transaction history here!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Start Trading', callback_data: 'chain_sol' }],
              [{ text: '🔙 Back to Wallet', callback_data: 'sol_wallet' }]
            ]
          }
        }
      );
      return;
    }

    let historyText = `📊 **SOL TRANSACTION HISTORY**\n\n**Last ${solTransactions.length} SOL Transactions:**\n\n`;

    solTransactions.reverse().forEach((tx, index) => {
      const date = new Date(tx.timestamp).toLocaleDateString();
      const type = tx.type.toUpperCase();
      const amount = parseFloat(tx.amount).toFixed(6);

      historyText += `**${index + 1}.** ${type} - ${amount} SOL\n`;
      historyText += `📅 ${date} | 🔗 [View](https://solscan.io/tx/${tx.txHash})\n\n`;
    });

    await ctx.editMessageText(historyText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'sol_tx_history' }],
          [{ text: '🔙 Back to Wallet', callback_data: 'sol_wallet' }]
        ]
      },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    await ctx.editMessageText(
      `❌ **Error loading SOL transaction history**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Wallet', callback_data: 'sol_wallet' }
          ]]
        }
      }
    );
  }
});

// ====================================================================
// SOL TEXT HANDLER ADDITIONS - PHASE 2 IMPLEMENTATION
// ====================================================================

// Handle SOL wallet import in text handler
async function handleSolWalletImport(ctx, userId) {
  const privateKey = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    // Validate Solana private key (base58 format)
    if (!privateKey.match(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/)) {
      throw new Error('Invalid Solana private key format (should be base58)');
    }

    const encryptedKey = await walletManager.importWallet(privateKey, userId);

    // Update user data
    const userData = await loadUserData(userId);
    if (!userData.solWallets) {
      userData.solWallets = [];
    }
    userData.solWallets.push(encryptedKey);
    userData.activeSolWallet = userData.solWallets.length - 1;
    await saveUserData(userId, userData);

    // Get wallet address for confirmation
    const wallet = solChain.createWalletFromPrivateKey(privateKey);
    const address = wallet.publicKey.toString();

    await ctx.reply(
      `✅ **SOL Wallet Imported Successfully!**

Address: \`${address}\`

🔐 Your private key has been encrypted and stored securely.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
          ]]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`User ${userId} imported SOL wallet: ${address}`);

  } catch (error) {
    userStates.delete(userId);
    logger.error(`SOL wallet import error for user ${userId}:`, error);

    if (error.message.includes('Invalid Solana private key')) {
      await ctx.reply('❌ Invalid SOL private key format. Please send a valid base58 private key.');
    } else {
      await ctx.reply(`❌ Error importing SOL wallet: ${error.message}`);
    }
  }
}

// Handle SOL sell custom amount in text handler
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

// Catch-all handler for dynamic callbacks that aren't implemented yet
bot.action(/^(eth_buy_amount_|eth_sell_percentage_)/, async (ctx) => {
  await ctx.answerCbQuery('🚧 ETH trading execution coming in Phase 3!');
});

bot.action(/^(eth_buy_execute_|eth_sell_execute_)/, async (ctx) => {
  await ctx.answerCbQuery('🚧 ETH trading execution coming in Phase 3!');
});

// ====================================================================
// SOL TEXT HANDLER FUNCTIONS - PHASE 1 CRITICAL FIXES
// ====================================================================

// SOL Token address handler
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

// SOL Sell token address handler
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

// SOL Custom amount handler
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

// SOL Buy Amount Selection
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

// SOL Sell Amount Selection
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

// SOL Buy Review
async function showSolBuyReview(ctx, tokenAddress, amount) {
  const keyboard = [
    [{ text: '✅ Confirm Purchase', callback_data: `sol_buy_execute_${tokenAddress}_${amount}` }],
    [{ text: '🔙 Back to Amount Selection', callback_data: 'sol_buy' }]
  ];

  await ctx.editMessageText(
    `🟣 **CONFIRM SOL PURCHASE**

**Amount:** ${amount} SOL
**Token:** \`${tokenAddress}\`
**Estimated Fee:** ~0.01 SOL

⚠️ **Warning:** This will execute immediately. Double-check the token address.

Ready to proceed?`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// SOL Sell Review
async function showSolSellReview(ctx, tokenAddress, amount, type) {
  const keyboard = [
    [{ text: '✅ Confirm Sale', callback_data: `sol_sell_execute_${tokenAddress}_${amount}_${type}` }],
    [{ text: '🔙 Back to Amount Selection', callback_data: `sol_sell_select_${tokenAddress}` }]
  ];

  await ctx.editMessageText(
    `🟣 **CONFIRM SOL SALE**

**Token:** \`${tokenAddress}\`
**Amount:** ${type === 'percentage' ? `${amount}% of holdings` : `${amount} tokens`}
**Estimated Fee:** ~0.01 SOL

⚠️ **Warning:** This will execute immediately.

Ready to proceed?`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
}

// ====================================================================
// MISSING SOL BUY/SELL CALLBACK HANDLERS - CRITICAL FOR SOL OPERATION
// ====================================================================

// ====================================================================
// ERROR HANDLING & CLEANUP
// ====================================================================

// Handle any callback query errors
bot.on('callback_query', async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    console.log('Callback query error:', error);

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
      // If we can't edit, send a new message
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
// BOT STARTUP
// ====================================================================

// Start the bot
async function startBot() {
  try {
    // Create directories
    await fs.mkdir('logs', { recursive: true });
    await fs.mkdir(path.join('db', 'users'), { recursive: true });

    await bot.launch();
    console.log('✅ Purity Sniper Bot is running!');
    logger.info('Bot started successfully');

  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

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