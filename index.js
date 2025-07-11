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
// 🎯 SNIPING ENGINE - DATA STRUCTURES & STATE MANAGEMENT
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

    const address = await walletManager.getWalletAddress(encryptedKey, userId);
    const privateKey = await walletManager.decryptPrivateKey(encryptedKey, userId);

    return {
      address: address,
      privateKey: privateKey,
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

    return await walletManager.getWalletAddress(encryptedKey, userId);
  } catch (error) {
    throw new Error(`Failed to get SOL wallet address: ${error.message}`);
  }
}

// ====================================================================
// SOL HANDLERS - BASIC IMPLEMENTATIONS TO PREVENT CRASHES
// ====================================================================

async function showSolWallet(ctx) {
  await ctx.editMessageText(
    `🟣 **SOL WALLET**

🚧 SOL wallet management is under development.

This feature will include:
• Import/Generate SOL wallets
• View SOL balance
• Transaction history

Coming soon!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
        ]
      }
    }
  );
}

async function showSolBuy(ctx) {
  await ctx.editMessageText(
    `🟣 **SOL BUY TOKEN**

🚧 SOL token buying is under development.

This feature will include:
• Buy SPL tokens with SOL
• Jupiter DEX integration
• Real-time pricing

Coming soon!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
        ]
      }
    }
  );
}

async function showSolSell(ctx) {
  await ctx.editMessageText(
    `🟣 **SOL SELL TOKEN**

🚧 SOL token selling is under development.

This feature will include:
• Sell SPL tokens for SOL
• Jupiter DEX integration
• Portfolio management

Coming soon!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
        ]
      }
    }
  );
}

async function showSolMirror(ctx) {
  await ctx.editMessageText(
    `🟣 **SOL MIRROR TRADING**

🚧 SOL mirror trading is under development.

This feature will include:
• Copy SOL wallet trades
• Real-time monitoring
• Auto-execution

Coming soon!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
        ]
      }
    }
  );
}

async function showSolSnipe(ctx) {
  await ctx.editMessageText(
    `🟣 **SOL SNIPE TOKEN**

🚧 SOL token sniping is under development.

This feature will include:
• Snipe new SPL tokens
• Raydium/Orca monitoring
• Auto-buy on liquidity

Coming soon!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
        ]
      }
    }
  );
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

// ETH Trading handlers
bot.action('eth_wallet', showEthWallet);
bot.action('eth_buy', showEthBuy);
bot.action('eth_sell', showEthSell);
bot.action('eth_mirror', showEthMirror);

// SOL Trading handlers - CRITICAL: Prevent crashes
bot.action('sol_wallet', showSolWallet);
bot.action('sol_buy', showSolBuy);
bot.action('sol_sell', showSolSell);
bot.action('sol_mirror', showSolMirror);
bot.action('sol_snipe', showSolSnipe);

// ETH Buy amount handlers
bot.action(/^eth_buy_amount_(.+)_(.+)$/, handleEthBuyAmount);
bot.action(/^eth_buy_custom_(.+)$/, handleEthBuyCustom);
bot.action(/^eth_buy_execute_(.+)_(.+)$/, handleEthBuyExecute);

// ETH Sell handlers
bot.action(/^eth_sell_token_(.+)$/, handleEthSellToken);
bot.action(/^eth_sell_percentage_(.+)_(.+)$/, handleEthSellPercentage);
bot.action(/^eth_sell_execute_(.+)_(.+)_(.+)$/, handleEthSellExecute);

// Wallet management handlers
bot.action('eth_wallet_import', handleEthWalletImport);
bot.action('eth_wallet_generate', handleEthWalletGenerate);
bot.action('eth_wallet_view', handleEthWalletView);

// SOL Buy amount handlers - CRITICAL: Prevent crashes
bot.action(/^sol_buy_amount_(.+)_(.+)$/, handleSolBuyAmount);
bot.action(/^sol_buy_execute_(.+)_(.+)$/, handleSolBuyExecute);

// SOL Sell handlers - CRITICAL: Prevent crashes
bot.action(/^sol_sell_token_(.+)$/, handleSolSellToken);
bot.action(/^sol_sell_percentage_(.+)_(.+)$/, handleSolSellPercentage);
bot.action(/^sol_sell_execute_(.+)_(.+)_(.+)$/, handleSolSellExecute);

// SOL Wallet management handlers
bot.action('sol_wallet_import', handleSolWalletImport);
bot.action('sol_wallet_generate', handleSolWalletGenerate);
bot.action('sol_wallet_view', handleSolWalletView);

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
              [{ text: '➕ Import ETH Wallet', callback_data: 'eth_wallet_import' }],
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
      `🔥 **SNIPING ACTIVATED!**

✅ **Monitoring for opportunities...**
⚡ **Ready to snipe when targets are found!**

**Active Settings:**
• Amount: ${snipeAmount} ETH per snipe
• Strategy: ${userData.snipeConfig.strategy}
• Slippage: ${userData.snipeConfig.slippage}%

**🔔 You will be notified of all snipe attempts**

**⚠️ Warning:** Sniping is high-risk. Only snipe what you can afford to lose.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏸️ Pause Sniping', callback_data: 'snipe_pause' }],
            [{ text: '⚙️ Adjust Settings', callback_data: 'eth_snipe' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`User ${userId} started sniping with ${snipeAmount} ETH`);

  } catch (error) {
    console.log('Error starting sniping:', error);
    await ctx.editMessageText(
      `❌ **Failed to start sniping**

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

You can resume sniping anytime by clicking Start Sniping.`,
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

// Strategy configuration
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

**💧 First Liquidity Events:**
• Monitor specific tokens you add
• Snipe when target tokens get liquidity
• Surgical precision approach

**🔧 Contract Methods:**
• Monitor specific contract method calls
• Advanced strategy for technical users
• Snipe based on contract interactions

Select your preferred strategy:`,
    {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    }
  );
});

// Amount setting handlers
bot.action(/^snipe_set_amount_(.+)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    await updateSnipeConfig(userId, { amount: amount });

    await ctx.editMessageText(
      `✅ **Snipe Amount Updated**

**New Amount:** ${amount} ETH per snipe

This amount will be used for each automatic snipe attempt.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚙️ Other Settings', callback_data: 'eth_snipe' }],
            [{ text: '🔙 Back to Amount Config', callback_data: 'snipe_config_amount' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    await ctx.answerCbQuery(`✅ Amount set to ${amount} ETH`);

  } catch (error) {
    console.log('Error setting amount:', error);
    await ctx.answerCbQuery('❌ Failed to update amount');
  }
});

// Slippage setting handlers
bot.action(/^snipe_set_slippage_(\d+)$/, async (ctx) => {
  const slippage = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    await updateSnipeConfig(userId, { slippage: slippage });

    await ctx.editMessageText(
      `✅ **Slippage Updated**

**New Slippage:** ${slippage}%

${slippage <= 10 ? 
        '💡 **Conservative:** Lower chance of success but better prices' : 
        slippage <= 20 ? 
        '⚡ **Balanced:** Good compromise between speed and price' : 
        '🔥 **Aggressive:** Higher success rate but may get fewer tokens'
      }`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚙️ Other Settings', callback_data: 'eth_snipe' }],
            [{ text: '🔙 Back to Slippage Config', callback_data: 'snipe_config_slippage' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    await ctx.answerCbQuery(`✅ Slippage set to ${slippage}%`);

  } catch (error) {
    console.log('Error setting slippage:', error);
    await ctx.answerCbQuery('❌ Failed to update slippage');
  }
});

// ====================================================================
// ETH WALLET MANAGEMENT
// ====================================================================

async function showEthWallet(ctx) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);

    let walletInfo = '🔗 **ETHEREUM WALLET**\n\n';

    if (userData.ethWallets && userData.ethWallets.length > 0) {
      try {
        const address = await getWalletAddress(userId, userData);
        const balance = await ethChain.getETHBalance(address);

        walletInfo += `📍 **Address:** \`${address}\`\n`;
        walletInfo += `💰 **Balance:** ${balance} ETH\n\n`;
        walletInfo += `🔐 Wallet is encrypted and secure`;

        const keyboard = [
          [{ text: '📥 Import Wallet', callback_data: 'eth_wallet_import' }],
          [{ text: '🔄 Generate New', callback_data: 'eth_wallet_generate' }],
          [{ text: '👁️ View Details', callback_data: 'eth_wallet_view' }],
          [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
        ];

        await ctx.editMessageText(walletInfo, {
          reply_markup: { inline_keyboard: keyboard },
          parse_mode: 'Markdown'
        });
      } catch (error) {
        throw new Error('Failed to load wallet information');
      }
    } else {
      walletInfo += '❌ No wallet found\n\n';
      walletInfo += 'Import an existing wallet or generate a new one to start trading.';

      const keyboard = [
        [{ text: '📥 Import Wallet', callback_data: 'eth_wallet_import' }],
        [{ text: '🔄 Generate New', callback_data: 'eth_wallet_generate' }],
        [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
      ];

      await ctx.editMessageText(walletInfo, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.message}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]]
      }
    });
  }
}

async function handleEthWalletImport(ctx) {
  const userId = ctx.from.id.toString();
  userStates.set(userId, { action: 'importing_eth_wallet' });

  await ctx.editMessageText(
    `🔐 **IMPORT ETH WALLET**

Send me your private key to import your wallet.

⚠️ **Security Note:** Your private key will be encrypted with AES-256 encryption and stored securely.

🔙 Send /cancel to go back`,
    { parse_mode: 'Markdown' }
  );
}

async function handleEthWalletGenerate(ctx) {
  const userId = ctx.from.id.toString();

  try {
    const newWallet = ethers.Wallet.createRandom();
    const privateKey = newWallet.privateKey;
    const address = newWallet.address;

    // Encrypt and store wallet
    const encryptedKey = await walletManager.encryptPrivateKey(privateKey, userId);
    const userData = await loadUserData(userId);

    if (!userData.ethWallets) {
      userData.ethWallets = [];
    }

    userData.ethWallets.push(encryptedKey);
    userData.activeEthWallet = userData.ethWallets.length - 1;

    await saveUserData(userId, userData);

    await ctx.editMessageText(
      `✅ **NEW ETH WALLET GENERATED**

📍 **Address:** \`${address}\`
🔐 **Private Key:** \`${privateKey}\`

⚠️ **IMPORTANT:** Save your private key securely! This is the only time it will be shown in plain text.

💰 Send ETH to your address to start trading.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Wallet', callback_data: 'eth_wallet' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  } catch (error) {
    await ctx.editMessageText(`❌ Error generating wallet: ${error.message}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]]
      }
    });
  }
}

async function handleEthWalletView(ctx) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const address = await getWalletAddress(userId, userData);
    const balance = await ethChain.getETHBalance(address);

    const walletInfo = `👁️ **WALLET DETAILS**

📍 **Address:** \`${address}\`
💰 **ETH Balance:** ${balance} ETH
🔗 **Network:** Ethereum Mainnet
🔐 **Security:** AES-256 Encrypted

[View on Etherscan](https://etherscan.io/address/${address})`;

    await ctx.editMessageText(walletInfo, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to Wallet', callback_data: 'eth_wallet' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.message}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]]
      }
    });
  }
}

// ====================================================================
// ETH BUY HANDLERS
// ====================================================================

async function showEthBuy(ctx) {
  const userId = ctx.from.id.toString();

  try {
    // Check if user has wallet
    const userData = await loadUserData(userId);
    if (!userData.ethWallets || userData.ethWallets.length === 0) {
      await ctx.editMessageText(
        `❌ **No wallet found**

You need to import or generate a wallet first to start trading.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📥 Import Wallet', callback_data: 'eth_wallet_import' }],
              [{ text: '🔄 Generate Wallet', callback_data: 'eth_wallet_generate' }],
              [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    userStates.set(userId, { action: 'entering_token_address' });

    await ctx.editMessageText(
      `💰 **BUY TOKEN**

Send me the token contract address you want to buy.

**Example:** \`0x1234567890abcdef1234567890abcdef12345678\`

🔙 Send /cancel to go back`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.message}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]]
      }
    });
  }
}

async function showEthBuyAmount(ctx, tokenAddress, tokenInfo) {
  const keyboard = [
    [
      { text: '0.1 ETH', callback_data: `eth_buy_amount_0.1_${createShortTokenId(tokenAddress)}` },
      { text: '0.5 ETH', callback_data: `eth_buy_amount_0.5_${createShortTokenId(tokenAddress)}` }
    ],
    [
      { text: '1 ETH', callback_data: `eth_buy_amount_1_${createShortTokenId(tokenAddress)}` },
      { text: '2 ETH', callback_data: `eth_buy_amount_2_${createShortTokenId(tokenAddress)}` }
    ],
    [{ text: '💎 Custom Amount', callback_data: `eth_buy_custom_${createShortTokenId(tokenAddress)}` }],
    [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
  ];

  const message = `💰 **BUY ${tokenInfo.symbol}**

📍 **Token:** ${tokenInfo.name} (${tokenInfo.symbol})
📄 **Contract:** \`${tokenAddress}\`

Choose amount to buy:`;

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

async function handleEthBuyAmount(ctx) {
  const userId = ctx.from.id.toString();
  const match = ctx.match;
  const amount = parseFloat(match[1]);
  const shortId = match[2];

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    // Check rate limit
    try {
      await checkRateLimit(userId, 'transactions');
      await updateRateLimit(userId, 'transactions');
    } catch (rateLimitError) {
      await ctx.answerCbQuery('⚠️ Rate limit exceeded. Please wait before making another request.', { show_alert: true });
      return;
    }

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Check balance
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);

    if (balanceFloat < amount + 0.02) { // Amount + gas buffer
      await ctx.answerCbQuery(`❌ Insufficient balance. Need ${amount + 0.02} ETH, have ${balance} ETH`, { show_alert: true });
      return;
    }

    // Get token info and quote
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const amountWei = ethers.utils.parseEther(amount.toString());
    const quote = await ethChain.getSwapQuote(ethChain.contracts.WETH, tokenAddress, amountWei);
    const expectedTokens = parseFloat(ethers.utils.formatUnits(quote.outputAmount, tokenInfo.decimals));

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amount * (feePercent / 100);
    const netTradeAmount = amount - feeAmount;

    const message = `🔥 **CONFIRM BUY ORDER**

🎯 **Token:** ${tokenInfo.symbol}
💰 **Total Amount:** ${amount} ETH
💸 **Fee (${feePercent}%):** ${feeAmount.toFixed(4)} ETH
📊 **Trade Amount:** ${netTradeAmount.toFixed(4)} ETH
🎁 **Expected:** ~${expectedTokens.toFixed(2)} ${tokenInfo.symbol}

⚠️ **Gas fees apply separately**`;

    const keyboard = [
      [{ text: '✅ Confirm Buy', callback_data: `eth_buy_execute_${amount}_${shortId}` }],
      [{ text: '❌ Cancel', callback_data: 'chain_eth' }]
    ];

    await ctx.editMessageText(message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    await ctx.answerCbQuery(`❌ Error: ${error.message}`, { show_alert: true });
  }
}

// Custom amount handler
async function handleEthBuyCustom(ctx) {
  const userId = ctx.from.id.toString();
  const shortId = ctx.match[1];

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    // Set user state for custom amount input
    userStates.set(userId, {
      action: 'entering_custom_amount',
      tokenAddress: tokenAddress,
      shortId: shortId,
      timestamp: Date.now()
    });

    await ctx.editMessageText(
      `💎 **CUSTOM AMOUNT - ${tokenInfo.symbol}**

📍 **Token:** ${tokenInfo.name} (${tokenInfo.symbol})
📄 **Contract:** \`${tokenAddress}\`

💰 **Enter the ETH amount you want to spend:**

**Examples:**
• 0.1 (for 0.1 ETH)
• 1.5 (for 1.5 ETH)
• 0.05 (for 0.05 ETH)

🔙 Send /cancel to go back`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.message}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]]
      }
    });
  }
}

async function handleEthBuyExecute(ctx) {
  const userId = ctx.from.id.toString();
  const match = ctx.match;
  const amount = parseFloat(match[1]);
  const shortId = match[2];

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    await ctx.editMessageText('⏳ **Executing buy order...**\n\nPlease wait...', { parse_mode: 'Markdown' });

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amount * (feePercent / 100);
    const netTradeAmount = amount - feeAmount;

    // Execute swap
    const swapResult = await ethChain.executeSwap(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString()),
      wallet.privateKey,
      userData.settings?.slippage || 3
    );

    // Collect fee (non-blocking)
    let feeResult = null;
    if (feeAmount > 0) {
      try {
        feeResult = await ethChain.collectFee(wallet.privateKey, feeAmount.toString());
      } catch (feeError) {
        console.log('Fee collection failed:', feeError.message);
      }
    }

    // Record transaction
    await recordTransaction(userId, {
      type: 'buy',
      tokenAddress,
      amount: amount.toString(),
      tradeAmount: netTradeAmount.toString(),
      feeAmount: feeAmount.toString(),
      txHash: swapResult.hash,
      feeHash: feeResult?.hash || null,
      timestamp: Date.now(),
      chain: 'ethereum'
    });

    // Track revenue
    await trackRevenue(feeAmount);

    const successMessage = `✅ **BUY ORDER COMPLETED!**

🎯 **Token:** ${tokenAddress.slice(0, 8)}...
💰 **Amount:** ${netTradeAmount} ETH
📊 **Fee:** ${feeAmount} ETH
🔗 **TX:** [View on Etherscan](https://etherscan.io/tx/${swapResult.hash})

🎉 Your tokens will appear in your wallet shortly!`;

    await ctx.editMessageText(successMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
        ]
      },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    await ctx.editMessageText(`❌ **Buy order failed:**\n\n${error.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'eth_buy' }],
          [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  }
}

// ====================================================================
// ETH SELL HANDLERS
// ====================================================================

async function showEthSell(ctx) {
  const userId = ctx.from.id.toString();

  try {
    // Check if user has wallet
    const userData = await loadUserData(userId);
    if (!userData.ethWallets || userData.ethWallets.length === 0) {
      await ctx.editMessageText(
        `❌ **No wallet found**

You need to import or generate a wallet first to start trading.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📥 Import Wallet', callback_data: 'eth_wallet_import' }],
              [{ text: '🔄 Generate Wallet', callback_data: 'eth_wallet_generate' }],
              [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    userStates.set(userId, { action: 'entering_sell_token_address' });

    await ctx.editMessageText(
      `💸 **SELL TOKEN**

Send me the token contract address you want to sell.

**Example:** \`0x1234567890abcdef1234567890abcdef12345678\`

🔙 Send /cancel to go back`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.message}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]]
      }
    });
  }
}

async function showEthSellPercentage(ctx, tokenAddress, tokenInfo, tokenBalance) {
  const shortId = storeTokenMapping(tokenAddress);
  const balanceFormatted = parseFloat(ethers.utils.formatUnits(tokenBalance, tokenInfo.decimals));

  const keyboard = [
    [
      { text: '25%', callback_data: `eth_sell_percentage_25_${shortId}` },
      { text: '50%', callback_data: `eth_sell_percentage_50_${shortId}` }
    ],
    [
      { text: '75%', callback_data: `eth_sell_percentage_75_${shortId}` },
      { text: '100%', callback_data: `eth_sell_percentage_100_${shortId}` }
    ],
    [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
  ];

  const message = `💸 **SELL ${tokenInfo.symbol}**

📍 **Token:** ${tokenInfo.name} (${tokenInfo.symbol})
💰 **Balance:** ${balanceFormatted.toFixed(4)} ${tokenInfo.symbol}
📄 **Contract:** \`${tokenAddress}\`

Choose percentage to sell:`;

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

async function handleEthSellToken(ctx) {
  const userId = ctx.from.id.toString();
  const shortId = ctx.match[1];

  try {
    const tokenAddress = getFullTokenAddress(shortId);
    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);

    if (tokenBalance.isZero()) {
      await ctx.answerCbQuery(`❌ No ${tokenInfo.symbol} balance found`, { show_alert: true });
      return;
    }

    await showEthSellPercentage(ctx, tokenAddress, tokenInfo, tokenBalance);

  } catch (error) {
    await ctx.answerCbQuery(`❌ Error: ${error.message}`, { show_alert: true });
  }
}

async function handleEthSellPercentage(ctx) {
  const userId = ctx.from.id.toString();
  const match = ctx.match;
  const percentage = parseInt(match[1]);
  const shortId = match[2];

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    // Check rate limit
    try {
      await checkRateLimit(userId, 'transactions');
      await updateRateLimit(userId, 'transactions');
    } catch (rateLimitError) {
      await ctx.answerCbQuery('⚠️ Rate limit exceeded. Please wait before making another request.', { show_alert: true });
      return;
    }

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(tokenBalance, tokenInfo.decimals));

    // Calculate sell amount
    const sellAmount = balanceFormatted * (percentage / 100);
    const sellAmountWei = ethChain.calculateSmartSellAmount(tokenBalance, percentage, tokenInfo.decimals);

    // Get swap quote
    const quote = await ethChain.getSwapQuote(tokenAddress, ethChain.contracts.WETH, sellAmountWei);
    const expectedEth = parseFloat(ethers.utils.formatEther(quote.outputAmount));

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = expectedEth * (feePercent / 100);
    const netReceive = expectedEth - feeAmount;

    const message = `🔥 **CONFIRM SELL ORDER**

🎯 **Token:** ${tokenInfo.symbol}
💸 **Selling:** ${sellAmount.toFixed(4)} ${tokenInfo.symbol} (${percentage}%)
💰 **Expected ETH:** ${expectedEth.toFixed(6)} ETH
💸 **Fee (${feePercent}%):** ${feeAmount.toFixed(6)} ETH
📊 **You Receive:** ${netReceive.toFixed(6)} ETH

⚠️ **Gas fees apply separately**`;

    const keyboard = [
      [{ text: '✅ Confirm Sell', callback_data: `eth_sell_execute_${percentage}_${shortId}_percent` }],
      [{ text: '❌ Cancel', callback_data: 'chain_eth' }]
    ];

    await ctx.editMessageText(message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    await ctx.answerCbQuery(`❌ Error: ${error.message}`, { show_alert: true });
  }
}

async function handleEthSellExecute(ctx) {
  const userId = ctx.from.id.toString();
  const match = ctx.match;
  const amount = parseFloat(match[1]);
  const shortId = match[2];
  const amountType = match[3];

  try {
    const tokenAddress = getFullTokenAddress(shortId);

    await ctx.editMessageText('⏳ **Executing sell order...**\n\nPlease wait...', { parse_mode: 'Markdown' });

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(tokenBalance, tokenInfo.decimals));

    // Calculate sell amount
    let sellAmountWei;
    if (amountType === 'percent') {
      sellAmountWei = ethChain.calculateSmartSellAmount(tokenBalance, amount, tokenInfo.decimals);
    } else {
      sellAmountWei = ethers.utils.parseUnits(amount.toString(), tokenInfo.decimals);
    }

    // Execute smart token sale
    const saleResult = await ethChain.executeSmartTokenSale(
      tokenAddress,
      ethChain.contracts.WETH,
      amount,
      wallet.privateKey,
      userData.settings?.slippage || 3
    );

    // Calculate fees on received ETH
    const receivedEth = parseFloat(saleResult.details.actualAmount || '0');
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = receivedEth * (feePercent / 100);

    // Collect fee (non-blocking)
    let feeResult = null;
    if (feeAmount > 0) {
      try {
        feeResult = await ethChain.collectFee(wallet.privateKey, feeAmount.toString());
      } catch (feeError) {
        console.log('Fee collection failed:', feeError.message);
      }
    }

    // Record transaction
    await recordTransaction(userId, {
      type: 'sell',
      tokenAddress,
      amount: amount.toString(),
      amountType: amountType,
      receivedEth: receivedEth.toString(),
      feeAmount: feeAmount.toString(),
      txHash: saleResult.transaction.hash,
      feeHash: feeResult?.hash || null,
      timestamp: Date.now(),
      chain: 'ethereum'
    });

    // Track revenue
    await trackRevenue(feeAmount);

    const successMessage = `✅ **SELL ORDER COMPLETED!**

🎯 **Token:** ${tokenInfo.symbol}
💸 **Sold:** ${saleResult.details.amountSold} ${tokenInfo.symbol}
💰 **Received:** ${(receivedEth - feeAmount).toFixed(6)} ETH
📊 **Fee:** ${feeAmount.toFixed(6)} ETH
🔗 **TX:** [View on Etherscan](https://etherscan.io/tx/${saleResult.transaction.hash})

💰 ETH has been added to your wallet!`;

    await ctx.editMessageText(successMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
        ]
      },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    await ctx.editMessageText(`❌ **Sell order failed:**\n\n${error.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'eth_sell' }],
          [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  }
}

async function showEthMirror(ctx) {
  await ctx.editMessageText(
    `🪞 **MIRROR TRADING**

Mirror trading feature coming soon! This will allow you to automatically copy trades from other wallets.

🚧 Under development...`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
        ]
      },
      parse_mode: 'Markdown'
    }
  );
}

// ====================================================================
// SNIPE EXECUTION FUNCTION
// ====================================================================

async function executeSnipeBuy(userId, tokenAddress, amount, triggerTxHash) {
  const startTime = Date.now();

  try {
    console.log(`🎯 EXECUTING SNIPE BUY for user ${userId}, token ${tokenAddress}, amount ${amount} ETH`);

    // Check snipe rate limits
    checkSnipeRateLimit(userId);

    // Get user data and wallet
    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Check wallet balance
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);
    const requiredBalance = amount + 0.02; // Amount + gas buffer

    if (balanceFloat < requiredBalance) {
      throw new Error(`Insufficient balance: ${balance} ETH < ${requiredBalance} ETH required`);
    }

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amount * (feePercent / 100);
    const netTradeAmount = amount - feeAmount;

    console.log(`💰 Snipe amounts: Total ${amount} ETH, Fee ${feeAmount} ETH, Trade ${netTradeAmount} ETH`);

    // Execute the swap
    const swapResult = await ethChain.executeSwap(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.utils.parseEther(netTradeAmount.toString()),
      wallet.privateKey,
      userData.snipeConfig.slippage || 10
    );

    console.log(`✅ SNIPE SUCCESSFUL! Hash: ${swapResult.hash}`);

    // Collect fee (non-blocking)
    let feeResult = null;
    if (feeAmount > 0) {
      try {
        feeResult = await ethChain.collectFee(
          wallet.privateKey,
          feeAmount.toString()
        );
        console.log(`💰 Fee collected: ${feeResult?.hash || 'Failed'}`);
      } catch (feeError) {
        console.log(`⚠️ Fee collection failed: ${feeError.message}`);
      }
    }

    // Record transaction
    await recordTransaction(userId, {
      type: 'snipe',
      tokenAddress,
      amount: amount.toString(),
      tradeAmount: netTradeAmount.toString(),
      feeAmount: feeAmount.toString(),
      txHash: swapResult.hash,
      feeHash: feeResult?.hash || null,
      timestamp: Date.now(),
      chain: 'ethereum',
      triggerTxHash: triggerTxHash,
      executionTime: Date.now() - startTime,
      strategy: userData.snipeConfig.strategy
    });

    // Track revenue
    await trackRevenue(feeAmount);

    // Notify user
    try {
      await bot.telegram.sendMessage(
        userId,
        `🔥 **SNIPE SUCCESSFUL!**\n\nToken: ${tokenAddress.slice(0, 8)}...\nAmount: ${netTradeAmount} ETH\nTX: [View](https://etherscan.io/tx/${swapResult.hash})\n\n🎯 Auto-sniped by Purity Bot!`
      );
    } catch (notifyError) {
      console.log(`⚠️ Failed to notify user ${userId}:`, notifyError.message);
    }

    return swapResult;

  } catch (error) {
    console.log(`❌ SNIPE FAILED for user ${userId}:`, error.message);

    // Record failed snipe
    await recordTransaction(userId, {
      type: 'snipe',
      tokenAddress,
      amount: amount.toString(),
      txHash: null,
      timestamp: Date.now(),
      chain: 'ethereum',
      triggerTxHash: triggerTxHash,
      executionTime: Date.now() - startTime,
      failed: true,
      error: error.message,
      strategy: userData?.snipeConfig?.strategy || 'unknown'
    });

    // Notify user of failure
    try {
      await bot.telegram.sendMessage(
        userId,
        `❌ **SNIPE FAILED**\n\nToken: ${tokenAddress.slice(0, 8)}...\nError: ${error.message}\n\n⚠️ No funds were spent.`
      );
    } catch (notifyError) {
      console.log(`⚠️ Failed to notify user ${userId} of snipe failure:`, notifyError.message);
    }

    throw error;
  }
}

// ====================================================================
// MONITORING FUNCTIONS
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
      await startDegenModeMonitoring(userId);
    } else if (snipeConfig.strategy === 'first_liquidity') {
      await startTargetedLiquidityMonitoring(userId);
    } else if (snipeConfig.strategy === 'contract_methods') {
      await startMethodMonitoring(userId);
    } else {
      throw new Error(`Unknown strategy: ${snipeConfig.strategy}`);
    }

  } catch (error) {
    console.log(`❌ Failed to start snipe monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

async function startDegenModeMonitoring(userId) {
  try {
    const userData = await loadUserData(userId);
    const snipeConfig = userData.snipeConfig;

    console.log(`🚨 Starting DEGEN MODE monitoring for user ${userId} - will snipe ALL new pairs!`);

    const provider = await ethChain.getProvider();
    const uniswapV2Factory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
    const pairCreatedTopic = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31aaaffd8d4';

    const filter = {
      address: uniswapV2Factory,
      topics: [pairCreatedTopic]
    };

    const eventHandler = async (log) => {
      try {
        console.log(`🔥 NEW PAIR DETECTED for user ${userId}! TX: ${log.transactionHash}`);

        const abiDecoder = new ethers.utils.Interface([
          'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
        ]);

        const decoded = abiDecoder.parseLog(log);
        const token0 = decoded.args.token0;
        const token1 = decoded.args.token1;
        const pairAddress = decoded.args.pair;

        console.log(`📊 Pair details: Token0=${token0}, Token1=${token1}, Pair=${pairAddress}`);

        const wethAddress = ethChain.contracts.WETH.toLowerCase();
        let newTokenAddress;

        if (token0.toLowerCase() === wethAddress) {
          newTokenAddress = token1;
        } else if (token1.toLowerCase() === wethAddress === wethAddress) {
          newTokenAddress = token0;
        } else {
          console.log(`⚠️ Neither token is WETH, skipping pair: ${token0}, ${token1}`);
          return;
        }

        console.log(`🎯 Target token identified: ${newTokenAddress}`);

        await executeSnipeBuy(userId, newTokenAddress, snipeConfig.amount, log.transactionHash);

      } catch (error) {
        console.log(`❌ Error processing pair creation event for user ${userId}:`, error.message);
      }
    };

    provider.on(filter, eventHandler);

    activeSnipeMonitors.set(userId, { 
      provider, 
      filter, 
      handler: eventHandler,
      startTime: Date.now(),
      strategy: 'new_pairs',
      mode: 'degen'
    });

    console.log(`✅ DEGEN MODE monitoring started for user ${userId}`);
    logger.info(`DEGEN MODE snipe monitoring started for user ${userId} with ${snipeConfig.amount} ETH per snipe`);

  } catch (error) {
    console.log(`❌ Failed to start degen mode monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

async function stopSnipeMonitoring(userId) {
  try {
    if (!activeSnipeMonitors.has(userId)) {
      console.log(`⚠️ No active snipe monitoring found for user ${userId}`);
      return;
    }

    const monitor = activeSnipeMonitors.get(userId);

    if (monitor.mode === 'method_targeted' && monitor.filters) {
      for (const filterHandler of monitor.filters) {
        monitor.provider.off(filterHandler.filter, filterHandler.handler);
      }
      console.log(`🛑 Stopped method monitoring for user ${userId} (${monitor.filters.length} targets)`);
    } else if (monitor.provider && monitor.filter && monitor.handler) {
      monitor.provider.off(monitor.filter, monitor.handler);
      console.log(`🛑 Stopped ${monitor.mode || monitor.strategy} monitoring for user ${userId}`);
    }

    activeSnipeMonitors.delete(userId);
    logger.info(`Snipe monitoring stopped for user ${userId}`);

  } catch (error) {
    console.log(`❌ Error stopping snipe monitoring for user ${userId}:`, error.message);
    throw error;
  }
}

// ====================================================================
// UTILITY FUNCTIONS
// ====================================================================

// Helper function to record transaction
async function recordTransaction(userId, transactionData) {
  try {
    const userData = await loadUserData(userId);    if (!userData.transactions) {
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

// ====================================================================
// TEXT MESSAGE HANDLERS
// ====================================================================

// Cancel command handler
bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id.toString();
  userStates.delete(userId);
  
  await ctx.reply('❌ **Operation cancelled**', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
      ]
    },
    parse_mode: 'Markdown'
  });
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = userStates.get(userId);

  if (!userState) return;

  // Check for cancel command
  if (ctx.message.text.toLowerCase() === '/cancel') {
    userStates.delete(userId);
    await ctx.reply('❌ **Operation cancelled**', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
        ]
      },
      parse_mode: 'Markdown'
    });
    return;
  }

  try {
    switch (userState.action) {
      case 'importing_eth_wallet':
        await handleWalletImport(ctx, userId);
        break;

      case 'entering_token_address':
        await handleTokenAddress(ctx, userId);
        break;

      case 'entering_sell_token_address':
        await handleSellTokenAddress(ctx, userId);
        break;

      case 'entering_custom_amount':
        await handleCustomAmount(ctx, userId, userState);
        break;

      default:
        userStates.delete(userId);
        break;
    }
  } catch (error) {
    console.log('Text handler error:', error.message);
    userStates.delete(userId);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

// Handle wallet import
async function handleWalletImport(ctx, userId) {
  const privateKey = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    // Validate private key format
    if (!privateKey.match(/^0x[a-fA-F0-9]{64}$/)) {
      throw new Error('Invalid private key format. Must be 64 hex characters starting with 0x');
    }

    // Test private key
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    // Encrypt and store
    const encryptedKey = await walletManager.encryptPrivateKey(privateKey, userId);
    const userData = await loadUserData(userId);

    if (!userData.ethWallets) {
      userData.ethWallets = [];
    }

    userData.ethWallets.push(encryptedKey);
    userData.activeEthWallet = userData.ethWallets.length - 1;

    await saveUserData(userId, userData);

    // Delete the message containing private key for security
    try {
      await ctx.deleteMessage();
    } catch (deleteError) {
      // Ignore if we can't delete
    }

    await ctx.reply(
      `✅ **Wallet imported successfully!**

📍 **Address:** \`${address}\`
🔐 **Security:** Your private key has been encrypted and stored securely.

You can now start trading!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  } catch (error) {
    userStates.delete(userId);
    await ctx.reply(`❌ Error importing wallet: ${error.message}`);
  }
}

// Token address handler
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

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);

    // Delete the "validating" message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, validatingMessage.message_id);
    } catch (deleteError) {
      // Ignore if we can't delete the message
    }

    if (tokenBalance.isZero()) {
      await ctx.reply(
        `❌ **No balance found**

You don't have any ${tokenInfo.symbol} tokens to sell.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Another Token', callback_data: 'eth_sell' }],
              [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    await showEthSellPercentage(ctx, tokenAddress, tokenInfo, tokenBalance);

  } catch (error) {
    userStates.delete(userId);

    await ctx.reply(
      `❌ **Error:** ${error.message}

Please send a valid token contract address.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'eth_sell' }],
            [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
}

// Custom amount handler
async function handleCustomAmount(ctx, userId, userState) {
  const amount = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error('Invalid amount. Please enter a positive number.');
    }

    if (amountFloat < 0.001) {
      throw new Error('Minimum amount is 0.001 ETH');
    }

    if (amountFloat > 100) {
      throw new Error('Maximum amount is 100 ETH');
    }

    const tokenAddress = userState.tokenAddress;
    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Check balance
    const balance = await ethChain.getETHBalance(wallet.address);
    const balanceFloat = parseFloat(balance);

    if (balanceFloat < amountFloat + 0.02) { // Amount + gas buffer
      await ctx.reply(`❌ Insufficient balance. Need ${amountFloat + 0.02} ETH, have ${balance} ETH`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
          ]
        }
      });
      return;
    }

    // Get token info and quote
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const amountWei = ethers.utils.parseEther(amountFloat.toString());
    const quote = await ethChain.getSwapQuote(ethChain.contracts.WETH, tokenAddress, amountWei);
    const expectedTokens = parseFloat(ethers.utils.formatUnits(quote.outputAmount, tokenInfo.decimals));

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amountFloat * (feePercent / 100);
    const netTradeAmount = amountFloat - feeAmount;

    const shortId = storeTokenMapping(tokenAddress);

    const message = `🔥 **CONFIRM CUSTOM BUY ORDER**

🎯 **Token:** ${tokenInfo.symbol}
💰 **Total Amount:** ${amountFloat} ETH
💸 **Fee (${feePercent}%):** ${feeAmount.toFixed(4)} ETH
📊 **Trade Amount:** ${netTradeAmount.toFixed(4)} ETH
🎁 **Expected:** ~${expectedTokens.toFixed(2)} ${tokenInfo.symbol}

⚠️ **Gas fees apply separately**`;

    const keyboard = [
      [{ text: '✅ Confirm Buy', callback_data: `eth_buy_execute_${amountFloat}_${shortId}` }],
      [{ text: '❌ Cancel', callback_data: 'chain_eth' }]
    ];

    await ctx.reply(message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    userStates.delete(userId);
    await ctx.reply(`❌ Error: ${error.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'eth_buy' }],
          [{ text: '🔙 Back to ETH', callback_data: 'chain_eth' }]
        ]
      }
    });
  }
}

// ====================================================================
// STATISTICS AND SETTINGS HANDLERS
// ====================================================================

async function showStatistics(ctx) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const transactions = userData.transactions || [];

    // Calculate basic statistics
    const totalTransactions = transactions.length;
    const ethTransactions = transactions.filter(tx => tx.chain === 'ethereum').length;
    const solTransactions = transactions.filter(tx => tx.chain === 'solana').length;

    // Calculate success rate
    const recentTx = transactions.slice(-30); // Last 30 transactions
    const successfulTx = recentTx.filter(tx => tx.txHash && !tx.failed);
    const successRate = recentTx.length > 0 ? Math.round((successfulTx.length / recentTx.length) * 100) : 0;

    await ctx.editMessageText(
      `📊 **YOUR STATISTICS**

**Trading Activity:**
• Total Transactions: ${totalTransactions}
• ETH Transactions: ${ethTransactions}
• SOL Transactions: ${solTransactions}

**Performance:**
• Success Rate: ${successRate}%
• Recent Activity: ${recentTx.length} trades

**Account:**
• Premium: ${userData.premium?.active ? '⭐ Active' : '🆓 Free'}
• Member Since: ${new Date(userData.createdAt).toLocaleDateString()}

**Wallets:**
• ETH Wallets: ${userData.ethWallets?.length || 0}
• SOL Wallets: ${userData.solWallets?.length || 0}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    await ctx.editMessageText(
      `❌ **Error loading statistics**

${error.message}

Please try again.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
          ]
        }
      }
    );
  }
}

bot.action('statistics', showStatistics);

bot.action('settings', async (ctx) => {
  await ctx.editMessageText(
    `⚙️ **SETTINGS**

🚧 Settings management is under development.

This will include:
• Slippage configuration
• Gas price settings
• Notification preferences
• Premium subscription

Coming soon!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
        ]
      }
    }
  );
});

// SOL Buy Handlers
async function handleSolBuyAmount(ctx) {
  await ctx.answerCbQuery('🚧 SOL buying coming soon!');
  await showSolBuy(ctx);
}

async function handleSolBuyExecute(ctx) {
  await ctx.answerCbQuery('🚧 SOL buying coming soon!');
  await showSolBuy(ctx);
}

// SOL Sell Handlers
async function handleSolSellToken(ctx) {
  await ctx.answerCbQuery('🚧 SOL selling coming soon!');
  await showSolSell(ctx);
}

async function handleSolSellPercentage(ctx) {
  await ctx.answerCbQuery('🚧 SOL selling coming soon!');
  await showSolSell(ctx);
}

async function handleSolSellExecute(ctx) {
  await ctx.answerCbQuery('🚧 SOL selling coming soon!');
  await showSolSell(ctx);
}

// SOL Wallet Handlers
async function handleSolWalletImport(ctx) {
  await ctx.answerCbQuery('🚧 SOL wallet import coming soon!');
  await showSolWallet(ctx);
}

async function handleSolWalletGenerate(ctx) {
  await ctx.answerCbQuery('🚧 SOL wallet generation coming soon!');
  await showSolWallet(ctx);
}

async function handleSolWalletView(ctx) {
  await ctx.answerCbQuery('🚧 SOL wallet view coming soon!');
  await showSolWallet(ctx);
}
// ====================================================================
// BOT STARTUP
// ====================================================================

async function startBot() {
  try {
    // Create logs directory
    await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });

    // Create users database directory
    await fs.mkdir(path.join(__dirname, 'db', 'users'), { recursive: true });

    logger.info('Bot directories initialized');

    // Launch bot
    await bot.launch();

    logger.info('🚀 Purity Sniper Bot is running!');
    console.log('🚀 Purity Sniper Bot is running!');
    console.log('✅ Ready for trading!');
    console.log('🎯 SNIPING ENGINE ACTIVE!');
    console.log('⚡ Complete snipe functionality implemented!');

  } catch (error) {
    logger.error('Failed to start bot:', error);
    console.log('❌ Bot startup failed:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Start the bot
startBot();