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

// ETH Buy amount handlers
bot.action(/^eth_buy_amount_(.+)_(.+)$/, handleEthBuyAmount);
bot.action(/^eth_buy_execute_(.+)_(.+)$/, handleEthBuyExecute);

// ETH Sell handlers
bot.action(/^eth_sell_token_(.+)$/, handleEthSellToken);
bot.action(/^eth_sell_percentage_(.+)_(.+)$/, handleEthSellPercentage);
bot.action(/^eth_sell_execute_(.+)_(.+)_(.+)$/, handleEthSellExecute);

// Wallet management handlers
bot.action('eth_wallet_import', handleEthWalletImport);
bot.action('eth_wallet_generate', handleEthWalletGenerate);
bot.action('eth_wallet_view', handleEthWalletView);

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
    if (!checkRateLimit(userId)) {
      await ctx.answerCbQuery('⚠️ Rate limit exceeded. Please wait before making another request.', { show_alert: true });
      return;
    }
    updateRateLimit(userId);
    
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
    if (!checkRateLimit(userId)) {
      await ctx.answerCbQuery('⚠️ Rate limit exceeded. Please wait before making another request.', { show_alert: true });
      return;
    }
    updateRateLimit(userId);
    
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

  } catch (error) {
    logger.error('Failed to start bot:', error);
    console.log('❌ Bot startup failed:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ====================================================================
// TEXT MESSAGE HANDLERS
// ====================================================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = userStates.get(userId);
  
  if (!userState) return;
  
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
        await handleCustomAmount(ctx, userId, userState.tokenAddress);
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

// Custom amount handler - will process custom ETH amounts
async function handleCustomAmount(ctx, userId, tokenAddress) {
  const amount = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error('Invalid amount. Please enter a positive number.');
    }

    // Continue with buy flow using custom amount
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const shortId = storeTokenMapping(tokenAddress);
    
    // Simulate the amount selection
    await handleEthBuyAmount({
      match: [null, amountFloat.toString(), shortId],
      from: { id: parseInt(userId) },
      answerCbQuery: async (msg, opts) => {},
      editMessageText: async (text, opts) => {
        await ctx.reply(text, opts);
      }
    });

  } catch (error) {
    userStates.delete(userId);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// Start the bot
startBot();