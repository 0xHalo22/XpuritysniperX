// Applying changes to add SOL sell percentage handlers and complete SOL sell execution handler.
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
const SolChain = require('./chains/sol');
const MirrorTradingSystem = require('./utils/mirrorTrading');
const { checkRateLimit, updateRateLimit } = require('./utils/rateLimit');
const { initialize, getUser, saveUser, addTransaction, getUserTransactions } = require('./utils/database');

// Configure logging - MOVED TO TOP TO FIX INITIALIZATION ORDER
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'purity-sniper-bot' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Add file logging only if directories exist
async function setupFileLogging() {
  try {
    await fs.mkdir('logs', { recursive: true });
    logger.add(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
    logger.add(new winston.transports.File({ filename: 'logs/combined.log' }));
    logger.info('✅ File logging enabled');
  } catch (error) {
    logger.warn('⚠️ File logging disabled - using console only');
  }
}

// ====================================================================
// INITIALIZATION
// ====================================================================

const bot = new Telegraf(process.env.BOT_TOKEN);
const walletManager = new WalletManager();
const ethChain = new EthChain();
const solChain = new SolChain();
const mirrorTradingSystem = new MirrorTradingSystem();

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

// Record transaction function
async function recordTransaction(userId, transactionData) {
  try {
    // Add snipe-specific metadata
    if (transactionData.type === 'snipe') {
      transactionData.autoExecuted = true;
      transactionData.snipeStrategy = transactionData.strategy || 'unknown';
      transactionData.snipeAttemptTime = Date.now();
    }

    // Add transaction to database
    await addTransaction(userId, transactionData);

    // Also update user data with transaction
    const userData = await loadUserData(userId);
    if (!userData.transactions) {
      userData.transactions = [];
    }
    userData.transactions.push(transactionData);

    // Keep only last 100 transactions to prevent bloat
    if (userData.transactions.length > 100) {
      userData.transactions = userData.transactions.slice(-100);
    }

    await saveUserData(userId, userData);

    console.log(`✅ Transaction recorded for user ${userId}: ${transactionData.type}`);
    return transactionData;

  } catch (error) {
    console.log(`❌ Error recording transaction for user ${userId}:`, error.message);
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

// ====================================================================
// BOT STARTUP AND ERROR HANDLING
// ====================================================================

// Validate required environment variables
function validateEnvironment() {
  const required = ['BOT_TOKEN'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('💡 Please set these in the Secrets tab:');
    missing.forEach(key => {
      console.error(`   ${key}=your_${key.toLowerCase()}_here`);
    });
    process.exit(1);
  }

  console.log('✅ Environment variables validated');
}

// Initialize and start the bot
async function startBot() {
  try {
    // Validate environment
    validateEnvironment();

    // Setup file logging
    await setupFileLogging();

    // Initialize database
    console.log('🗄️ Initializing database...');
    try {
      await initialize();
      console.log('✅ Database initialized');
    } catch (error) {
      console.log('⚠️ Database initialization failed, using fallback:', error.message);
    }

    // Start the bot
    console.log('🤖 Starting Telegram bot...');
    
    // Use simple launch without specific polling config first
    await bot.launch();
    
    console.log('✅ Bot is running and ready to receive messages!');
    console.log('📱 Send /start to the bot on Telegram to test');
    
    // Keep the process alive
    process.once('SIGINT', () => {
      console.log('🛑 Received SIGINT, shutting down gracefully...');
      cleanupSnipeMonitors();
      bot.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      console.log('🛑 Received SIGTERM, shutting down gracefully...');
      cleanupSnipeMonitors();
      bot.stop('SIGTERM');
    });

    // Set bot commands for UI
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'help', description: 'Get help' }
    ]);

  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    process.exit(1);
  }
}

// Note: Graceful shutdown handlers moved to after startBot() call

// Start the bot
startBot();

// Register error handlers
bot.catch((err, ctx) => {
  console.log(`❌ Bot error for ${ctx.updateType}:`, err);
});

// Signal handlers are now inside startBot() function to prevent conflicts

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

// ====================================================================
// MESSAGE INPUT HANDLERS FOR SOL FLOWS
// ====================================================================

// COMPLETE TEXT MESSAGE HANDLER - handles all user text inputs
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const message = ctx.message.text.trim();
  const userState = userStates.get(userId);

  // Skip if no active user state (normal conversation)
  if (!userState) {
    return;
  }

  console.log(`DEBUG: Processing text for user ${userId}, action: ${userState.action}`);

  try {
    // Route to appropriate handler based on user state action
    switch (userState.action) {
      // ETH WALLET IMPORT
      case 'wallet_import':
        await handleEthWalletImport(ctx, userId, message);
        break;

      // SOL WALLET IMPORT  
      case 'sol_wallet_import':
        await handleSolWalletImport(ctx, userId, message);
        break;

      // ETH TOKEN ADDRESS INPUT
      case 'token_address':
        await handleEthTokenAddress(ctx, userId, message);
        break;

      // ETH CUSTOM AMOUNT INPUT
      case 'custom_amount':
        await handleEthCustomAmount(ctx, userId, message, userState.tokenAddress);
        break;

      // ETH SELL TOKEN ADDRESS
      case 'sell_token_address':
        await handleEthSellTokenAddress(ctx, userId, message);
        break;

      // ETH SELL CUSTOM AMOUNT
      case 'sell_custom_amount':
        await handleEthSellCustomAmount(ctx, userId, message, userState.tokenAddress);
        break;

      // SOL TOKEN ADDRESS INPUT
      case 'sol_token_address':
        await handleSolTokenAddress(ctx, userId, message);
        break;

      // SOL CUSTOM AMOUNT INPUT (BUY)
      case 'sol_custom_amount':
        await handleSolCustomAmount(ctx, userId, message, userState.tokenAddress);
        break;

      // SOL SELL CUSTOM AMOUNT INPUT
      case 'sol_sell_custom_amount':
        await handleSolSellCustomAmount(ctx, userId, message, userState.tokenAddress);
        break;

      // SNIPE TARGET TOKENS
      case 'waiting_liquidity_token':
        await handleLiquidityTokenInput(ctx, userId, message);
        break;

      case 'waiting_method_token':
        await handleMethodTokenInput(ctx, userId, message);
        break;

      // UNKNOWN STATE - CLEAN UP
      default:
        console.log(`Unknown user state action: ${userState.action}`);
        userStates.delete(userId);
        await ctx.reply('❌ Session expired. Please try again.');
        break;
    }

  } catch (error) {
    console.log(`Error handling text input for user ${userId}:`, error.message);
    userStates.delete(userId);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

// ====================================================================
// TEXT INPUT HANDLER FUNCTIONS
// ====================================================================

// ETH Wallet Import Handler
async function handleEthWalletImport(ctx, userId, privateKey) {
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
    logger.error(`ETH wallet import error for user ${userId}:`, error);
    await ctx.reply(`❌ Error importing wallet: ${error.message}`);
  }
}

// SOL Wallet Import Handler
async function handleSolWalletImport(ctx, userId, privateKey) {
  try {
    userStates.delete(userId);

    // Import SOL wallet using wallet manager
    const encryptedKey = await walletManager.importWallet(privateKey, userId);

    // Update user data
    const userData = await loadUserData(userId);
    if (!userData.solWallets) {
      userData.solWallets = [];
    }
    userData.solWallets.push(encryptedKey);
    await saveUserData(userId, userData);

    const address = await walletManager.getWalletAddress(encryptedKey, userId);

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
    logger.error(`SOL wallet import error for user ${userId}:`, error);
    await ctx.reply(`❌ Error importing SOL wallet: ${error.message}`);
  }
}

// ETH Token Address Handler
async function handleEthTokenAddress(ctx, userId, tokenAddress) {
  try {
    userStates.delete(userId);

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    const validatingMessage = await ctx.reply('⏳ **Validating token...**');
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, validatingMessage.message_id);
    } catch (deleteError) {
      // Ignore if can't delete
    }

    await showEthBuyAmount(ctx, tokenAddress, tokenInfo);

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}\n\nPlease send a valid token contract address.`);
  }
}

// ETH Custom Amount Handler
async function handleEthCustomAmount(ctx, userId, amount, tokenAddress) {
  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0 || amountFloat > 100) {
      throw new Error('Invalid amount. Please enter a number between 0.001 and 100 ETH.');
    }

    await showEthBuyReviewReply(ctx, tokenAddress, amount);

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// ETH Sell Token Address Handler
async function handleEthSellTokenAddress(ctx, userId, tokenAddress) {
  try {
    userStates.delete(userId);

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    const validatingMessage = await ctx.reply('⏳ **Validating token...**');
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, validatingMessage.message_id);
    } catch (deleteError) {
      // Ignore if can't delete
    }

    await showEthSellAmountSelectionReply(ctx, tokenAddress);

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}\n\nPlease send a valid token contract address.`);
  }
}

// ETH Sell Custom Amount Handler
async function handleEthSellCustomAmount(ctx, userId, amount, tokenAddress) {
  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error('Invalid amount format');
    }

    await showEthSellReview(ctx, tokenAddress, amountFloat, 'custom');

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// SOL Token Address Handler
async function handleSolTokenAddress(ctx, userId, tokenAddress) {
  try {
    userStates.delete(userId);

    if (!solChain.isValidAddress(tokenAddress)) {
      await ctx.reply('❌ Invalid SOL token address. Please send a valid SPL token mint address.');
      return;
    }

    await showSolBuyAmountSelection(ctx, tokenAddress);

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// SOL Custom Amount Handler
async function handleSolCustomAmount(ctx, userId, amount, tokenAddress) {
  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0 || amountFloat > 100) {
      await ctx.reply('❌ Invalid amount. Please enter a number between 0.001 and 100 SOL.');
      return;
    }

    await showSolBuyReview(ctx, tokenAddress, amount);

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// SOL Sell Custom Amount Handler
async function handleSolSellCustomAmount(ctx, userId, amount, tokenAddress) {
  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      await ctx.reply('❌ Invalid amount. Please enter a positive number.');
      return;
    }

    await showSolSellReview(ctx, tokenAddress, amount, 'custom');

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// Liquidity Token Input Handler
async function handleLiquidityTokenInput(ctx, userId, input) {
  try {
    userStates.delete(userId);

    const parts = input.split(/\s+/);
    const tokenAddress = parts[0];
    const tokenLabel = parts.slice(1).join(' ') || null;

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    const userData = await loadUserData(userId);
    if (!userData.snipeConfig.targetTokens) {
      userData.snipeConfig.targetTokens = [];
    }

    const newToken = {
      address: tokenAddress.toLowerCase(),
      strategy: 'first_liquidity',
      label: tokenLabel,
      status: 'waiting',
      addedAt: Date.now()
    };

    userData.snipeConfig.targetTokens.push(newToken);
    await saveUserData(userId, userData);

    await ctx.reply(`✅ **Token added to liquidity watch list!**\n\nAddress: \`${tokenAddress}\``);

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// Method Token Input Handler
async function handleMethodTokenInput(ctx, userId, input) {
  try {
    userStates.delete(userId);

    const parts = input.split(/\s+/);
    if (parts.length < 2) {
      throw new Error('You need both token address AND method signature');
    }

    const tokenAddress = parts[0];
    const methodSignature = parts[1];
    const tokenLabel = parts.slice(2).join(' ') || null;

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    if (!methodSignature.match(/^0x[a-fA-F0-9]{8}$/)) {
      throw new Error('Invalid method signature format');
    }

    const userData = await loadUserData(userId);
    if (!userData.snipeConfig.targetTokens) {
      userData.snipeConfig.targetTokens = [];
    }

    const newToken = {
      address: tokenAddress.toLowerCase(),
      strategy: 'contract_methods',
      method: methodSignature.toLowerCase(),
      label: tokenLabel,
      status: 'waiting',
      addedAt: Date.now()
    };

    userData.snipeConfig.targetTokens.push(newToken);
    await saveUserData(userId, userData);

    await ctx.reply(`✅ **Method target added!**\n\nAddress: \`${tokenAddress}\`\nMethod: \`${methodSignature}\``);

  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// Logger configuration moved to top of file

// ====================================================================
// USER DATA MANAGEMENT
// ====================================================================

async function loadUserData(userId) {
  try {
    // Try Replit Database first
    const userData = await getUser(userId);

    // Load recent transactions from Replit Database
    const transactions = await getUserTransactions(userId, 50);
    userData.transactions = transactions;

    return userData;
  } catch (error) {
    console.log(`Database error for user ${userId}, using defaults:`, error.message);

    // Fallback to JSON file
    try {
      const userFile = path.join(__dirname, 'db', 'users', `${userId}.json`);
      const data = await fs.readFile(userFile, 'utf8');
      return JSON.parse(data);
    } catch (fileError) {
      // Return default user data if both fail
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
        lastActive: Date.now(),
        snipeConfig: {
          active: false,
          amount: 0.1,
          slippage: 10,
          strategy: 'first_liquidity',
          maxGasPrice: 100,
          minLiquidity: 1000,
          maxPerHour: 5,
          targetTokens: []
        }
      };
    }
  }
}

async function saveUserData(userId, userData) {
  try {
    // Update last active timestamp
    userData.lastActive = Date.now();

    // Save to Replit Database
    await saveUser(userId, userData);

    // Also save to JSON as backup
    try {
      const userDir = path.join(__dirname, 'db', 'users');
      const userFile = path.join(userDir, `${userId}.json`);
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(userFile, JSON.stringify(userData, null, 2));
    } catch (backupError) {
      console.log(`Backup JSON save failed (non-critical): ${backupError.message}`);
    }

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
// SOL WALLET HELPER FUNCTIONS
// ====================================================================

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

    // Create Solana keypair from private key
    const keypair = solChain.createWalletFromPrivateKey(privateKey);

    return {
      address: address,
      privateKey: privateKey,
      keypair: keypair,
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
// MAIN MENU HANDLERS
// ====================================================================

// Start command
bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    logger.info(`New user started bot: ${userId}`);

    await showMainMenu(ctx);
  } catch (error) {
    logger.error(`Error in start command for user ${ctx.from?.id}:`, error);
    try {
      await ctx.reply('❌ An error occurred. Please try again.');
    } catch (replyError) {
      console.log('Failed to send error message:', replyError.message);
    }
  }
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
    // For callback queries, try to edit the message
    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    } else {
      // For new conversations (like /start), send a new message
      await ctx.reply(message, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    // Fallback to sending a new message if editing fails
    logger.warn('Failed to edit message, sending new one:', error.message);
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
bot.action('statistics', showStatistics);

// Statistics Handler
async function showStatistics(ctx) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    consttransactions = userData.transactions || [];

    // Calculate statistics
    const totalTransactions = transactions.length;
    const ethTransactions = transactions.filter(tx => tx.chain === 'ethereum').length;
    const solTransactions = transactions.filter(tx => tx.chain === 'solana').length;

    // Calculate success rate for recent transactions (last 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const recentTx = transactions.filter(tx => tx.timestamp > thirtyDaysAgo);
    const successfulTx = recentTx.filter(tx => tx.status === 'completed' || tx.txHash);
    const successRate = recentTx.length > 0 ? Math.round((successfulTx.length / recentTx.length) * 100) : 0;

    // Get wallet counts
    const ethWallets = userData.ethWallets?.length || 0;
    const solWallets = userData.solWallets?.length || 0;

    const keyboard = [
      [{ text: '📊 Transaction History', callback_data: 'view_tx_history' }],
      [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
    ];

    await ctx.editMessageText(
      `📊 **YOUR STATISTICS**

**Wallets:**
🔗 ETH Wallets: ${ethWallets}
🟣 SOL Wallets: ${solWallets}

**Trading Activity:**
📈 Total Transactions: ${totalTransactions}
🔗 ETH Transactions: ${ethTransactions}
🟣 SOL Transactions: ${solTransactions}

**Performance (30 days):**
✅ Success Rate: ${successRate}%
📊 Recent Activity: ${recentTx.length} transactions

**Account Status:**
${userData.premium?.active ? '⭐ Premium Active' : '🆓 Free Plan'}
📅 Member Since: ${new Date(userData.createdAt).toLocaleDateString()}`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error loading statistics:', error);
    await ctx.editMessageText(
      `❌ **Error loading statistics**

${error.message}

Please try again.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Home', callback_data: 'main_menu' }
          ]]
        }
      }
    );
  }
}

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

// SOL Wallet Handler
bot.action('sol_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  if (!userData.solWallets || userData.solWallets.length === 0) {
    await showSolWalletSetup(ctx);
  } else {
    await showSolWalletManagement(ctx, userData);
  }
});

async function showSolWalletSetup(ctx) {
  const keyboard = [
    [{ text: '➕ Import SOL Wallet', callback_data: 'import_sol_wallet' }],
    [{ text: '🎲 Generate New SOL Wallet', callback_data: 'generate_sol_wallet' }],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  await ctx.editMessageText(
    `🟣 **SOL WALLET SETUP**

No SOL wallets found. Import your private key or generate a new wallet.

⚠️ Your private key will be encrypted and stored securely.
🔐 We never store plaintext keys.`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function showSolWalletManagement(ctx, userData) {
  const userId = ctx.from.id.toString();

  try {
    const address = await getSolWalletAddress(userId, userData);
    const balance = await solChain.getBalance(address);

    const keyboard = [
      [{ text: '💰 View Balance', callback_data: 'sol_view_balance' }],
      [{ text: '📊 Transaction History', callback_data: 'sol_tx_history' }],
      [{ text: '➕ Add Wallet', callback_data: 'import_sol_wallet' }]
    ];

    // Add wallet switching if multiple wallets
    if (userData.solWallets && userData.solWallets.length > 1) {
      keyboard.push([{ text: '🔄 Switch Wallet', callback_data: 'switch_sol_wallet' }]);
    }

    keyboard.push([{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]);

    const currentWalletIndex = userData.activeSolWallet || 0;

    await ctx.editMessageText(
      `🟣 **SOL WALLET**

**Active Wallet:**
Address: ${address.slice(0, 6)}...${address.slice(-4)}
Balance: ${balance} SOL

**Wallet ${currentWalletIndex + 1} of ${userData.solWallets?.length || 1}**`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error loading SOL wallet management:', error);
    await ctx.editMessageText(
      `❌ **Error loading SOL wallet**

${error.message}

Please import a SOL wallet to get started.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Import SOL Wallet', callback_data: 'import_sol_wallet' }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        }
      }
    );
  }
}

// SOL Buy Handler
bot.action('sol_buy', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  // Check if user has SOL wallet
  if (!userData.solWallets || userData.solWallets.length === 0) {
    await ctx.editMessageText(
      `🟣 **SOL BUY TOKEN**

❌ No SOL wallet found. Import a wallet first.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Import SOL Wallet', callback_data: 'import_sol_wallet' }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        }
      }
    );
    return;
  }

  await ctx.editMessageText(
    `🟣 **SOL BUY TOKEN**

Enter the SPL token mint address you want to buy:

Example: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263

Send the token mint address now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );

  // Set user state to expect token address
  userStates.set(userId, {
    action: 'sol_token_address',
    timestamp: Date.now()
  });
});

// SOL Sell Handler  
bot.action('sol_sell', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  // Check if user has SOL wallet
  if (!userData.solWallets || userData.solWallets.length === 0) {
    await ctx.editMessageText(
      `🟣 **SOL SELL TOKEN**

❌ No SOL wallet found. Import a wallet first.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Import SOL Wallet', callback_data: 'import_sol_wallet' }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        }
      }
    );
    return;
  }

  await showSolTokenHoldings(ctx, userId);
});

// SOL Snipe Handler
bot.action('sol_snipe', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);

    // Check if user has SOL wallet
    if (!userData.solWallets || userData.solWallets.length === 0) {
      await ctx.editMessageText(
        `🟣 **SOL SNIPE TOKEN**

❌ No SOL wallet found. Import a wallet first to start sniping.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Import SOL Wallet', callback_data: 'import_sol_wallet' }],
              [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
            ]
          }
        }
      );
      return;
    }

    await showSolSnipeConfiguration(ctx, userData);

  } catch (error) {
    console.log('Error in sol_snipe handler:', error);
    await ctx.editMessageText(
      `❌ **Error loading SOL snipe configuration**

${error.message}

Please try again.`,
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

// SOL Mirror Handler
bot.action('sol_mirror', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);

    // Check if user has SOL wallet
    if (!userData.solWallets || userData.solWallets.length === 0) {
      await ctx.editMessageText(
        `🟣 **SOL MIRROR WALLET**

❌ No SOL wallet found. Import a wallet first to start mirror trading.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Import SOL Wallet', callback_data: 'import_sol_wallet' }],
              [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
            ]
          }
        }
      );
      return;
    }

    await showSolMirrorConfiguration(ctx, userData);

  } catch (error) {
    console.log('Error in sol_mirror handler:', error);
    await ctx.editMessageText(
      `❌ **Error loading SOL mirror configuration**

${error.message}

Please try again.`,
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

// Import SOL Wallet Handler
bot.action('import_sol_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    await checkRateLimit(userId, 'walletImports');
  } catch (error) {
    await ctx.editMessageText(`❌ ${error.message}\n\n🔙 Try again later.`);
    return;
  }

  await ctx.editMessageText(
    `🔐 **IMPORT SOL WALLET**

Please send your Solana private key in the next message.

⚠️ Security Notes:
• Delete your message after sending
• Key will be encrypted immediately
• We never store plaintext keys
• Use base58 format (not hex)

Send your SOL private key now:`
  );

  userStates.set(userId, {
    action: 'sol_wallet_import',
    timestamp: Date.now()
  });
});

// SOL Balance Handler
bot.action('sol_view_balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  try {
    const address = await getSolWalletAddress(userId, userData);
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
      `❌ **Error loading balance**

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

// SOL Transaction History Handler
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
      `❌ **Error loading transaction history**

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
// SOL BUY FLOW HANDLERS - IMPLEMENTING MISSING FUNCTIONS
// ====================================================================

// SOL Buy Amount Selection - Shows amount buttons after token address input
async function showSolBuyAmountSelection(ctx, tokenMint) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const walletAddress = await getSolWalletAddress(userId, userData);
    const balance = await solChain.getBalance(walletAddress);

    // Get token info
    const tokenInfo = await solChain.getTokenInfo(tokenMint);

    const keyboard = [
      [
        { text: '💎 0.1 SOL', callback_data: `sol_buy_amount_${tokenMint}_0.1` },
        { text: '💎 0.25 SOL', callback_data: `sol_buy_amount_${tokenMint}_0.25` }
      ],
      [
        { text: '💎 0.5 SOL', callback_data: `sol_buy_amount_${tokenMint}_0.5` },
        { text: '💎 1.0 SOL', callback_data: `sol_buy_amount_${tokenMint}_1.0` }
      ],
      [
        { text: '💎 2.0 SOL', callback_data: `sol_buy_amount_${tokenMint}_2.0` },
        { text: '💎 5.0 SOL', callback_data: `sol_buy_amount_${tokenMint}_5.0` }
      ],
      [{ text: '✏️ Custom Amount', callback_data: `sol_buy_custom_${tokenMint}` }],
      [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
    ];

    await ctx.editMessageText(
      `🟣 **SOL BUY TOKEN**

**Token:** ${tokenMint.slice(0, 8)}...${tokenMint.slice(-4)}
**Your SOL Balance:** ${balance} SOL

Select the amount of SOL to spend:`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error showing SOL buy amount selection:', error);
    await ctx.editMessageText(
      `❌ **Error loading token information**

${error.message}

Please try again.`,
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

// SOL Buy Review - Shows final confirmation before execution
async function showSolBuyReview(ctx, tokenMint, amount) {
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Getting swap quote...**\n\nCalculating best route via Jupiter...');

    const userData = await loadUserData(userId);

    // Get swap quote
    const quote = await solChain.getSwapQuote('sol', tokenMint, amount);

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeCalculation = solChain.calculateFee(amount, feePercent);

    const keyboard = [
      [{ text: '✅ Confirm Purchase', callback_data: `sol_buy_execute_${tokenMint}_${amount}` }],
      [{ text: '🔙 Change Amount', callback_data: `sol_buy_retry_${tokenMint}` }],
      [{ text: '❌ Cancel', callback_data: 'chain_sol' }]
    ];

    await ctx.editMessageText(
      `🟣 **CONFIRM SOL PURCHASE**

**Token:** ${tokenMint.slice(0, 8)}...${tokenMint.slice(-4)}

**Purchase Details:**
💰 SOL Amount: ${amount} SOL
📈 Tokens Expected: ~${parseFloat(quote.amountOut).toFixed(6)}
💸 Service Fee: ${feeCalculation.feeAmount} SOL (${feePercent}%)
💎 Net Trade Amount: ${feeCalculation.netAmount} SOL

**Total Cost:** ${amount} SOL

⚠️ **Important**: This will execute immediately!`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error showing SOL buy review:', error);
    await ctx.editMessageText(
      `❌ **Error getting swap quote**

${error.message}

Please try a different amount or token.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `sol_buy_retry_${tokenMint}` }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        }
      }
    );
  }
}

// SOL Buy Retry Handler
bot.action(/^sol_buy_retry_(.+)$/, async (ctx) => {
  const tokenMint = ctx.match[1];
  await showSolBuyAmountSelection(ctx, tokenMint);
});

// ====================================================================
// SOL SELL FLOW HANDLERS - IMPLEMENTING MISSING FUNCTIONS  
// ====================================================================

// SOL Token Holdings - Shows user's SPL tokens for selling
async function showSolTokenHoldings(ctx, userId) {
  try {
    const userData = await loadUserData(userId);
    const walletAddress = await getSolWalletAddress(userId, userData);

    await ctx.editMessageText('⏳ **Loading your SPL tokens...**\n\nScanning wallet for tokens...');

    const tokenHoldings = await solChain.getTokenHoldings(walletAddress);

    if (tokenHoldings.length === 0) {
      await ctx.editMessageText(
        `🟣 **SOL SELL TOKEN**

❌ No SPL tokens found in your wallet.

Buy some tokens first to start selling!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Buy Tokens', callback_data: 'sol_buy' }],
              [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
            ]
          }
        }
      );
      return;
    }

    // Create buttons for each token (limit to 10 for UI space)
    const keyboard = [];
    const visibleTokens = tokenHoldings.slice(0, 10);

    for (const token of visibleTokens) {
      const displayName = `${token.mint.slice(0, 6)}...${token.mint.slice(-4)}`;
      const balance = token.balance.toFixed(6);

      keyboard.push([{
        text: `🪙 ${displayName} (${balance})`,
        callback_data: `sol_sell_token_${token.mint}`
      }]);
    }

    keyboard.push([{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]);

    let message = `🟣 **SOL SELL TOKEN**

**Your SPL Tokens:**

Select a token to sell:`;

    if (tokenHoldings.length > 10) {
      message += `\n\n*Showing first 10 tokens*`;
    }

    await ctx.editMessageText(message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.log('Error loading SOL token holdings:', error);
    await ctx.editMessageText(
      `❌ **Error loading token holdings**

${error.message}

Please check your wallet connection.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
          ]]
        }
      }
    );
  }
}

// SOL Sell Token Selection Handler
bot.action(/^sol_sell_token_(.+)$/, async (ctx) => {
  const tokenMint = ctx.match[1];
  await showSolSellAmountSelection(ctx, tokenMint);
});

// SOL Sell Amount Selection - Shows percentage buttons for selling
async function showSolSellAmountSelection(ctx, tokenMint) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const walletAddress = await getSolWalletAddress(userId, userData);

    // Get token balance
    const tokenHoldings = await solChain.getTokenHoldings(walletAddress);
    const tokenHolding = tokenHoldings.find(t => t.mint === tokenMint);

    if (!tokenHolding) {
      throw new Error('Token not found in wallet');
    }

    const keyboard = [
      [
        { text: '📈 25%', callback_data: `sol_sell_p_${tokenMint}_25` },
        { text: '📈 50%', callback_data: `sol_sell_p_${tokenMint}_50` }
      ],
      [
        { text: '📈 75%', callback_data: `sol_sell_p_${tokenMint}_75` },
        { text: '📈 100%', callback_data: `sol_sell_p_${tokenMint}_100` }
      ],
      [{ text: '✏️ Custom Amount', callback_data: `sol_sell_c_${tokenMint}` }],
      [{ text: '🔙 Back to Tokens', callback_data: 'sol_sell' }]
    ];

    await ctx.editMessageText(
      `🟣 **SOL SELL TOKEN**

**Token:** ${tokenMint.slice(0, 8)}...${tokenMint.slice(-4)}
**Balance:** ${tokenHolding.balance.toFixed(6)} tokens

Select percentage to sell:`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error showing SOL sell amount selection:', error);
    await ctx.editMessageText(
      `❌ **Error loading token balance**

${error.message}

Please try again.`,
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

// SOL Sell Review - Shows final confirmation before execution
async function showSolSellReview(ctx, tokenMint, amount, amountType) {
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Getting sell quote...**\n\nCalculating best route via Jupiter...');

    const userData = await loadUserData(userId);
    const walletAddress = await getSolWalletAddress(userId, userData);

    // Get token holdings
    const tokenHoldings = await solChain.getTokenHoldings(walletAddress);
    const tokenHolding = tokenHoldings.find(t => t.mint === tokenMint);

    if (!tokenHolding) {
      throw new Error('Token not found in wallet');
    }

    // Calculate sell amount
    let sellAmount;
    if (amountType === 'percent') {
      sellAmount = tokenHolding.balance * (parseInt(amount) / 100);
    } else {
      sellAmount = parseFloat(amount);
    }

    // Get swap quote
    const quote = await solChain.getSwapQuote(tokenMint, 'sol', sellAmount.toString());

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const solReceived = parseFloat(quote.amountOut);
    const feeCalculation = solChain.calculateFee(solReceived, feePercent);

    const keyboard = [
      [{ text: '✅ Confirm Sale', callback_data: `sol_sell_exec_${tokenMint}_${amount}_${amountType}` }],
      [{ text: '🔙 Change Amount', callback_data: `sol_sell_retry_${tokenMint}` }],
      [{ text: '❌ Cancel', callback_data: 'chain_sol' }]
    ];

    await ctx.editMessageText(
      `🟣 **CONFIRM SOL SALE**

**Token:** ${tokenMint.slice(0, 8)}...${tokenMint.slice(-4)}

**Sale Details:**
🪙 Tokens to Sell: ${sellAmount.toFixed(6)}
💰 SOL Expected: ~${solReceived.toFixed(6)} SOL
💸 Service Fee: ${feeCalculation.feeAmount} SOL (${feePercent}%)
💎 Net SOL Received: ${feeCalculation.netAmount} SOL

⚠️ **Important**: This will execute immediately!`,
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.log('Error showing SOL sell review:', error);
    await ctx.editMessageText(
      `❌ **Error getting sell quote**

${error.message}

Please try a different amount.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `sol_sell_token_${tokenMint}` }],
            [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
          ]
        }
      }
    );
  }
}

// ====================================================================
// MISSING SOL BUY/SELL CALLBACK HANDLERS - CRITICAL FOR SOL OPERATION
// ====================================================================

// SOL Buy Amount Selection Handlers
bot.action(/^sol_buy_amount_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenMint = match[1];
  const amount = match[2];
  await showSolBuyReview(ctx, tokenMint, amount);
});

// SOL Buy Custom Amount Handler
bot.action(/^sol_buy_custom_(.+)$/, async (ctx) => {
  const tokenMint = ctx.match[1];
  const userId = ctx.from.id.toString();

  await ctx.editMessageText(
    `🟣 **CUSTOM SOL AMOUNT**

Enter the SOL amount you want to spend:

Example: 0.25

Send your custom amount now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Amount Selection', callback_data: `sol_buy_retry_${tokenMint}` }
        ]]
      }
    }
  );

  userStates.set(userId, {
    action: 'sol_custom_amount',
    tokenAddress: tokenMint,
    timestamp: Date.now()
  });
});

// SOL Buy Execute Handler
bot.action(/^sol_buy_execute_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenMint = match[1];
  const amount = match[2];
  const userId = ctx.from.id.toString();

  try {
    await checkRateLimit(userId, 'transactions');

    await ctx.editMessageText('⏳ **Executing SOL token purchase...**\n\nSwapping via Jupiter...');

    const userData = await loadUserData(userId);
    const wallet = await getSolWalletForTrading(userId, userData);

    // Calculate amounts
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeCalculation = solChain.calculateFee(amount, feePercent);

    // Execute swap
    const swapResult = await solChain.executeSwap(
            wallet.keypair,
      'sol',
      tokenMint,
      feeCalculation.netAmount
    );

    // Collect fee
    let feeResult = null;
    if (parseFloat(feeCalculation.feeAmount) > 0) {
      try {
        feeResult = await solChain.sendFeeToTreasury(wallet.keypair, feeCalculation.feeAmount);
      } catch (feeError) {
        console.log('SOL fee collection failed (non-blocking):', feeError.message);
      }
    }

    // Record transaction
    await recordTransaction(userId, {
      type: 'buy',
      tokenAddress: tokenMint,
      amount: amount,
      tradeAmount: feeCalculation.netAmount,
      feeAmount: feeCalculation.feeAmount,
      txHash: swapResult.signature,
      feeHash: feeResult?.signature || null,
      timestamp: Date.now(),
      chain: 'solana'
    });

    await ctx.editMessageText(
      `✅ **SOL PURCHASE SUCCESSFUL!**

**Trade Amount:** ${feeCalculation.netAmount} SOL → SPL Token
**Service Fee:** ${feeCalculation.feeAmount} SOL
**Total Cost:** ${amount} SOL

**Transaction:** [View on Solscan](https://solscan.io/tx/${swapResult.signature})
**Signature:** \`${swapResult.signature}\`

🎉 Your tokens should appear in your wallet shortly!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Buy More', callback_data: 'sol_buy' }],
            [{ text: '📈 Sell Tokens', callback_data: 'sol_sell' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`Successful SOL buy: User ${userId}, Token ${tokenMint}, Amount ${amount} SOL`);

  } catch (error) {
    logger.error(`SOL buy execution error for user ${userId}:`, error);

    await ctx.editMessageText(
      `❌ **PURCHASE FAILED**

**Error:** ${error.message}

Your funds are safe - no transaction was completed.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `sol_buy_retry_${tokenMint}` }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
});

// SOL Sell Percentage Handlers
bot.action(/^sol_sell_p_(.+)_(.+)$/, async (ctx) => {
  const tokenMint = ctx.match[1];
  const percentage = ctx.match[2];

  await showSolSellReview(ctx, tokenMint, percentage, 'percent');
});

// SOL Sell Custom Amount Handler
bot.action(/^sol_sell_c_(.+)$/, async (ctx) => {
  const tokenMint = ctx.match[1];
  const userId = ctx.from.id.toString();

  await ctx.editMessageText(
    `📈 **CUSTOM SELL AMOUNT**

Enter the exact amount of tokens you want to sell:

Example: 1000 (for 1,000 tokens)
Example: 0.5 (for 0.5 tokens)

Send your custom amount now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Amount Selection', callback_data: `sol_sell_token_${tokenMint}` }
        ]]
      }
    }
  );

  userStates.set(userId, {
    action: 'sol_sell_custom_amount',
    tokenAddress: tokenMint,
    timestamp: Date.now()
  });
});

// SOL Sell Retry Handler
bot.action(/^sol_sell_retry_(.+)$/, async (ctx) => {
  const tokenMint = ctx.match[1];
  await showSolSellAmountSelection(ctx, tokenMint);
});

// Add missing reply version function
async function showSolSellAmountSelectionReply(ctx, tokenMint) {
  // This is just a wrapper that calls the main function
  await showSolSellAmountSelection(ctx, tokenMint);
}

// SOL Sell Execution Handler
bot.action(/^sol_sell_exec_(.+)_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenMint = match[1];
  const amount = match[2];
  const amountType = match[3];
  const userId = ctx.from.id.toString();

  try {
    await checkRateLimit(userId, 'transactions');

    await ctx.editMessageText('⏳ **Executing SOL token sale...**\n\nSwapping via Jupiter...');

    const userData = await loadUserData(userId);
    const wallet = await getSolWalletForTrading(userId, userData);

    // Get token holdings
    const tokenHoldings = await solChain.getTokenHoldings(wallet.address);
    const tokenHolding = tokenHoldings.find(t => t.mint === tokenMint);

    if (!tokenHolding) {
      throw new Error('Token not found in wallet');
    }

    // Calculate sell amount
    let sellAmount;
    if (amountType === 'percent') {
      sellAmount = tokenHolding.balance * (parseInt(amount) / 100);
    } else {
      sellAmount = parseFloat(amount);
    }

    // Execute swap
    const swapResult = await solChain.executeSwap(
      wallet.keypair,
      tokenMint,
      'sol',
      sellAmount.toString()
    );

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const solReceived = parseFloat(swapResult.outputAmount);
    const feeCalculation = solChain.calculateFee(solReceived, feePercent);

    // Collect fee
    let feeResult = null;
    if (parseFloat(feeCalculation.feeAmount) > 0) {
      try {
        feeResult = await solChain.sendFeeToTreasury(wallet.keypair, feeCalculation.feeAmount);
      } catch (feeError) {
        console.log('SOL sell fee collection failed (non-blocking):', feeError.message);
      }
    }

    // Record transaction
    await recordTransaction(userId, {
      type: 'sell',
      tokenAddress: tokenMint,
      amount: sellAmount.toString(),
      outputAmount: solReceived.toString(),
      feeAmount: feeCalculation.feeAmount,
      txHash: swapResult.signature,
      feeHash: feeResult?.signature || null,
      timestamp: Date.now(),
      chain: 'solana'
    });

    await ctx.editMessageText(
      `✅ **SOL SELL SUCCESSFUL!**

**Tokens Sold:** ${sellAmount.toFixed(6)} tokens
**SOL Received:** ${feeCalculation.netAmount} SOL
**Service Fee:** ${feeCalculation.feeAmount} SOL
**Total Received:** ${solReceived.toFixed(6)} SOL

**Transaction:** [View on Solscan](https://solscan.io/tx/${swapResult.signature})
**Signature:** \`${swapResult.signature}\`

💰 SOL has been added to your wallet!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📈 Sell More', callback_data: 'sol_sell' }],
            [{ text: '💰 Buy Tokens', callback_data: 'sol_buy' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );

    logger.info(`Successful SOL sell: User ${userId}, Token ${tokenMint}, Amount ${sellAmount} tokens`);

  } catch (error) {
    logger.error(`SOL sell execution error for user ${userId}:`, error);

    await ctx.editMessageText(
      `❌ **SELL FAILED**

**Error:** ${error.message}

Your tokens are safe - no transaction was completed.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `sol_sell_token_${tokenMint}` }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      }
    );
  }
});

// ====================================================================
// MISSING SOL BUY/SELL CALLBACK HANDLERS - CRITICAL FOR SOL OPERATION
// ====================================================================