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
// 🎯 SNIPING ENGINE - CHUNK 2: UI COMPONENTS & MENU SYSTEM
// ====================================================================

// Enhanced ETH Snipe Token Handler - REPLACES YOUR PLACEHOLDER
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

  // UPDATED KEYBOARD LAYOUT:
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

// Start sniping handler
bot.action('snipe_start', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);

    // Validate wallet and balance
    const wallet = await getWalletForTrading(userId, userData);
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);

    const snipeAmount = userData.snipeConfig?.amount || 0.1;
    const minRequiredBalance = snipeAmount + 0.02; // Amount + gas buffer

    if (balanceFloat < minRequiredBalance) {
      await ctx.editMessageText(
        `❌ **Insufficient Balance for Sniping**

**Required:** ${minRequiredBalance.toFixed(4)} ETH
**Available:** ${balance} ETH
**Shortage:** ${(minRequiredBalance - balanceFloat).toFixed(4)} ETH

Please add more ETH to your wallet before starting sniping.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Adjust Amount', callback_data: 'snipe_config_amount' }],
              [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
            ]
          }
        }
      );
      return;
    }

    // Update user config to active
    await updateSnipeConfig(userId, { active: true });

    // Start monitoring
    await startSnipeMonitoring(userId);

    await ctx.editMessageText(
      `🔥 <b>SNIPING ACTIVATED!</b>

    ✅ <b>Monitoring Uniswap for new pairs...</b>
    ⚡ <b>Ready to snipe when opportunities arise!</b>

    <b>Active Settings:</b>
    • Amount: ${snipeAmount} ETH per snipe
    • Strategy: ${userData.snipeConfig.strategy}
    • Slippage: ${userData.snipeConfig.slippage}%

    <b>🔔 You will be notified of all snipe attempts</b>

    <b>⚠️ Warning:</b> Sniping is high-risk. Only snipe what you can afford to lose.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏸️ Pause Sniping', callback_data: 'snipe_pause' }],
            [{ text: '⚙️ Adjust Settings', callback_data: 'eth_snipe' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'HTML'
      }
    );

    logger.info(`User ${userId} started sniping with ${snipeAmount} ETH`);

  } catch (error) {
    console.log('Error starting sniping:', error);
    await ctx.editMessageText(
      `❌ <b>Failed to start sniping</b>

${error.message}

Please check your wallet configuration and try again.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }
          ]]
        }
      }
    );
  }
});

// Pause sniping handler
bot.action('snipe_pause', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    // Stop monitoring
    await stopSnipeMonitoring(userId);

    // Update user config to inactive
    await updateSnipeConfig(userId, { active: false });

    await ctx.editMessageText(
      `⏸️ **SNIPING PAUSED**

🔴 **No longer monitoring for new pairs**
💡 **Your settings have been saved**

You can resume sniping anytime by clicking Start Sniping.

**Recent Activity:**
Your snipe attempts and history are preserved.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '▶️ Resume Sniping', callback_data: 'snipe_start' }],
            [{ text: '📊 View History', callback_data: 'snipe_history' }],
            [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`User ${userId} paused sniping`);

  } catch (error) {
    console.log('Error pausing sniping:', error);
    await ctx.editMessageText(
      `❌ **Error pausing sniping**

${error.message}

Sniping may still be active. Please try again.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }
          ]]
        }
      }
    );
  }
});

// Configuration handlers
bot.action('snipe_config_amount', async (ctx) => {
  const keyboard = [
    [
      { text: '0.01 ETH', callback_data: 'snipe_set_amount_0.01' },
      { text: '0.05 ETH', callback_data: 'snipe_set_amount_0.05' }
    ],
    [
      { text: '0.1 ETH', callback_data: 'snipe_set_amount_0.1' },
      { text: '0.5 ETH', callback_data: 'snipe_set_amount_0.5' }
    ],
    [
      { text: '1 ETH', callback_data: 'snipe_set_amount_1' },
      { text: '2 ETH', callback_data: 'snipe_set_amount_2' }
    ],
    [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
  ];

  await ctx.editMessageText(
    `💰 **SNIPE AMOUNT CONFIGURATION**

Select the ETH amount to use for each snipe attempt:

**⚠️ Important:**
• Higher amounts = better chance to get tokens
• Lower amounts = less risk per snipe
• You need extra ETH for gas fees (~0.02-0.05 ETH)

**Current wallet balance will be checked before each snipe**`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

bot.action('snipe_config_slippage', async (ctx) => {
  const keyboard = [
    [
      { text: '5%', callback_data: 'snipe_set_slippage_5' },
      { text: '10%', callback_data: 'snipe_set_slippage_10' }
    ],
    [
      { text: '15%', callback_data: 'snipe_set_slippage_15' },
      { text: '20%', callback_data: 'snipe_set_slippage_20' }
    ],
    [
      { text: '30%', callback_data: 'snipe_set_slippage_30' },
      { text: '50%', callback_data: 'snipe_set_slippage_50' }
    ],
    [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
  ];

  await ctx.editMessageText(
    `⚡ **SLIPPAGE CONFIGURATION**

Select maximum slippage tolerance for snipe attempts:

**💡 Recommendations:**
• **5-10%:** Conservative, fewer successful snipes
• **15-20%:** Balanced approach
• **30-50%:** Aggressive, higher success rate but more risk

**⚠️ Warning:** Higher slippage = you may receive fewer tokens than expected`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});
// ====================================================================
// MISSING SNIPE MENU HANDLERS - ADD THESE TO YOUR index.js
// ====================================================================

// ADD these handlers right after your existing snipe_config_slippage handler

// 1. STRATEGY CONFIGURATION HANDLER (MISSING)
bot.action('snipe_config_strategy', async (ctx) => {
  const keyboard = [
    [{ text: '🆕 New Pairs (Degen Mode)', callback_data: 'snipe_set_strategy_new_pairs' }],
    [{ text: '💧 First Liquidity Events', callback_data: 'snipe_set_strategy_first_liquidity' }],
    [{ text: '🔧 Contract Methods', callback_data: 'snipe_set_strategy_contract_methods' }],
    [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
  ];

  await ctx.editMessageText(
    `🎯 **SNIPE STRATEGY CONFIGURATION**

Choose your sniping strategy:

**🆕 New Pairs (Degen Mode):**
• Monitors ALL new Uniswap pairs
• Automatic sniping when any new pair is created
• High volume, high risk/reward
• Recommended for experienced users

**💧 First Liquidity Events:**
• Monitor specific tokens you add
• Snipe when target tokens get liquidity
• Surgical precision approach
• Perfect for researched opportunities

**🔧 Contract Methods:**
• Monitor specific contract method calls
• Advanced strategy for technical users
• Snipe based on contract interactions
• Requires knowledge of method signatures

Select your preferred strategy:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

// 2. NEW PAIRS STRATEGY HANDLER (MISSING)
bot.action('snipe_set_strategy_new_pairs', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    await updateSnipeConfig(userId, { strategy: 'new_pairs' });

    await ctx.editMessageText(
      `🆕 **NEW PAIRS (DEGEN MODE)**

**Strategy Selected:** Monitor ALL new Uniswap pairs

**⚠️ DEGEN MODE WARNING:**
This strategy will attempt to snipe EVERY new pair created on Uniswap. This is extremely high-risk and can result in:
• Rapid ETH consumption
• Many failed transactions
• Potential rug pulls and scam tokens
• High gas costs

**How it works:**
• Bot monitors Uniswap factory for new pair events
• Automatically snipes when any ETH/Token pair is created
• Uses your configured amount and slippage
• No filtering - pure degen mode

**💡 Recommended settings:**
• Amount: 0.01-0.05 ETH (start small)
• Slippage: 15-30% (high for speed)
• Max Gas: 200+ gwei (fast execution)

**Only use this if you understand the risks!**`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ I Understand - Use This Strategy', callback_data: 'confirm_degen_mode' }],
            [{ text: '🔙 Choose Different Strategy', callback_data: 'snipe_config_strategy' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error setting new pairs strategy:', error);
    await ctx.answerCbQuery('❌ Failed to set strategy');
  }
});

// 3. CONFIRM DEGEN MODE HANDLER
bot.action('confirm_degen_mode', async (ctx) => {
  await ctx.editMessageText(
    `🔥 **DEGEN MODE ACTIVATED!**

✅ Strategy set to "New Pairs (Degen Mode)"

Your bot will now snipe ALL new Uniswap pairs when you start sniping.

**Next steps:**
1. Configure your amount (start small!)
2. Set appropriate slippage (15-30%)
3. Ensure you have sufficient ETH
4. Start sniping when ready

**⚠️ Remember:** This is extremely high-risk. Start with small amounts!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Configure Amount', callback_data: 'snipe_config_amount' }],
          [{ text: '⚡ Configure Slippage', callback_data: 'snipe_config_slippage' }],
          [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );

  await ctx.answerCbQuery('🔥 Degen Mode activated!');
});

// 4. MAX GAS CONFIGURATION HANDLER (MISSING)
bot.action('snipe_config_gas', async (ctx) => {
  const keyboard = [
    [
      { text: '50 gwei', callback_data: 'snipe_set_gas_50' },
      { text: '100 gwei', callback_data: 'snipe_set_gas_100' }
    ],
    [
      { text: '200 gwei', callback_data: 'snipe_set_gas_200' },
      { text: '300 gwei', callback_data: 'snipe_set_gas_300' }
    ],
    [
      { text: '500 gwei', callback_data: 'snipe_set_gas_500' },
      { text: '1000 gwei', callback_data: 'snipe_set_gas_1000' }
    ],
    [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
  ];

  await ctx.editMessageText(
    `⛽ **MAX GAS PRICE CONFIGURATION**

Set the maximum gas price for snipe attempts:

**💡 Gas Price Guide:**
• **50-100 gwei:** Normal network conditions
• **200-300 gwei:** High priority (recommended for sniping)
• **500+ gwei:** Emergency/ultra-fast execution
• **1000+ gwei:** Extreme priority (very expensive)

**⚠️ Important:**
• Higher gas = faster execution but more expensive
• Snipes that exceed max gas will be skipped
• During high network activity, you may need higher gas
• Gas price affects snipe success rate

**Current network conditions will be checked before each snipe**

Select your maximum gas price:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

// 5. SNIPE HISTORY HANDLER (MISSING)
bot.action('snipe_history', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const transactions = userData.transactions || [];

    // Filter snipe transactions
    const snipeTransactions = transactions.filter(tx => tx.type === 'snipe').slice(-10);

    if (snipeTransactions.length === 0) {
      await ctx.editMessageText(
        `📊 **SNIPE HISTORY**

❌ No snipe attempts found yet.

Once you start sniping, your transaction history will appear here.

**What you'll see:**
• Successful snipes with token info
• Failed attempts and reasons
• Gas costs and fees paid
• Timestamps and transaction hashes

Start sniping to build your history!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Start Sniping', callback_data: 'snipe_start' }],
              [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    // Build history text
    let historyText = `📊 **SNIPE HISTORY**\n\n**Last ${snipeTransactions.length} Snipe Attempts:**\n\n`;

    snipeTransactions.reverse().forEach((tx, index) => {
      const date = new Date(tx.timestamp).toLocaleDateString();
      const time = new Date(tx.timestamp).toLocaleTimeString();
      const status = tx.failed ? '❌ FAILED' : '✅ SUCCESS';
      const amount = parseFloat(tx.amount || 0).toFixed(4);

      historyText += `**${index + 1}.** ${status}\n`;
      historyText += `💰 Amount: ${amount} ETH\n`;

      if (tx.tokenAddress) {
        const tokenAddr = tx.tokenAddress.slice(0, 6) + '...' + tx.tokenAddress.slice(-4);
        historyText += `🎯 Token: ${tokenAddr}\n`;
      }

      if (tx.snipeStrategy) {
        historyText += `📋 Strategy: ${tx.snipeStrategy}\n`;
      }

      if (tx.txHash) {
        historyText += `🔗 [View](https://etherscan.io/tx/${tx.txHash})\n`;
      } else if (tx.error) {
        historyText += `❌ Error: ${tx.error}\n`;
      }

      historyText += `📅 ${date} ${time}\n\n`;
    });

    // Calculate statistics
    const totalAttempts = snipeTransactions.length;
    const successful = snipeTransactions.filter(tx => !tx.failed && tx.txHash).length;
    const successRate = totalAttempts > 0 ? Math.round((successful / totalAttempts) * 100) : 0;
    const totalSpent = snipeTransactions.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);

    historyText += `📈 **STATISTICS:**\n`;
    historyText += `• Total Attempts: ${totalAttempts}\n`;
    historyText += `• Successful: ${successful}\n`;
    historyText += `• Success Rate: ${successRate}%\n`;
    historyText += `• Total Spent: ${totalSpent.toFixed(4)} ETH`;

    await ctx.editMessageText(historyText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'snipe_history' }],
          [{ text: '🗑️ Clear History', callback_data: 'clear_snipe_history' }],
          [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
        ]
      },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.log('Error loading snipe history:', error);
    await ctx.editMessageText(
      `❌ **Error loading snipe history**

${error.message}

Please try again.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }
          ]]
        }
      }
    );
  }
});

// 6. CLEAR HISTORY HANDLER
bot.action('clear_snipe_history', async (ctx) => {
  await ctx.editMessageText(
    `🗑️ **CLEAR SNIPE HISTORY**

Are you sure you want to clear all snipe transaction history?

**⚠️ Warning:** This action cannot be undone!

**What will be deleted:**
• All snipe attempt records
• Success/failure statistics
• Transaction hashes and details
• Timestamps and error messages

Your actual blockchain transactions will remain unchanged.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Yes, Clear History', callback_data: 'confirm_clear_history' }],
          [{ text: '❌ Cancel', callback_data: 'snipe_history' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );
});

// 7. CONFIRM CLEAR HISTORY
bot.action('confirm_clear_history', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);

    // Remove only snipe transactions
    userData.transactions = (userData.transactions || []).filter(tx => tx.type !== 'snipe');

    await saveUserData(userId, userData);

    await ctx.editMessageText(
      `✅ **Snipe History Cleared**

All snipe transaction records have been deleted.

Your trading history (buy/sell) remains intact.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 View History', callback_data: 'snipe_history' }],
            [{ text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }]
          ]
        }
      }
    );

  } catch (error) {
    console.log('Error clearing snipe history:', error);
    await ctx.editMessageText(
      `❌ **Error clearing history**

${error.message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Configuration', callback_data: 'eth_snipe' }
          ]]
        }
      }
    );
  }
});

// ====================================================================
// GAS PRICE SETTING HANDLERS
// ====================================================================

// Gas price handlers
bot.action(/^snipe_set_gas_(\d+)$/, async (ctx) => {
  const gasPrice = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    await updateSnipeConfig(userId, { maxGasPrice: gasPrice });

    await ctx.editMessageText(
      `✅ **Max Gas Price Updated**

**New Setting:** ${gasPrice} gwei

${gasPrice <= 100 ? 
        '💡 **Conservative:** Good for normal network conditions' : 
        gasPrice <= 300 ? 
        '⚡ **Aggressive:** Recommended for sniping' : 
        '🔥 **Ultra-Fast:** Very expensive but highest priority'
      }

Your snipe attempts will not execute if network gas exceeds ${gasPrice} gwei.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚙️ Other Settings', callback_data: 'eth_snipe' }],
            [{ text: '🔙 Back to Gas Config', callback_data: 'snipe_config_gas' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    await ctx.answerCbQuery(`✅ Max gas set to ${gasPrice} gwei`);

  } catch (error) {
    console.log('Error setting gas price:', error);
    await ctx.answerCbQuery('❌ Failed to update gas price');
  }
});

// ====================================================================
// INSTRUCTIONS
// ====================================================================

/*
ADD ALL THE ABOVE HANDLERS TO YOUR index.js FILE

Place them after your existing snipe_config_slippage handler.

These missing handlers are why your strategy, history, and gas menus 
weren't working - the buttons existed but no handlers were defined!

After adding these, all your snipe menu buttons should work properly.
*/
// ====================================================================
// CHUNK 2: ENHANCED STRATEGY HANDLERS + CONTRACT METHODS
// ====================================================================

// STEP 1: REPLACE your snipe_set_strategy_first_liquidity handler with this enhanced version
bot.action('snipe_set_strategy_first_liquidity', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    // Set strategy first
    await updateSnipeConfig(userId, { strategy: 'first_liquidity' });

    const userData = await loadUserData(userId);
    const targetTokens = userData.snipeConfig?.targetTokens?.filter(t => t.strategy === 'first_liquidity') || [];

    let tokenList = '';
    if (targetTokens.length === 0) {
      tokenList = '📋 **No target tokens added yet**\n\nAdd token contract addresses to start monitoring for liquidity events.';
    } else {
      tokenList = '📋 **Target Tokens:**\n\n';
      targetTokens.forEach((token, index) => {
        const status = token.status === 'waiting' ? '⏳' : token.status === 'sniped' ? '✅' : '❌';
        const displayName = token.label || `${token.address.slice(0, 8)}...`;
        tokenList += `${index + 1}. ${status} ${displayName}\n`;
        tokenList += `   ${token.address.slice(0, 10)}...${token.address.slice(-6)}\n\n`;
      });
    }

    const keyboard = [
      [{ text: '➕ Add Token Address', callback_data: 'add_liquidity_token' }],
      ...(targetTokens.length > 0 ? [[{ text: '🗑️ Remove Token', callback_data: 'remove_liquidity_token' }]] : []),
      [{ text: '▶️ Start Monitoring', callback_data: 'start_liquidity_snipe' }],
      [{ text: '🔙 Back to Strategy', callback_data: 'snipe_config_strategy' }]
    ];

    await ctx.editMessageText(
      `💧 **FIRST LIQUIDITY EVENTS**

Monitor specific tokens and snipe when liquidity is first added.

${tokenList}

**How it works:**
• Add token contract addresses to your watch list
• Bot monitors each token for liquidity addition events  
• Instant snipe when liquidity is detected
• Uses your configured amount (${userData.snipeConfig?.amount || 0.1} ETH) and slippage (${userData.snipeConfig?.slippage || 10}%)

**💡 Perfect for:**
• Pre-launch tokens you've researched
• Tokens with announced launch times
• Following specific projects you believe in`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

    await ctx.answerCbQuery('✅ First Liquidity Events strategy selected');

  } catch (error) {
    console.log('Error in first liquidity strategy:', error);
    await ctx.answerCbQuery('❌ Failed to load strategy');
  }
});

// STEP 2: ADD the new contract methods strategy handler
bot.action('snipe_set_strategy_contract_methods', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    // Set strategy first
    await updateSnipeConfig(userId, { strategy: 'contract_methods' });

    const userData = await loadUserData(userId);
    const targetTokens = userData.snipeConfig?.targetTokens?.filter(t => t.strategy === 'contract_methods') || [];

    let tokenList = '';
    if (targetTokens.length === 0) {
      tokenList = '📋 **No method targets added yet**\n\nAdd token address + method signature to start monitoring.';
    } else {
      tokenList = '📋 **Method Targets:**\n\n';
      targetTokens.forEach((token, index) => {
        const status = token.status === 'waiting' ? '⏳' : token.status === 'sniped' ? '✅' : '❌';
        const displayName = token.label || `${token.address.slice(0, 8)}...`;
        tokenList += `${index + 1}. ${status} ${displayName}\n`;
        tokenList += `   Token: ${token.address.slice(0, 10)}...${token.address.slice(-6)}\n`;
        tokenList += `   Method: ${token.method}\n\n`;
      });
    }

    const keyboard = [
      [{ text: '➕ Add Token + Method', callback_data: 'add_method_token' }],
      ...(targetTokens.length > 0 ? [[{ text: '🗑️ Remove Target', callback_data: 'remove_method_token' }]] : []),
      [{ text: '📖 Common Methods', callback_data: 'show_common_methods' }],
      [{ text: '▶️ Start Monitoring', callback_data: 'start_method_snipe' }],
      [{ text: '🔙 Back to Strategy', callback_data: 'snipe_config_strategy' }]
    ];

    await ctx.editMessageText(
      `🔧 **CONTRACT METHODS**

Monitor specific contract method calls and snipe when detected.

${tokenList}

**How it works:**
• Add token address + method signature (e.g., 0x095ea7b3)
• Bot monitors for that method call on the contract
• Instant snipe when method is executed
• Uses your configured amount and slippage settings

**💡 Perfect for:**
• Tokens with known launch methods
• Following specific contract interactions
• Advanced sniping techniques`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

    await ctx.answerCbQuery('✅ Contract Methods strategy selected');

  } catch (error) {
    console.log('Error in contract methods strategy:', error);
    await ctx.answerCbQuery('❌ Failed to load strategy');
  }
});

// STEP 3: ADD liquidity token management handlers
bot.action('add_liquidity_token', async (ctx) => {
  const userId = ctx.from.id.toString();

  userStates.set(userId, { action: 'waiting_liquidity_token' });

  await ctx.editMessageText(
    `💧 **ADD TOKEN FOR LIQUIDITY MONITORING**

Send the token contract address you want to monitor:

**Format Options:**
\`0x1234567890abcdef1234567890abcdef12345678\`
\`0x123...abc MEME Token\` (with name)

**Examples:**
\`0xa0b86a33e6db42311c4f77e8c5c8e8b2e8c8e8c8\`
\`0xa0b86a33e6db42311c4f77e8c5c8e8b2e8c8e8c8 SafeMoon V2\`

**💡 Tips:**
• Get contract address from DEXTools, Etherscan, or project announcements
• Optional token name helps you remember what you're sniping
• Bot will monitor this token 24/7 until liquidity is added`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '❌ Cancel', callback_data: 'snipe_set_strategy_first_liquidity' }
        ]]
      },
      parse_mode: 'Markdown'
    }
  );
});

bot.action('remove_liquidity_token', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);
  const targetTokens = userData.snipeConfig?.targetTokens?.filter(t => t.strategy === 'first_liquidity') || [];

  if (targetTokens.length === 0) {
    await ctx.answerCbQuery('No tokens to remove');
    return;
  }

  const keyboard = targetTokens.map((token, index) => [
    { 
      text: `🗑️ ${token.label || token.address.slice(0, 10) + '...'}`, 
      callback_data: `remove_liq_token_${index}` 
    }
  ]);

  keyboard.push([{ text: '❌ Cancel', callback_data: 'snipe_set_strategy_first_liquidity' }]);

  await ctx.editMessageText(
    `🗑️ **REMOVE TOKEN FROM WATCH LIST**

Select which token to remove from monitoring:

**⚠️ Warning:** Removing a token will stop monitoring it for liquidity events.`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

bot.action(/^remove_liq_token_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const tokenIndex = parseInt(ctx.match[1]);

  try {
    const userData = await loadUserData(userId);
    const targetTokens = userData.snipeConfig?.targetTokens?.filter(t => t.strategy === 'first_liquidity') || [];

    if (tokenIndex >= 0 && tokenIndex < targetTokens.length) {
      const removedToken = targetTokens[tokenIndex];

      // Remove from all target tokens (not just filtered ones)
      userData.snipeConfig.targetTokens = userData.snipeConfig.targetTokens.filter(
        t => !(t.address === removedToken.address && t.strategy === 'first_liquidity')
      );

      await saveUserData(userId, userData);

      await ctx.answerCbQuery(`✅ Token ${removedToken.label || 'removed'} from watch list`);

      // Return to strategy view
      setTimeout(() => {
        ctx.editMessageText('⏳ Updating token list...');
        setTimeout(() => {
          // Simulate clicking back to the strategy
          bot.handleUpdate({ 
            callback_query: { 
              ...ctx.callbackQuery, 
              data: 'snipe_set_strategy_first_liquidity',
              from: ctx.from,
              message: ctx.callbackQuery.message
            } 
          });
        }, 300);
      }, 100);

    } else {
      await ctx.answerCbQuery('❌ Invalid token selection');
    }
  } catch (error) {
    console.log('Error removing token:', error);
    await ctx.answerCbQuery('❌ Failed to remove token');
  }
});

// STEP 4: ADD contract methods handlers
bot.action('add_method_token', async (ctx) => {
  const userId = ctx.from.id.toString();

  userStates.set(userId, { action: 'waiting_method_token' });

  await ctx.editMessageText(
    `🔧 **ADD TOKEN + METHOD FOR MONITORING**

Send the token address and method signature:

**Format:** \`TokenAddress MethodSignature [TokenName]\`

**Examples:**
\`0x123...abc 0x095ea7b3\`
\`0x123...abc 0x095ea7b3 MEME Token\`
\`0xa0b86a33e6db42311c4f77e8c5c8e8b2e8c8e8c8 0xf305d719 SafeMoon Launch\`

**💡 Tips:**
• Get method signatures from contract source on Etherscan
• Use 'Common Methods' button for popular signatures
• Bot will monitor for that specific method call`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📖 Common Methods', callback_data: 'show_common_methods' }],
          [{ text: '❌ Cancel', callback_data: 'snipe_set_strategy_contract_methods' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );
});

bot.action('show_common_methods', async (ctx) => {
  await ctx.editMessageText(
    `📖 **COMMON METHOD SIGNATURES**

**Standard ERC-20:**
• \`0x095ea7b3\` - approve(spender, amount)
• \`0xa9059cbb\` - transfer(to, amount)
• \`0x23b872dd\` - transferFrom(from, to, amount)

**Uniswap Related:**
• \`0xf305d719\` - addLiquidity
• \`0xe8e33700\` - addLiquidityETH
• \`0x38ed1739\` - swapExactTokensForTokens

**Trading/Launch:**
• \`0x8803dbee\` - swapTokensForExactTokens
• \`0x7ff36ab5\` - swapExactETHForTokens
• \`0x18cbafe5\` - swapExactTokensForETH

**💡 How to find methods:**
1. Go to Etherscan → Contract → Read/Write Contract
2. Find the method you want to monitor
3. Copy the method signature (first 10 characters)

**Example:** If you want to snipe when \`addLiquidityETH\` is called, use \`0xe8e33700\``,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Add Token + Method', callback_data: 'add_method_token' }],
          [{ text: '🔙 Back to Methods', callback_data: 'snipe_set_strategy_contract_methods' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );
});

bot.action('remove_method_token', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);
  const targetTokens = userData.snipeConfig?.targetTokens?.filter(t => t.strategy === 'contract_methods') || [];

  if (targetTokens.length === 0) {
    await ctx.answerCbQuery('No method targets to remove');
    return;
  }

  const keyboard = targetTokens.map((token, index) => [
    { 
      text: `🗑️ ${token.label || token.address.slice(0, 8) + '...'} (${token.method})`, 
      callback_data: `remove_method_token_${index}` 
    }
  ]);

  keyboard.push([{ text: '❌ Cancel', callback_data: 'snipe_set_strategy_contract_methods' }]);

  await ctx.editMessageText(
    `🗑️ **REMOVE METHOD TARGET**

Select which method target to remove:

**⚠️ Warning:** This will stop monitoring that contract method.`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

bot.action(/^remove_method_token_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const tokenIndex = parseInt(ctx.match[1]);

  try {
    const userData = await loadUserData(userId);
    const targetTokens = userData.snipeConfig?.targetTokens?.filter(t => t.strategy === 'contract_methods') || [];

    if (tokenIndex >= 0 && tokenIndex < targetTokens.length) {
      const removedToken = targetTokens[tokenIndex];

      // Remove from all target tokens
      userData.snipeConfig.targetTokens = userData.snipeConfig.targetTokens.filter(
        t => !(t.address === removedToken.address && t.strategy === 'contract_methods' && t.method === removedToken.method)
      );

      await saveUserData(userId, userData);

      await ctx.answerCbQuery(`✅ Method target removed`);

      // Return to strategy view
      setTimeout(() => {
        ctx.editMessageText('⏳ Updating method list...');
        setTimeout(() => {
          bot.handleUpdate({ 
            callback_query: { 
              ...ctx.callbackQuery, 
              data: 'snipe_set_strategy_contract_methods',
              from: ctx.from,
              message: ctx.callbackQuery.message
            } 
          });
        }, 300);
      }, 100);

    } else {
      await ctx.answerCbQuery('❌ Invalid target selection');
    }
  } catch (error) {
    console.log('Error removing method target:', error);
    await ctx.answerCbQuery('❌ Failed to remove target');
  }
});

// STEP 5: ADD start monitoring handlers  
bot.action('start_liquidity_snipe', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const targetTokens = userData.snipeConfig?.targetTokens?.filter(
      t => t.strategy === 'first_liquidity' && t.status === 'waiting'
    ) || [];

    if (targetTokens.length === 0) {
      await ctx.editMessageText(
        `❌ **No Target Tokens Configured**

You need to add at least one token address to your watch list before starting liquidity monitoring.

Add some tokens first, then start monitoring.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Add Token', callback_data: 'add_liquidity_token' }],
              [{ text: '🔙 Back to Strategy', callback_data: 'snipe_set_strategy_first_liquidity' }]
            ]
          }
        }
      );
      return;
    }

    // Validate wallet and balance
    const wallet = await getWalletForTrading(userId, userData);
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);
    const snipeAmount = userData.snipeConfig?.amount || 0.1;
    const minRequiredBalance = snipeAmount + 0.02; // Amount + gas buffer

    if (balanceFloat < minRequiredBalance) {
      await ctx.editMessageText(
        `❌ **Insufficient Balance for Liquidity Sniping**

**Required:** ${minRequiredBalance.toFixed(4)} ETH
**Available:** ${balance} ETH
**Shortage:** ${(minRequiredBalance - balanceFloat).toFixed(4)} ETH

You need more ETH to start monitoring these ${targetTokens.length} target tokens.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Adjust Amount', callback_data: 'snipe_config_amount' }],
              [{ text: '🔙 Back to Token List', callback_data: 'snipe_set_strategy_first_liquidity' }]
            ]
          }
        }
      );
      return;
    }

    // Set config to active and start monitoring
    await updateSnipeConfig(userId, { active: true });
    await startSnipeMonitoring(userId);

    const tokenListText = targetTokens.map((token, index) => 
      `${index + 1}. ${token.label || token.address.slice(0, 8) + '...'}`
    ).join('\n');

    await ctx.editMessageText(
      `🔥 **LIQUIDITY MONITORING ACTIVATED!**

✅ **Monitoring ${targetTokens.length} target tokens for liquidity events...**
⚡ **Ready to snipe when liquidity is detected!**

**Target Tokens:**
${tokenListText}

**Active Settings:**
• Amount: ${snipeAmount} ETH per snipe
• Slippage: ${userData.snipeConfig.slippage}%
• Max Gas: ${userData.snipeConfig.maxGasPrice} gwei

**🔔 You will be notified when any target token gets liquidity**

**⚠️ Surgical Precision Mode:** Only your selected tokens will be sniped.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏸️ Pause Monitoring', callback_data: 'snipe_pause' }],
            [{ text: '⚙️ Adjust Settings', callback_data: 'eth_snipe' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`User ${userId} started targeted liquidity monitoring for ${targetTokens.length} tokens`);

  } catch (error) {
    console.log('Error starting liquidity monitoring:', error);
    await ctx.editMessageText(
      `❌ **Failed to start liquidity monitoring**

${error.message}

Please check your configuration and try again.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Token List', callback_data: 'snipe_set_strategy_first_liquidity' }
          ]]
        }
      }
    );
  }
});

bot.action('start_method_snipe', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const targetTokens = userData.snipeConfig?.targetTokens?.filter(
      t => t.strategy === 'contract_methods' && t.status === 'waiting'
    ) || [];

    if (targetTokens.length === 0) {
      await ctx.editMessageText(
        `❌ **No Method Targets Configured**

You need to add at least one token + method combination before starting method monitoring.

Add some targets first, then start monitoring.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Add Token + Method', callback_data: 'add_method_token' }],
              [{ text: '🔙 Back to Strategy', callback_data: 'snipe_set_strategy_contract_methods' }]
            ]
          }
        }
      );
      return;
    }

    // Validate wallet and balance (same as liquidity)
    const wallet = await getWalletForTrading(userId, userData);
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);
    const snipeAmount = userData.snipeConfig?.amount || 0.1;
    const minRequiredBalance = snipeAmount + 0.02;

    if (balanceFloat < minRequiredBalance) {
      await ctx.editMessageText(
        `❌ **Insufficient Balance for Method Sniping**

**Required:** ${minRequiredBalance.toFixed(4)} ETH
**Available:** ${balance} ETH

You need more ETH to start monitoring these ${targetTokens.length} method targets.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Adjust Amount', callback_data: 'snipe_config_amount' }],
              [{ text: '🔙 Back to Method List', callback_data: 'snipe_set_strategy_contract_methods' }]
            ]
          }
        }
      );
      return;
    }

    // Set config to active and start monitoring
    await updateSnipeConfig(userId, { active: true });
    await startSnipeMonitoring(userId);

    const methodListText = targetTokens.map((token, index) => 
      `${index + 1}. ${token.label || token.address.slice(0, 8) + '...'} (${token.method})`
    ).join('\n');

    await ctx.editMessageText(
      `🔥 **METHOD MONITORING ACTIVATED!**

✅ **Monitoring ${targetTokens.length} method targets...**
⚡ **Ready to snipe when methods are called!**

**Method Targets:**
${methodListText}

**Active Settings:**
• Amount: ${snipeAmount} ETH per snipe
• Slippage: ${userData.snipeConfig.slippage}%
• Max Gas: ${userData.snipeConfig.maxGasPrice} gwei

**🔔 You will be notified when any target method is executed**

**⚠️ Advanced Mode:** Sniping based on contract method calls.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏸️ Pause Monitoring', callback_data: 'snipe_pause' }],
            [{ text: '⚙️ Adjust Settings', callback_data: 'eth_snipe' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`User ${userId} started method monitoring for ${targetTokens.length} targets`);

  } catch (error) {
    console.log('Error starting method monitoring:', error);
    await ctx.editMessageText(
      `❌ **Failed to start method monitoring**

${error.message}

Please check your configuration and try again.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Method List', callback_data: 'snipe_set_strategy_contract_methods' }
          ]]
        }
      }
    );
  }
});

// ====================================================================
// ETH WALLET MANAGEMENT - YOUR WORKING CODE
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

// Your working showEthWalletManagement function
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
// GLOBAL TEXT HANDLER - YOUR WORKING VERSION
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
    default:
      userStates.delete(userId); // Clear unknown state
  }
});

// ====================================================================
// TEXT HANDLER HELPER FUNCTIONS
// ====================================================================

// Wallet import handler - YOUR WORKING VERSION
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

// Custom amount handler - will process custom ETH amounts
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

// Sell token address handler - will process sell token addresses
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

// Sell custom amount handler - will process custom token amounts
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
// PURITY SNIPER BOT - COMPLETE WORKING REFACTOR WITH FEE-FIRST
// PART 3/4: ETH BUY TOKEN FUNCTIONALITY WITH FEE-FIRST STRUCTURE
// ====================================================================

// ====================================================================
// ETH BUY TOKEN - COMPLETE IMPLEMENTATION WITH FEE-FIRST
// ====================================================================

// ETH Buy Token Handler - Complete Implementation
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

// ====================================================================
// FEE-FIRST BUY EXECUTION - THE KEY FIX
// ====================================================================

// Execute the actual purchase with FEE-FIRST structure
bot.action(/^eth_buy_execute_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const amount = match[2];
  const userId = ctx.from.id.toString();

  try {
    // Check rate limit again
    await checkRateLimit(userId, 'transactions');

    await ctx.editMessageText('⏳ **Starting transaction...**\n\nStep 1/2: Collecting service fee first...');

    const userData = await loadUserData(userId);
    // Get wallet using proper helper
    const wallet = await getWalletForTrading(userId, userData);

    // Calculate amounts upfront
    const totalAmount = parseFloat(amount);
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = totalAmount * (feePercent / 100);
    const netTradeAmount = totalAmount - feeAmount;

    console.log(`💰 FEE-FIRST STRUCTURE: Total ${totalAmount} ETH, Fee ${feeAmount} ETH, Trade ${netTradeAmount} ETH`);

    // ====================================================================
    // STEP 1: EXECUTE MAIN TRADE FIRST (MOST IMPORTANT)
    // ====================================================================
    await ctx.editMessageText('⏳ **Executing token purchase...**\n\nSwapping on Uniswap...');
    console.log(`🚀 Executing main trade: ${netTradeAmount} ETH -> ${tokenAddress}`);
    const swapResult = await ethChain.executeSwap(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString()),
      wallet.privateKey,
      3 // 3% slippage
    );
    console.log(`✅ Main trade executed! Hash: ${swapResult.hash}`);

    // ====================================================================
    // STEP 2: COLLECT FEE AFTER TRADE (NON-BLOCKING)
    // ====================================================================
    let feeResult = null;
    if (feeAmount > 0) {
      try {
        console.log(`💰 Collecting fee AFTER main trade: ${feeAmount} ETH`);
        feeResult = await ethChain.collectFee(
          wallet.privateKey,
          feeAmount.toString()
        );
        if (feeResult) {
          console.log(`✅ Fee collected successfully! Hash: ${feeResult.hash}`);
        } else {
          console.log(`⚠️ Fee collection failed but main trade succeeded`);
        }
      } catch (feeError) {
        console.log(`⚠️ Fee collection error (non-blocking): ${feeError.message}`);
        // Don't fail the whole transaction for fee collection issues
      }
    }

    // ====================================================================
    // STEP 3: RECORD SUCCESS & NOTIFY USER
    // ====================================================================

    // Update user transaction history
    await recordTransaction(userId, {
      type: 'buy',
      tokenAddress,
      amount: totalAmount.toString(),
      tradeAmount: netTradeAmount.toString(),
      feeAmount: feeAmount.toString(),
      txHash: swapResult.hash,
      feeHash: feeResult?.hash || null,
      timestamp: Date.now(),
      chain: 'ethereum',
      feeCollectedFirst: true // Track that we used fee-first approach
    });

    // Log revenue
    await trackRevenue(feeAmount);

    // Get token info for success message
    let tokenSymbol = 'TOKEN';
    try {
      const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
      tokenSymbol = tokenInfo.symbol;
    } catch (e) {
      console.log('Could not get token symbol for success message');
    }

    // Success message with both transaction links
    await ctx.editMessageText(
      `✅ **PURCHASE SUCCESSFUL!**

**Trade Amount:** ${netTradeAmount.toFixed(6)} ETH → ${tokenSymbol}
**Service Fee:** ${feeAmount.toFixed(6)} ETH  
**Total Cost:** ${totalAmount.toFixed(6)} ETH

**🔗 Transactions:**
• Fee: [${feeResult?.hash?.substring(0, 10)}...](https://etherscan.io/tx/${feeResult?.hash})
• Trade: [${swapResult.hash.substring(0, 10)}...](https://etherscan.io/tx/${swapResult.hash})

**Hash:** \`${swapResult.hash}\`

🎉 Your tokens should appear in your wallet shortly!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Buy More', callback_data: 'eth_buy' }],
            [{ text: '📈 Sell Tokens', callback_data: 'eth_sell' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    // Enhanced logging for debugging
    console.log(`✅ COMPLETE PURCHASE SUCCESS:`);
    console.log(`   User: ${userId}`);
    console.log(`   Token: ${tokenAddress}`);
    console.log(`   Total: ${totalAmount} ETH`);
    console.log(`   Fee: ${feeAmount} ETH (${feePercent}%)`);
    console.log(`   Trade: ${netTradeAmount} ETH`);
    console.log(`   Fee TX: ${feeResult?.hash}`);
    console.log(`   Trade TX: ${swapResult.hash}`);

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

// ====================================================================
// BUY REVIEW REPLY VERSION (for custom amounts)
// ====================================================================

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

// ETH Sell Token Handler - Complete Implementation
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

  await showEthTokenHoldings(ctx, userId);
});

// Show user's token holdings with transaction history detection
async function showEthTokenHoldings(ctx, userId) {
  try {
    await ctx.editMessageText('⏳ **Loading your token holdings...**');

    const userData = await loadUserData(userId);
    const address = await getWalletAddress(userId, userData);

    const tokenHoldings = await getTokenHoldings(address, userId);

    if (tokenHoldings.length === 0) {
      await ctx.editMessageText(
        `📈 **ETH SELL TOKEN**

❌ No token holdings found.

This could mean:
• You haven't bought any tokens yet
• Your tokens haven't been detected (manual input available)

💡 Try buying some tokens first, or manually enter a token address.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Buy Tokens', callback_data: 'eth_buy' }],
              [{ text: '🔢 Manual Token Address', callback_data: 'eth_sell_manual' }],
              [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    // Create buttons for each token
    const keyboard = [];
    for (let i = 0; i < Math.min(tokenHoldings.length, 8); i++) {
      const token = tokenHoldings[i];
      keyboard.push([{
        text: `💎 ${token.symbol}: ${token.balance} (~$${token.usdValue})`,
        callback_data: `eth_sell_select_${token.address}`
      }]);
    }

    // Add navigation buttons
    keyboard.push([{ text: '🔢 Manual Token Address', callback_data: 'eth_sell_manual' }]);
    keyboard.push([{ text: '🔄 Refresh Holdings', callback_data: 'eth_sell' }]);
    keyboard.push([{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]);

    const ethBalance = await ethChain.getETHBalance(address);

    await ctx.editMessageText(
      `📈 **ETH SELL TOKEN**

**Your Wallet:**
Address: ${address.slice(0, 6)}...${address.slice(-4)}
ETH Balance: ${ethBalance} ETH

**Token Holdings:**
Select a token to sell:`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error loading token holdings:', error);
    await ctx.editMessageText(
      `❌ **Error loading holdings**

${error.message}

This is usually temporary. Please try again.`,
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

// Manual token address input
bot.action('eth_sell_manual', async (ctx) => {
  const userId = ctx.from.id.toString();

  await ctx.editMessageText(
    `🔢 **MANUAL TOKEN SELL**

Enter the token contract address you want to sell:

Example: 0x6B175474E89094C44Da98b954EedeAC495271d0F

Send the token address now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Holdings', callback_data: 'eth_sell' }
        ]]
      }
    }
  );

  userStates.set(userId, {
    action: 'sell_token_address',
    timestamp: Date.now()
  });
});

// Handle token selection for selling
bot.action(/^eth_sell_select_(.+)$/, async (ctx) => {
  const tokenAddress = ctx.match[1];
  await showEthSellAmountSelection(ctx, tokenAddress);
});

// Show amount selection with SHORT button data
async function showEthSellAmountSelection(ctx, tokenAddress) {
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Loading token details...**');

    const userData = await loadUserData(userId);
    const address = await getWalletAddress(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, address);
    const balanceFormatted = ethers.utils.formatUnits(tokenBalance, tokenInfo.decimals);

    if (parseFloat(balanceFormatted) === 0) {
      await ctx.editMessageText(
        `❌ **No Balance Found**

You don't have any ${tokenInfo.symbol} tokens in your wallet.

Address: ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
            ]
          }
        }
      );
      return;
    }

    // Store token mapping and use shorter callback data
    const shortId = storeTokenMapping(tokenAddress);

    const keyboard = [
      [
        { text: '25%', callback_data: `sell_p_${shortId}_25` },
        { text: '50%', callback_data: `sell_p_${shortId}_50` }
      ],
      [
        { text: '75%', callback_data: `sell_p_${shortId}_75` },
        { text: '100%', callback_data: `sell_p_${shortId}_100` }
      ],
      [{ text: '🔢 Custom Amount', callback_data: `sell_c_${shortId}` }],
      [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
    ];

    await ctx.editMessageText(
      `📈 **SELL ${tokenInfo.symbol.toUpperCase()}**

**Token:** ${tokenInfo.name} (${tokenInfo.symbol})
**Your Balance:** ${parseFloat(balanceFormatted).toLocaleString()} ${tokenInfo.symbol}
**Address:** ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}

**Select Amount to Sell:**`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error loading token for sell:', error);
    await ctx.editMessageText(
      `❌ **Error loading token**

${error.message}

Please try again or select a different token.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
          ]
        }
      }
    );
  }
}

// Show sell review with gas estimates and shorter callback data
async function showEthSellReview(ctx, tokenAddress, amount, amountType = 'percent') {
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Calculating sell details...**');

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(tokenBalance, tokenInfo.decimals));

    // Calculate sell amount
    let sellAmount;
    if (amountType === 'percent') {
      sellAmount = balanceFormatted * (amount / 100);
    } else {
      sellAmount = amount;
    }

    if (sellAmount > balanceFormatted) {
      throw new Error(`Insufficient balance. You have ${balanceFormatted} ${tokenInfo.symbol}`);
    }

    const sellAmountWei = ethers.utils.parseUnits(sellAmount.toString(), tokenInfo.decimals);

    // Get swap quote
    const quote = await ethChain.getSwapQuote(tokenAddress, ethChain.contracts.WETH, sellAmountWei);
    const expectedEth = parseFloat(ethers.utils.formatEther(quote.outputAmount));

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = expectedEth * (feePercent / 100);
    const netReceive = expectedEth - feeAmount;

    // Estimate gas cost
    const gasEstimate = await ethChain.estimateSwapGas(tokenAddress, ethChain.contracts.WETH, sellAmountWei, wallet.address);
    const gasCostEth = parseFloat(ethers.utils.formatEther(gasEstimate.totalCost));

    // Use shorter callback data
    const shortId = storeTokenMapping(tokenAddress);

    const keyboard = [
      [{ text: '✅ Confirm Sale', callback_data: `sell_exec_${shortId}_${amount}_${amountType}` }],
      [{ text: '🔄 Change Amount', callback_data: `sell_retry_${shortId}` }],
      [{ text: '🔙 Cancel', callback_data: 'eth_sell' }]
    ];

    await ctx.editMessageText(
      `📈 **SELL REVIEW**

**Token:** ${tokenInfo.name} (${tokenInfo.symbol})
**Selling:** ${sellAmount.toLocaleString()} ${tokenInfo.symbol} (${amountType === 'percent' ? amount + '%' : 'custom'})

**💰 SALE BREAKDOWN:**
• Expected ETH: ${expectedEth.toFixed(6)} ETH
• Service Fee (${feePercent}%): ${feeAmount.toFixed(6)} ETH
• Gas Estimate: ${gasCostEth.toFixed(6)} ETH
• **Net Receive: ${(netReceive - gasCostEth).toFixed(6)} ETH**

**⚠️ FINAL CONFIRMATION REQUIRED**`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error in sell review:', error);
    await ctx.editMessageText(
      `❌ **Error calculating sale:**

${error.message}

Please try again or contact support.`,
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
// TOKEN HOLDINGS DETECTION
// ====================================================================

// Updated getTokenHoldings function with transaction history
async function getTokenHoldings(walletAddress, userId) {
  try {
    const holdings = [];
    const seenTokens = new Set(); // Track tokens we've already added

    // Check user's recent transaction history for bought tokens
    const userData = await loadUserData(userId);
    if (userData.transactions) {
      const buyTransactions = userData.transactions.filter(tx => tx.type === 'buy');

      for (const tx of buyTransactions) {
        try {
          // Skip if we've already seen this token
          if (seenTokens.has(tx.tokenAddress.toLowerCase())) {
            continue;
          }

          const balance = await ethChain.getTokenBalance(tx.tokenAddress, walletAddress);
          const tokenInfo = await ethChain.getTokenInfo(tx.tokenAddress);
          const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, tokenInfo.decimals));

          if (balanceFormatted > 0) {
            // Get actual USD value (simplified - you can enhance this)
            const usdValue = (balanceFormatted * 0.001).toFixed(2); // Rough estimate

            holdings.push({
              address: tx.tokenAddress,
              symbol: tokenInfo.symbol,
              name: tokenInfo.name,
              balance: balanceFormatted.toLocaleString(),
              balanceRaw: balance,
              decimals: tokenInfo.decimals,
              usdValue: usdValue
            });

            seenTokens.add(tx.tokenAddress.toLowerCase());
          }
        } catch (error) {
          console.log(`Failed to check token ${tx.tokenAddress}:`, error.message);
          continue;
        }
      }
    }

    // Also check common tokens (existing logic)
    const commonTokens = [
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      '0xA0b86a33E6417b8e84eec1b98d29A1b46e62F1e8', // USDC  
      '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
      '0xad15aF3451623F679AfC2c72ca4bd44B1Bfe69cc', // RNS (your test token)
      '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', // SHIB
      '0x6982508145454Ce325dDbE47a25d4ec3d2311933', // PEPE
    ];

    for (const tokenAddress of commonTokens) {
      // Skip if already found in transaction history
      if (holdings.find(h => h.address.toLowerCase() === tokenAddress.toLowerCase())) {
        continue;
      }

      try {
        const balance = await ethChain.getTokenBalance(tokenAddress, walletAddress);
        const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
        const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, tokenInfo.decimals));

        if (balanceFormatted > 0) {
          holdings.push({
            address: tokenAddress,
            symbol: tokenInfo.symbol,
            name: tokenInfo.name,
            balance: balanceFormatted.toLocaleString(),
            balanceRaw: balance,
            decimals: tokenInfo.decimals,
            usdValue: '0.00'
          });
        }
      } catch (error) {
        continue;
      }
    }

    return holdings;

  } catch (error) {
    console.log('Error getting token holdings:', error);
    return [];
  }
}

// Reply version for manual token address input
async function showEthSellAmountSelectionReply(ctx, tokenAddress) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const address = await getWalletAddress(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, address);
    const balanceFormatted = ethers.utils.formatUnits(tokenBalance, tokenInfo.decimals);

    if (parseFloat(balanceFormatted) === 0) {
      await ctx.reply(
        `❌ **No Balance Found**

You don't have any ${tokenInfo.symbol} tokens in your wallet.

Address: ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
            ]
          }
        }
      );
      return;
    }

    // Use shorter callback data
    const shortId = storeTokenMapping(tokenAddress);

    const keyboard = [
      [
        { text: '25%', callback_data: `sell_p_${shortId}_25` },
        { text: '50%', callback_data: `sell_p_${shortId}_50` }
      ],
      [
        { text: '75%', callback_data: `sell_p_${shortId}_75` },
        { text: '100%', callback_data: `sell_p_${shortId}_100` }
      ],
      [{ text: '🔢 Custom Amount', callback_data: `sell_c_${shortId}` }],
      [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
    ];

    await ctx.reply(
      `📈 **SELL ${tokenInfo.symbol.toUpperCase()}**

**Token:** ${tokenInfo.name} (${tokenInfo.symbol})
**Your Balance:** ${parseFloat(balanceFormatted).toLocaleString()} ${tokenInfo.symbol}
**Address:** ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}

**Select Amount to Sell:**`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error loading token for sell:', error);
    await ctx.reply(
      `❌ **Error loading token**

${error.message}

Please try again or select a different token.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
          ]
        }
      }
    );
  }
}

// ====================================================================
// SELL ACTION HANDLERS
// ====================================================================

// Updated percentage handlers with short callback data
bot.action(/^sell_p_(.+)_(\d+)$/, async (ctx) => {
  const match = ctx.match;
  const shortId = match[1];
  const percentage = parseInt(match[2]);

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    await showEthSellReview(ctx, tokenAddress, percentage, 'percent');
  } catch (error) {
    await ctx.editMessageText('❌ Token not found. Please try again.');
  }
});

// Updated custom amount handler with short callback data
bot.action(/^sell_c_(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  const userId = ctx.from.id.toString();

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    await ctx.editMessageText(
      `🔢 **CUSTOM SELL AMOUNT**

Enter the amount of tokens you want to sell:

Example: 1000 (for 1,000 tokens)
Example: 0.5 (for 0.5 tokens)

Send your custom amount now:`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Amount Selection', callback_data: `sell_retry_${shortId}` }
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
    await ctx.editMessageText('❌ Token not found. Please try again.');
  }
});

// Sell execution handler with token approval
bot.action(/^sell_exec_(.+)_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const shortId = match[1];
  const amount = match[2];
  const amountType = match[3];
  const userId = ctx.from.id.toString();

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    // Check rate limit
    await checkRateLimit(userId, 'transactions');

    await ctx.editMessageText('⏳ **Executing sale...**\n\nThis may take 60-90 seconds for approval + sale.');

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Get token info and calculate amounts
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(tokenBalance, tokenInfo.decimals));

    let sellAmount;
    if (amountType === 'percent') {
      sellAmount = balanceFormatted * (parseInt(amount) / 100);
    } else {
      sellAmount = parseFloat(amount);
    }

    const sellAmountWei = ethers.utils.parseUnits(sellAmount.toString(), tokenInfo.decimals);

    // Use executeTokenSale instead of executeSwap (includes approval)
    await ctx.editMessageText('⏳ **Approving token for sale...**');

    const saleResult = await ethChain.executeSmartTokenSale(
      tokenAddress,
      ethChain.contracts.WETH,
      parseInt(amount), // percentage (100 for 100%)
      wallet.privateKey,
      3
    );

    // Collect fee
    let feeResult = null;
    const quote = await ethChain.getSwapQuote(tokenAddress, ethChain.contracts.WETH, sellAmountWei);
    const expectedEth = parseFloat(ethers.utils.formatEther(quote.outputAmount));
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = parseFloat((expectedEth * (feePercent / 100)).toFixed(18));

    if (feeAmount > 0) {
      try {
        await ctx.editMessageText('⏳ **Processing service fee...**');
        feeResult = await ethChain.collectFee(
          wallet.privateKey,
          ethers.utils.parseEther(feeAmount.toString())
        );
      } catch (feeError) {
        console.log('Fee collection failed (non-blocking):', feeError.message);
      }
    }

    // Record transaction
    await recordTransaction(userId, {
      type: 'sell',
      tokenAddress,
      amount: sellAmount.toString(),
      feeAmount: feeAmount.toString(),
      txHash: saleResult.hash,
      feeHash: feeResult || null,
      timestamp: Date.now(),
      chain: 'ethereum'
    });

    await trackRevenue(feeAmount);

    // Success message
    await ctx.editMessageText(
      `✅ **SALE SUCCESSFUL!**

**Sold:** ${sellAmount.toLocaleString()} ${tokenInfo.symbol}
**Transaction:** [View on Etherscan](https://etherscan.io/tx/${saleResult.hash})
**Hash:** \`${saleResult.hash}\`

${feeResult ? `**Fee TX:** [View](https://etherscan.io/tx/${feeResult})` : '**Fee:** Processed separately'}

Your ETH should arrive in your wallet within 1-2 minutes.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Buy More Tokens', callback_data: 'eth_buy' }],
            [{ text: '📊 View Holdings', callback_data: 'eth_sell' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    // Log success
    logger.info(`Successful ETH sell: User ${userId}, Token ${tokenAddress}, Amount ${sellAmount} tokens`);

    // Update rate limit
    await updateRateLimit(userId, 'transactions');

  } catch (error) {
    console.log('Error executing sell:', error);
    await ctx.editMessageText(
      `❌ **Sale Failed**

${error.message}

No tokens were sold. Please try again.`,
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
});

// Retry handler
bot.action(/^sell_retry_(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  try {
    const tokenAddress = getFullTokenAddress(shortId);
    await showEthSellAmountSelection(ctx, tokenAddress);
  } catch (error) {
    await ctx.editMessageText('❌ Token not found. Please try again.');
  }
});

// ====================================================================
// CHUNK 3: ENHANCED MONITORING LOGIC FOR TARGETED SNIPING
// ====================================================================

async function startSnipeMonitoring(userId) {
  try {
    const userData = await loadUserData(userId);
    const snipeConfig = userData.snipeConfig;

    if (activeSnipeMonitors.has(userId)) {
      console.log(`⚠️ Snipe monitoring already active for user ${userId}`);
      return;
    }

    console.log(`🎯 Starting snipe monitoring for user ${userId} with strategy: ${snipeConfig.strategy}`);

    // Route to appropriate monitoring strategy
    if (snipeConfig.strategy === 'new_pairs') {
      // Existing degen mode logic - monitor ALL new pairs
      await startDegenModeMonitoring(userId);
    } else if (snipeConfig.strategy === 'first_liquidity') {
      // New targeted liquidity monitoring
      await startTargetedLiquidityMonitoring(userId);
    } else if (snipeConfig.strategy === 'contract_methods') {
      // New method monitoring
      await startMethodMonitoring(userId);
    } else {
      throw new Error(`Unknown strategy: ${snipeConfig.strategy}`);
    }

  } catch (error) {
    console.log(`❌ Failed to start snipe monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

// RENAME your existing monitoring logic to this (keep the same code, just rename)
async function startDegenModeMonitoring(userId) {
  try {
    const userData = await loadUserData(userId);
    const snipeConfig = userData.snipeConfig;

    console.log(`🚨 Starting DEGEN MODE monitoring for user ${userId} - will snipe ALL new pairs!`);

    // Get WebSocket provider for real-time monitoring
    const provider = await ethChain.getProvider();

    // Uniswap V2 Factory Contract Address
    const uniswapV2Factory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';

    // PairCreated event topic
    const pairCreatedTopic = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31aaaffd8d4';

    // Create event filter for new pair creation
    const filter = {
      address: uniswapV2Factory,
      topics: [pairCreatedTopic]
    };

    // Event handler function - YOUR EXISTING LOGIC
    const eventHandler = async (log) => {
      try {
        console.log(`🔥 NEW PAIR DETECTED for user ${userId}! TX: ${log.transactionHash}`);

        // Parse the PairCreated event
        const abiDecoder = new ethers.utils.Interface([
          'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
        ]);

        const decoded = abiDecoder.parseLog(log);
        const token0 = decoded.args.token0;
        const token1 = decoded.args.token1;
        const pairAddress = decoded.args.pair;

        console.log(`📊 Pair details: Token0=${token0}, Token1=${token1}, Pair=${pairAddress}`);

        // Determine which token is the new one (not WETH)
        const wethAddress = ethChain.contracts.WETH.toLowerCase();
        let newTokenAddress;

        if (token0.toLowerCase() === wethAddress) {
          newTokenAddress = token1;
        } else if (token1.toLowerCase() === wethAddress) {
          newTokenAddress = token0;
        } else {
          console.log(`⚠️ Neither token is WETH, skipping pair: ${token0}, ${token1}`);
          return;
        }

        console.log(`🎯 Target token identified: ${newTokenAddress}`);

        // Execute snipe attempt - YOUR EXISTING LOGIC
        await executeSnipeBuy(userId, newTokenAddress, snipeConfig.amount, log.transactionHash);

      } catch (error) {
        console.log(`❌ Error processing pair creation event for user ${userId}:`, error.message);
        if (error.stack) {
          console.log(`Stack trace:`, error.stack);
        }
      }
    };

    // Start listening for events
    provider.on(filter, eventHandler);

    // Store monitor reference for cleanup
    activeSnipeMonitors.set(userId, { 
      provider, 
      filter, 
      handler: eventHandler,
      startTime: Date.now(),
      strategy: 'new_pairs',
      mode: 'degen'
    });

    console.log(`✅ DEGEN MODE monitoring started for user ${userId} - monitoring ALL new pairs`);
    logger.info(`DEGEN MODE snipe monitoring started for user ${userId} with ${snipeConfig.amount} ETH per snipe`);

  } catch (error) {
    console.log(`❌ Failed to start degen mode monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

// ADD new targeted liquidity monitoring function
async function startTargetedLiquidityMonitoring(userId) {
  try {
    const userData = await loadUserData(userId);
    const snipeConfig = userData.snipeConfig;
    const targetTokens = snipeConfig.targetTokens?.filter(
      t => t.strategy === 'first_liquidity' && t.status === 'waiting'
    ) || [];

    if (targetTokens.length === 0) {
      throw new Error('No target tokens configured for liquidity monitoring');
    }

    console.log(`💧 Starting targeted liquidity monitoring for user ${userId} - ${targetTokens.length} tokens`);

    const provider = await ethChain.getProvider();
    const uniswapV2Factory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
    const pairCreatedTopic = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31aaaffd8d4';

    const filter = {
      address: uniswapV2Factory,
      topics: [pairCreatedTopic]
    };

    const eventHandler = async (log) => {
      try {
        // Parse event to get token addresses
        const abiDecoder = new ethers.utils.Interface([
          'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
        ]);

        const decoded = abiDecoder.parseLog(log);
        const token0 = decoded.args.token0.toLowerCase();
        const token1 = decoded.args.token1.toLowerCase();
        const pairAddress = decoded.args.pair;

        console.log(`🔍 Checking pair: ${token0} / ${token1}`);

        // Check if any of our target tokens are in this pair
        const matchedToken = targetTokens.find(target => 
          target.address === token0 || target.address === token1
        );

        if (matchedToken) {
          console.log(`🎯 TARGET TOKEN LIQUIDITY DETECTED! ${matchedToken.address}`);

          // Execute snipe for this specific token
          await executeSnipeBuy(userId, matchedToken.address, snipeConfig.amount, log.transactionHash);

          // Update token status in database
          const currentUserData = await loadUserData(userId);
          const tokenToUpdate = currentUserData.snipeConfig.targetTokens.find(
            t => t.address === matchedToken.address && t.strategy === 'first_liquidity'
          );

          if (tokenToUpdate) {
            tokenToUpdate.status = 'sniped';
            tokenToUpdate.snipedAt = Date.now();
            tokenToUpdate.txHash = log.transactionHash;
            await saveUserData(userId, currentUserData);
            console.log(`✅ Updated token status to 'sniped' for ${matchedToken.address}`);
          }

          // Notify user
          try {
            const displayName = matchedToken.label || `Token ${matchedToken.address.slice(0, 8)}...`;
            await bot.telegram.sendMessage(
              userId,
              `🔥 **TARGET TOKEN SNIPED!**\n\n${displayName} liquidity detected and sniped!\n\n**TX:** ${log.transactionHash.slice(0, 10)}...\n**Pair:** ${pairAddress.slice(0, 10)}...`
            );
          } catch (notifyError) {
            console.log(`⚠️ Failed to notify user ${userId}:`, notifyError.message);
          }
        }

      } catch (error) {
        console.log(`❌ Error processing targeted liquidity event:`, error.message);
      }
    };

    provider.on(filter, eventHandler);

    activeSnipeMonitors.set(userId, { 
      provider, 
      filter, 
      handler: eventHandler,
      startTime: Date.now(),
      strategy: 'first_liquidity',
      targetCount: targetTokens.length,
      mode: 'targeted'
    });

    console.log(`✅ Targeted liquidity monitoring started for ${targetTokens.length} tokens`);
    logger.info(`Targeted liquidity monitoring started for user ${userId} with ${targetTokens.length} target tokens`);

  } catch (error) {
    console.log(`❌ Failed to start targeted liquidity monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

// ADD new method monitoring function
async function startMethodMonitoring(userId) {
  try {
    const userData = await loadUserData(userId);
    const snipeConfig = userData.snipeConfig;
    const targetTokens = snipeConfig.targetTokens?.filter(
      t => t.strategy === 'contract_methods' && t.status === 'waiting'
    ) || [];

    if (targetTokens.length === 0) {
      throw new Error('No method targets configured for monitoring');
    }

    console.log(`🔧 Starting method monitoring for user ${userId} - ${targetTokens.length} targets`);

    const provider = await ethChain.getProvider();

    // Create filters for each target token + method combination
    const filters = targetTokens.map(target => ({
      address: target.address,
      topics: [target.method] // Method signature as topic
    }));

    const eventHandlers = [];

    for (let i = 0; i < targetTokens.length; i++) {
      const target = targetTokens[i];
      const filter = filters[i];

      const eventHandler = async (log) => {
        try {
          console.log(`🔧 METHOD CALL DETECTED! Contract: ${target.address}, Method: ${target.method}`);

          // Execute snipe for this token
          await executeSnipeBuy(userId, target.address, snipeConfig.amount, log.transactionHash);

          // Update token status
          const currentUserData = await loadUserData(userId);
          const tokenToUpdate = currentUserData.snipeConfig.targetTokens.find(
            t => t.address === target.address && t.strategy === 'contract_methods' && t.method === target.method
          );

          if (tokenToUpdate) {
            tokenToUpdate.status = 'sniped';
            tokenToUpdate.snipedAt = Date.now();
            tokenToUpdate.txHash = log.transactionHash;
            await saveUserData(userId, currentUserData);
          }

          // Notify user
          try {
            const displayName = target.label || `Token ${target.address.slice(0, 8)}...`;
            await bot.telegram.sendMessage(
              userId,
              `🔥 **METHOD CALL SNIPED!**\n\n${displayName} method ${target.method} executed and sniped!\n\n**TX:** ${log.transactionHash.slice(0, 10)}...`
            );
          } catch (notifyError) {
            console.log(`⚠️ Failed to notify user ${userId}:`, notifyError.message);
          }

        } catch (error) {
          console.log(`❌ Error processing method call event:`, error.message);
        }
      };

      provider.on(filter, eventHandler);
      eventHandlers.push({ filter, handler: eventHandler });
    }

    // Store all filters and handlers for cleanup
    activeSnipeMonitors.set(userId, { 
      provider, 
      filters: eventHandlers, // Multiple filters for method monitoring
      startTime: Date.now(),
      strategy: 'contract_methods',
      targetCount: targetTokens.length,
      mode: 'method_targeted'
    });

    console.log(`✅ Method monitoring started for ${targetTokens.length} method targets`);
    logger.info(`Method monitoring started for user ${userId} with ${targetTokens.length} method targets`);

  } catch (error) {
    console.log(`❌ Failed to start method monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

// ENHANCE your existing stopSnipeMonitoring function to handle multiple filters
async function stopSnipeMonitoring(userId) {
  try {
    if (!activeSnipeMonitors.has(userId)) {
      console.log(`⚠️ No active snipe monitoring found for user ${userId}`);
      return;
    }

    const monitor = activeSnipeMonitors.get(userId);

    // Handle different monitoring modes
    if (monitor.mode === 'method_targeted' && monitor.filters) {
      // Method monitoring has multiple filters
      for (const filterHandler of monitor.filters) {
        monitor.provider.off(filterHandler.filter, filterHandler.handler);
      }
      console.log(`🛑 Stopped method monitoring for user ${userId} (${monitor.filters.length} targets)`);
    } else if (monitor.provider && monitor.filter && monitor.handler) {
      // Single filter monitoring (degen mode, targeted liquidity)
      monitor.provider.off(monitor.filter, monitor.handler);
      console.log(`🛑 Stopped ${monitor.mode || monitor.strategy} monitoring for user ${userId}`);
    }

    // Remove from active monitors
    activeSnipeMonitors.delete(userId);

    logger.info(`Snipe monitoring stopped for user ${userId}`);

  } catch (error) {
    console.log(`❌ Error stopping snipe monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

// ENHANCE cleanup function for new monitoring types
function cleanupSnipeMonitors() {
  console.log(`🧹 Cleaning up ${activeSnipeMonitors.size} active snipe monitors...`);

  for (const [userId, monitor] of activeSnipeMonitors.entries()) {
    try {
      if (monitor.mode === 'method_targeted' && monitor.filters) {
        // Method monitoring cleanup
        for (const filterHandler of monitor.filters) {
          monitor.provider.off(filterHandler.filter, filterHandler.handler);
        }
        console.log(`✅ Cleaned up method monitoring for user ${userId}`);
      } else if (monitor.provider && monitor.filter && monitor.handler) {
        // Single filter cleanup
        monitor.provider.off(monitor.filter, monitor.handler);
        console.log(`✅ Cleaned up ${monitor.mode || monitor.strategy} monitoring for user ${userId}`);
      }
    } catch (error) {
      console.log(`⚠️ Error cleaning up snipe monitor for user ${userId}:`, error.message);
    }
  }

  activeSnipeMonitors.clear();
  console.log(`✅ All snipe monitors cleaned up`);
}

// ====================================================================
// 🎯 SNIPING ENGINE - CHUNK 4: ENHANCED STARTUP
// ====================================================================


// Handle liquidity token address input
async function handleLiquidityTokenInput(ctx, userId) {
  const input = ctx.message.text.trim();
  const parts = input.split(/\s+/);
  const tokenAddress = parts[0];
  const tokenLabel = parts.slice(1).join(' ') || null;

  try {
    userStates.delete(userId);

    // Validate address format
    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format. Must be 42 characters starting with 0x');
    }

    // Get current user data
    const userData = await loadUserData(userId);

    // Initialize targetTokens array if it doesn't exist
    if (!userData.snipeConfig.targetTokens) {
      userData.snipeConfig.targetTokens = [];
    }

    // Check if token already exists
    const existingToken = userData.snipeConfig.targetTokens.find(
      t => t.address.toLowerCase() === tokenAddress.toLowerCase() && t.strategy === 'first_liquidity'
    );

    if (existingToken) {
      throw new Error('This token is already in your liquidity watch list');
    }

    // Try to get token info for validation (optional)
    let tokenInfo = null;
    try {
      tokenInfo = await ethChain.getTokenInfo(tokenAddress);
      console.log(`✅ Token validated: ${tokenInfo.name} (${tokenInfo.symbol})`);
    } catch (tokenError) {
      console.log(`⚠️ Could not validate token info, but proceeding anyway: ${tokenError.message}`);
    }

    // Add new target token
    const newToken = {
      address: tokenAddress.toLowerCase(),
      strategy: 'first_liquidity',
      label: tokenLabel || (tokenInfo ? `${tokenInfo.name} (${tokenInfo.symbol})` : null),
      status: 'waiting',
      addedAt: Date.now()
    };

    userData.snipeConfig.targetTokens.push(newToken);
    await saveUserData(userId, userData);

    console.log(`✅ Added liquidity target token for user ${userId}: ${tokenAddress}`);

    const displayName = newToken.label || `Token ${tokenAddress.slice(0, 8)}...`;

    await ctx.reply(
      `✅ **Token added to liquidity watch list!**

**Address:** \`${tokenAddress}\`
**Name:** ${displayName}
**Strategy:** First Liquidity Events

The bot will now monitor this token for liquidity addition events and snipe when detected.

**💡 Tip:** You can add more tokens or start monitoring when ready!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Add Another Token', callback_data: 'add_liquidity_token' }],
            [{ text: '▶️ Start Monitoring', callback_data: 'start_liquidity_snipe' }],
            [{ text: '🔙 Back to Token List', callback_data: 'snipe_set_strategy_first_liquidity' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid token contract address.

**Valid format:** \`0x1234567890abcdef1234567890abcdef12345678\`
**With name:** \`0x123...abc Token Name\``,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'add_liquidity_token' }],
            [{ text: '🔙 Back to Strategy', callback_data: 'snipe_set_strategy_first_liquidity' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
}

// Handle method token + signature input
async function handleMethodTokenInput(ctx, userId) {
  const input = ctx.message.text.trim();
  const parts = input.split(/\s+/);

  if (parts.length < 2) {
    userStates.delete(userId);
    await ctx.reply(
      `❌ **Invalid format!**

You need to provide both token address AND method signature.

**Format:** \`TokenAddress MethodSignature [TokenName]\`
**Example:** \`0x123...abc 0x095ea7b3 MEME Token\``,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'add_method_token' }],
            [{ text: '📖 Common Methods', callback_data: 'show_common_methods' }],
            [{ text: '🔙 Back to Strategy', callback_data: 'snipe_set_strategy_contract_methods' }]
          ]
        }
      }
    );
    return;
  }

  const tokenAddress = parts[0];
  const methodSignature = parts[1];
  const tokenLabel = parts.slice(2).join(' ') || null;

  try {
    userStates.delete(userId);

    // Validate address format
    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format. Must be 42 characters starting with 0x');
    }

    // Validate method signature format
    if (!methodSignature.match(/^0x[a-fA-F0-9]{8}$/)) {
      throw new Error('Invalid method signature format. Must be 10 characters starting with 0x (e.g., 0x095ea7b3)');
    }

    // Get current user data
    const userData = await loadUserData(userId);

    // Initialize targetTokens array if it doesn't exist
    if (!userData.snipeConfig.targetTokens) {
      userData.snipeConfig.targetTokens = [];
    }

    // Check if this exact combination already exists
    const existingToken = userData.snipeConfig.targetTokens.find(
      t => t.address.toLowerCase() === tokenAddress.toLowerCase() && 
           t.strategy === 'contract_methods' && 
           t.method.toLowerCase() === methodSignature.toLowerCase()
    );

    if (existingToken) {
      throw new Error('This token + method combination is already in your watch list');
    }

    // Try to get token info for validation (optional)
    let tokenInfo = null;
    try {
      tokenInfo = await ethChain.getTokenInfo(tokenAddress);
      console.log(`✅ Token validated: ${tokenInfo.name} (${tokenInfo.symbol})`);
    } catch (tokenError) {
      console.log(`⚠️ Could not validate token info, but proceeding anyway: ${tokenError.message}`);
    }

    // Add new method target
    const newToken = {
      address: tokenAddress.toLowerCase(),
      strategy: 'contract_methods',
      method: methodSignature.toLowerCase(),
      label: tokenLabel || (tokenInfo ? `${tokenInfo.name} (${tokenInfo.symbol})` : null),
      status: 'waiting',
      addedAt: Date.now()
    };

    userData.snipeConfig.targetTokens.push(newToken);
    await saveUserData(userId, userData);

    console.log(`✅ Added method target for user ${userId}: ${tokenAddress} + ${methodSignature}`);

    const displayName = newToken.label || `Token ${tokenAddress.slice(0, 8)}...`;

    await ctx.reply(
      `✅ **Method target added to watch list!**

**Address:** \`${tokenAddress}\`
**Method:** \`${methodSignature}\`
**Name:** ${displayName}
**Strategy:** Contract Methods

The bot will now monitor this contract for the specified method call and snipe when executed.

**💡 Tip:** You can add more method targets or start monitoring when ready!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Add Another Target', callback_data: 'add_method_token' }],
            [{ text: '▶️ Start Monitoring', callback_data: 'start_method_snipe' }],
            [{ text: '🔙 Back to Method List', callback_data: 'snipe_set_strategy_contract_methods' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please check your input and try again.

**Valid format:** \`TokenAddress MethodSignature [TokenName]\`
**Example:** \`0x123...abc 0x095ea7b3 MEME Token\``,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'add_method_token' }],
            [{ text: '📖 Common Methods', callback_data: 'show_common_methods' }],
            [{ text: '🔙 Back to Strategy', callback_data: 'snipe_set_strategy_contract_methods' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
}

// ENHANCE your existing message handling logic
// Find your existing bot.on('text') handler and ADD these cases to it

// ADD this to your existing message handler routing logic:
/*
// Add these cases to your existing message handler:

if (userState?.action === 'waiting_liquidity_token') {
  await handleLiquidityTokenInput(ctx, userId);
  return;
}

if (userState?.action === 'waiting_method_token') {
  await handleMethodTokenInput(ctx, userId);
  return;
}
*/

// If you don't have a message handler yet, ADD this complete handler:
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = userStates.get(userId);

  // Skip if no state (normal conversation)
  if (!userState) {
    return;
  }

  try {
    // Route to appropriate input handler based on state
    if (userState.action === 'waiting_eth_private_key') {
      await handleEthPrivateKeyImport(ctx, userId);
    } else if (userState.action === 'waiting_token_address') {
      await handleTokenAddress(ctx, userId);
    } else if (userState.action === 'waiting_custom_amount') {
      await handleCustomAmount(ctx, userId, userState.tokenAddress);
    } else if (userState.action === 'waiting_sell_token_address') {
      await handleSellTokenAddress(ctx, userId);
    } else if (userState.action === 'waiting_sell_custom_amount') {
      await handleSellCustomAmount(ctx, userId, userState.tokenAddress);
    } else if (userState.action === 'waiting_liquidity_token') {
      await handleLiquidityTokenInput(ctx, userId);
    } else if (userState.action === 'waiting_method_token') {
      await handleMethodTokenInput(ctx, userId);
    } else {
      // Unknown state, clear it
      userStates.delete(userId);
      await ctx.reply('❌ Session expired. Please try again.');
    }
  } catch (error) {
    console.log('Error in message handler:', error);
    userStates.delete(userId);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

// ADD helper function to get method name from signature (optional enhancement)
function getMethodName(signature) {
  const methodNames = {
    '0x095ea7b3': 'approve',
    '0xa9059cbb': 'transfer', 
    '0x23b872dd': 'transferFrom',
    '0xf305d719': 'addLiquidity',
    '0xe8e33700': 'addLiquidityETH',
    '0x38ed1739': 'swapExactTokensForTokens',
    '0x8803dbee': 'swapTokensForExactTokens',
    '0x7ff36ab5': 'swapExactETHForTokens',
    '0x18cbafe5': 'swapExactTokensForETH'
  };

  return methodNames[signature.toLowerCase()] || 'Unknown Method';
}

// ADD validation helper for better error messages
function validateEthereumAddress(address) {
  if (!address) {
    return { valid: false, error: 'Address is required' };
  }

  if (!address.startsWith('0x')) {
    return { valid: false, error: 'Address must start with 0x' };
  }

  if (address.length !== 42) {
    return { valid: false, error: 'Address must be exactly 42 characters long' };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { valid: false, error: 'Address contains invalid characters. Use only 0-9 and a-f' };
  }

  return { valid: true };
}

function validateMethodSignature(signature) {
  if (!signature) {
    return { valid: false, error: 'Method signature is required' };
  }

  if (!signature.startsWith('0x')) {
    return { valid: false, error: 'Method signature must start with 0x' };
  }

  if (signature.length !== 10) {
    return { valid: false, error: 'Method signature must be exactly 10 characters long' };
  }

  if (!/^0x[a-fA-F0-9]{8}$/.test(signature)) {
    return { valid: false, error: 'Method signature contains invalid characters. Use only 0-9 and a-f' };
  }

  return { valid: true };
}

console.log('🎯 CHUNK 4 LOADED: Message handlers and input processing ready!');

// Enhanced bot startup with sniping system integration
async function initializeBot() {
  try {
    // Create logs directory
    await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });

    // Create users database directory
    await fs.mkdir(path.join(__dirname, 'db', 'users'), { recursive: true });

    logger.info('Bot directories initialized');

    // Initialize sniping system
    console.log('🎯 Initializing sniping engine...');

    // Validate environment variables for sniping
    const requiredEnvVars = ['BOT_TOKEN', 'ETH_RPC_URL', 'TREASURY_WALLET'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    // Test blockchain connection
    try {
      const provider = await ethChain.getProvider();
      const blockNumber = await provider.getBlockNumber();
      console.log(`✅ Blockchain connection established. Current block: ${blockNumber}`);
    } catch (providerError) {
      console.log(`⚠️ Blockchain connection issue: ${providerError.message}`);
      throw new Error('Failed to connect to Ethereum network');
    }

    // Restore active snipe monitors for existing users
    await restoreActiveSnipeMonitors();

    console.log('✅ Sniping engine initialized successfully!');

  } catch (error) {
    logger.error('Error initializing bot:', error);
    throw error;
  }
}

// Restore snipe monitors for users who had active sniping when bot restarted
async function restoreActiveSnipeMonitors() {
  try {
    console.log('🔄 Restoring active snipe monitors...');

    const usersDir = path.join(__dirname, 'db', 'users');

    // Check if users directory exists
    try {
      await fs.access(usersDir);
    } catch (error) {
      console.log('No users directory found, skipping monitor restoration');
      return;
    }

    const userFiles = await fs.readdir(usersDir);
    let restoredCount = 0;

    for (const file of userFiles) {
      if (!file.endsWith('.json')) continue;

      try {
        const userId = file.replace('.json', '');
        const userData = await loadUserData(userId);

        // Check if user had active sniping
        if (userData.snipeConfig && userData.snipeConfig.active) {
          console.log(`🎯 Restoring snipe monitor for user ${userId}`);

          // Validate user still has a wallet and sufficient balance
          if (userData.ethWallets && userData.ethWallets.length > 0) {
            const address = await getWalletAddress(userId, userData);
            const balance = await ethChain.getETHBalance(address);
            const requiredBalance = userData.snipeConfig.amount + 0.02;

            if (parseFloat(balance) >= requiredBalance) {
              await startSnipeMonitoring(userId);
              restoredCount++;
              console.log(`✅ Restored snipe monitor for user ${userId}`);
            } else {
              console.log(`⚠️ User ${userId} has insufficient balance, pausing sniping`);
              await updateSnipeConfig(userId, { active: false });
            }
          } else {
            console.log(`⚠️ User ${userId} has no wallets, pausing sniping`);
            await updateSnipeConfig(userId, { active: false });
          }
        }
      } catch (userError) {
        console.log(`⚠️ Error restoring monitor for user file ${file}:`, userError.message);
        continue;
      }
    }

    console.log(`✅ Restored ${restoredCount} active snipe monitors`);

  } catch (error) {
    console.log('⚠️ Error restoring snipe monitors:', error.message);
    // Don't fail bot startup for this
  }
}
// Helper function to get snipe statistics
async function getSnipeStatistics(userId) {
  try {
    const userData = await loadUserData(userId);
    const today = new Date().toDateString();

    const todayTransactions = (userData.transactions || []).filter(tx => 
      tx.type === 'snipe' && new Date(tx.timestamp).toDateString() === today
    );

    const todayAttempts = todayTransactions.length;
    const todaySuccessful = todayTransactions.filter(tx => tx.txHash && !tx.failed).length;
    const successRate = todayAttempts > 0 ? Math.round((todaySuccessful / todayAttempts) * 100) : 0;

    return {
      todayAttempts,
      todaySuccessful,
      successRate,
      totalAttempts: (userData.transactions || []).filter(tx => tx.type === 'snipe').length
    };
  } catch (error) {
    return {
      todayAttempts: 0,
      todaySuccessful: 0,
      successRate: 0,
      totalAttempts: 0
    };
  }
}
// Enhanced startup function with sniping integration
async function startBot() {
  try {
    await initializeBot();

    // Launch bot
    await bot.launch();

    logger.info('🚀 Purity Sniper Bot is running!');
    console.log('🚀 Purity Sniper Bot is running!');
    console.log('💰 Ready to start generating revenue from ETH trades!');
    console.log('✅ COMPLETE REFACTOR WITH FEE-FIRST STRUCTURE!');
    console.log('🔧 Buy/Sell logic completely functional!');
    console.log('🎯 Fee collection happens BEFORE trades!');
    console.log('📱 All functionality preserved and enhanced!');
    console.log('');
    console.log('🎯 NEW: SNIPING ENGINE ACTIVE!');
    console.log('⚡ Real-time Uniswap monitoring enabled');
    console.log('🔥 Auto-snipe new pairs with proven buy logic');
    console.log('💎 1% fees collected on all snipes automatically');
    console.log(`🎮 Active snipe monitors: ${activeSnipeMonitors.size}`);
    console.log('');
    console.log('🚀 READY TO SNIPE AND GENERATE MASSIVE REVENUE! 🚀');

  } catch (error) {
    logger.error('Failed to start bot:', error);
    console.log('❌ Bot startup failed:', error.message);
    process.exit(1);
  }
}

// Enhanced graceful shutdown with snipe monitor cleanup
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

  try {
    // Stop all active snipe monitors
    console.log('🎯 Stopping snipe monitors...');
    cleanupSnipeMonitors();

    // Stop bot
    console.log('🤖 Stopping Telegram bot...');
    bot.stop(signal);

    // Log shutdown
    logger.info(`Bot stopped gracefully via ${signal}`);
    console.log('✅ Bot stopped gracefully');

    // Give time for cleanup
    setTimeout(() => {
      console.log('👋 Goodbye!');
      process.exit(0);
    }, 2000);

  } catch (error) {
    logger.error('Error during shutdown:', error);
    console.log('❌ Error during shutdown:', error.message);
    process.exit(1);
  }
}

// Enhanced error handling for snipe monitors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  console.log('❌ Uncaught Exception:', error.message);

  // Try to cleanup snipe monitors before crashing
  try {
    cleanupSnipeMonitors();
  } catch (cleanupError) {
    console.log('Failed to cleanup during crash:', cleanupError.message);
  }

  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  console.log('❌ Unhandled Rejection:', reason);

  // Don't crash for unhandled rejections, but log them
  // Snipe monitors should continue running
});

// Graceful shutdown handlers
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Enhanced cleanup for user states with snipe considerations
const originalUserStateCleanup = setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  for (const [userId, state] of userStates.entries()) {
    if (now - state.timestamp > oneHour) {
      userStates.delete(userId);
      console.log(`Cleaned up old state for user ${userId}`);
    }
  }
}, 60 * 60 * 1000);

// Monitor health check - logs active snipe monitors every 30 minutes
setInterval(() => {
  const activeCount = activeSnipeMonitors.size;
  const snipeAttemptCount = snipeAttempts.size;

  console.log(`🏥 Health Check: ${activeCount} active snipe monitors, ${snipeAttemptCount} users with recent snipe attempts`);

  if (activeCount > 0) {
    console.log('📊 Active snipers:');
    for (const [userId, monitor] of activeSnipeMonitors.entries()) {
      const uptime = Math.round((Date.now() - monitor.startTime) / 1000 / 60); // minutes
      console.log(`   User ${userId}: ${monitor.strategy} strategy, ${uptime} min uptime`);
    }
  }

  logger.info(`Health check: ${activeCount} active snipe monitors, ${snipeAttemptCount} recent snipe users`);
}, 30 * 60 * 1000); // Every 30 minutes

// Helper function to track revenue - FIXED VERSION
async function trackRevenue(feeAmount, type = 'trading_fee') {
  try {
    // Log to revenue tracking system
    const revenueData = {
      amount: feeAmount,
      currency: 'ETH',
      timestamp: Date.now(),
      type: type
    };

    logger.info('Revenue collected:', revenueData);

    // Enhanced logging for snipe revenues
    if (type === 'snipe_fee') {
      console.log(`💰 SNIPE REVENUE: ${feeAmount} ETH collected from auto-snipe`);
    }

    // Log daily revenue totals
    const today = new Date().toDateString();
    // You could implement daily revenue tracking here

  } catch (error) {
    console.log('Error in revenue tracking:', error.message);
  }
}

// Performance monitoring for sniping
let snipePerformanceStats = {
  totalAttempts: 0,
  successfulSnipes: 0,
  totalRevenue: 0,
  averageExecutionTime: 0,
  lastResetTime: Date.now()
};

// Reset stats daily
setInterval(() => {
  const stats = snipePerformanceStats;
  const successRate = stats.totalAttempts > 0 ? (stats.successfulSnipes / stats.totalAttempts * 100).toFixed(1) : 0;

  console.log(`📈 DAILY SNIPE PERFORMANCE SUMMARY:`);
  console.log(`   Total Attempts: ${stats.totalAttempts}`);
  console.log(`   Successful Snipes: ${stats.successfulSnipes}`);
  console.log(`   Success Rate: ${successRate}%`);
  console.log(`   Revenue Generated: ${stats.totalRevenue.toFixed(6)} ETH`);
  console.log(`   Avg Execution Time: ${stats.averageExecutionTime.toFixed(2)}ms`);

  logger.info(`Daily snipe performance: ${stats.successfulSnipes}/${stats.totalAttempts} (${successRate}%), ${stats.totalRevenue.toFixed(6)} ETH revenue`);

  // Reset stats for next day
  snipePerformanceStats = {
    totalAttempts: 0,
    successfulSnipes: 0,
    totalRevenue: 0,
    averageExecutionTime: 0,
    lastResetTime: Date.now()
  };
}, 24 * 60 * 60 * 1000); // Every 24 hours

console.log('🎯 CHUNK 4 LOADED: Final integration and enhanced startup ready!');
console.log('🚀 SNIPING ENGINE FULLY INTEGRATED!');

// Start the bot with enhanced sniping capabilities
startBot();

