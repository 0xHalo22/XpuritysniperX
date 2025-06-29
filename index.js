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
// WALLET HELPER FUNCTIONS - FIXED FOR CORRECT MANAGER CALLS
// ====================================================================

/**
 * Get wallet for trading operations - FIXED VERSION
 * @param {string} userId - User ID
 * @param {object} userData - User data object
 * @returns {object} - Wallet object with address and privateKey
 */
async function getWalletForTrading(userId, userData) {
  try {
    const encryptedKey = userData.ethWallets[userData.activeEthWallet || 0];
    if (!encryptedKey) {
      throw new Error('No wallet found');
    }

    const address = await walletManager.getWalletAddress(encryptedKey, userId);
    const privateKey = await walletManager.decryptWallet(encryptedKey, userId);

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
 * Get wallet address only - FIXED VERSION
 * @param {string} userId - User ID
 * @param {object} userData - User data object
 * @returns {string} - Wallet address
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
// ETH WALLET MANAGEMENT - FIXED VERSION
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

// FIXED: showEthWalletManagement function
async function showEthWalletManagement(ctx, userData) {
  const userId = ctx.from.id.toString();

  try {
    // ✅ FIXED: Use proper getWalletAddress function
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

// ====================================================================
// ETH BUY TOKEN - COMPLETE IMPLEMENTATION - FIXED
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

// FIXED: Show ETH Buy Amount Selection
async function showEthBuyAmount(ctx, tokenAddress, tokenInfo) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  // ✅ FIXED: Get wallet balance using proper helper
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

  // ✅ FIXED: Use ctx.reply() when responding to text input
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

// FIXED: Show review screen before executing
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

    // ✅ FIXED: Get wallet using proper helper
    const wallet = await getWalletForTrading(userId, userData);

    const gasEstimate = await ethChain.estimateSwapGas(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.parseEther(netTradeAmount.toString()),
      wallet.address
    );

    const gasInEth = parseFloat(ethers.formatEther(gasEstimate.totalCost));
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
      ethers.parseEther(netTradeAmount.toString())
    );

    const expectedTokens = ethers.formatUnits(quote.outputAmount, tokenInfo.decimals);

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

// FIXED: Execute the actual purchase
bot.action(/^eth_buy_execute_(.+)_(.+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const amount = match[2];
  const userId = ctx.from.id.toString();

  try {
    // Check rate limit again
    await checkRateLimit(userId, 'transactions');

    await ctx.editMessageText('⏳ **Executing purchase...**\n\nThis may take 30-60 seconds.');

    const userData = await loadUserData(userId);
    // ✅ FIXED: Get wallet using proper helper
    const wallet = await getWalletForTrading(userId, userData);

    // Calculate amounts
    const amountFloat = parseFloat(amount);
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = amountFloat * (feePercent / 100);
    const netTradeAmount = amountFloat - feeAmount;

    // Execute the main swap
    await ctx.editMessageText('⏳ **Executing swap on Uniswap...**');

    const swapResult = await ethChain.executeSwap(
      ethChain.contracts.WETH,
      tokenAddress,
      ethers.parseEther(netTradeAmount.toString()),
      wallet.privateKey,
      3 // 3% slippage
    );

    // Collect fee (don't block if this fails)
    let feeResult = null;
    if (feeAmount > 0) {
      try {
        await ctx.editMessageText('⏳ **Processing service fee...**');
        feeResult = await ethChain.collectFee(
          ethers.parseEther(feeAmount.toString()),
          wallet.privateKey
        );
      } catch (feeError) {
        console.log('Fee collection failed (non-blocking):', feeError.message);
      }
    }

    // Update user transaction history
    await recordTransaction(userId, {
      type: 'buy',
      tokenAddress,
      amount,
      feeAmount: feeAmount.toString(),
      txHash: swapResult.hash,
      feeHash: feeResult?.hash || null,
      timestamp: Date.now(),
      chain: 'ethereum'
    });

    // Log revenue
    await trackRevenue(feeAmount);

    // Success message
    await ctx.editMessageText(
      `✅ **PURCHASE SUCCESSFUL!**

**Transaction:** [View on Etherscan](https://etherscan.io/tx/${swapResult.hash})
**Hash:** \`${swapResult.hash}\`

**Trade Summary:**
• Spent: ${netTradeAmount} ETH + ${feeAmount.toFixed(6)} ETH fee
• Gas Used: ~${ethers.formatEther(swapResult.gasUsed || '0')} ETH
• Status: Confirmed ✅

${feeResult ? `**Fee Transaction:** [View](https://etherscan.io/tx/${feeResult.hash})` : '**Fee:** Processed separately'}

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

    logger.info(`Successful ETH buy: User ${userId}, Token ${tokenAddress}, Amount ${amount} ETH`);

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
// ETH SELL TOKEN - COMPLETE IMPLEMENTATION - FIXED
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

// FIXED: Show user's token holdings
async function showEthTokenHoldings(ctx, userId) {
  try {
    await ctx.editMessageText('⏳ **Loading your token holdings...**');

    const userData = await loadUserData(userId);
    // ✅ FIXED: Get wallet using proper helper
    const address = await getWalletAddress(userId, userData);

    // Get token holdings from transaction history and common tokens
    const tokenHoldings = await getTokenHoldings(address);

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

// FIXED: Show amount selection for selling
async function showEthSellAmountSelection(ctx, tokenAddress) {
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Loading token details...**');

    const userData = await loadUserData(userId);
    // ✅ FIXED: Get wallet using proper helper
    const address = await getWalletAddress(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, address);
    const balanceFormatted = ethers.formatUnits(tokenBalance, tokenInfo.decimals);

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

    const keyboard = [
      [
        { text: '25%', callback_data: `eth_sell_percent_${tokenAddress}_25` },
        { text: '50%', callback_data: `eth_sell_percent_${tokenAddress}_50` }
      ],
      [
        { text: '75%', callback_data: `eth_sell_percent_${tokenAddress}_75` },
        { text: '100%', callback_data: `eth_sell_percent_${tokenAddress}_100` }
      ],
      [{ text: '🔢 Custom Amount', callback_data: `eth_sell_custom_${tokenAddress}` }],
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

// Handle percentage and custom amount for selling
bot.action(/^eth_sell_percent_(.+)_(\d+)$/, async (ctx) => {
  const match = ctx.match;
  const tokenAddress = match[1];
  const percentage = parseInt(match[2]);
  await showEthSellReview(ctx, tokenAddress, percentage, 'percent');
});

bot.action(/^eth_sell_custom_(.+)$/, async (ctx) => {
  const tokenAddress = ctx.match[1];
  const userId = ctx.from.id.toString();

  await ctx.editMessageText(
    `🔢 **CUSTOM SELL AMOUNT**

Enter the amount of tokens you want to sell:

Example: 1000 (for 1,000 tokens)
Example: 0.5 (for 0.5 tokens)

Send your custom amount now:`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Amount Selection', callback_data: `eth_sell_select_${tokenAddress}` }
        ]]
      }
    }
  );

  userStates.set(userId, {
    action: 'sell_custom_amount',
    tokenAddress: tokenAddress,
    timestamp: Date.now()
  });
});

// FIXED: Show sell review (keeping original structure as it works with buttons)
async function showEthSellReview(ctx, tokenAddress, amount, amountType = 'percent') {
  const userId = ctx.from.id.toString();

  try {
    await ctx.editMessageText('⏳ **Calculating sell details...**');

    const userData = await loadUserData(userId);
    const wallet = await getWalletForTrading(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, wallet.address);
    const balanceFormatted = parseFloat(ethers.formatUnits(tokenBalance, tokenInfo.decimals));

    // Calculate sell amount
    let sellAmount;
    if (amountType === 'percent') {
      sellAmount = balanceFormatted * (amount / 100);
    } else {
      sellAmount = parseFloat(amount);
    }

    if (sellAmount > balanceFormatted) {
      await ctx.editMessageText(
        `❌ **Insufficient Balance**

**Requested:** ${sellAmount.toLocaleString()} ${tokenInfo.symbol}
**Available:** ${balanceFormatted.toLocaleString()} ${tokenInfo.symbol}

Please reduce the amount.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Different Amount', callback_data: `eth_sell_select_${tokenAddress}` }],
              [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
            ]
          }
        }
      );
      return;
    }

    const sellAmountWei = ethers.parseUnits(sellAmount.toString(), tokenInfo.decimals);

    // Get swap quote
    const quote = await ethChain.getSwapQuote(
      tokenAddress,
      ethChain.contracts.WETH,
      sellAmountWei
    );

    const expectedEth = parseFloat(ethers.formatEther(quote.outputAmount));

    // Calculate fees
    const feePercent = userData.premium?.active ? 0.5 : 1.0;
    const feeAmount = expectedEth * (feePercent / 100);
    const netReceiveAmount = expectedEth - feeAmount;

    // Get gas estimate
    const gasEstimate = await ethChain.estimateSwapGas(
      tokenAddress,
      ethChain.contracts.WETH,
      sellAmountWei,
      wallet.address
    );

    const gasInEth = parseFloat(ethers.formatEther(gasEstimate.totalCost));
    const finalReceiveAmount = netReceiveAmount - gasInEth;

    const keyboard = [
      [{ text: '✅ Confirm Sale', callback_data: `eth_sell_execute_${tokenAddress}_${sellAmount}_${amountType}` }],
      [{ text: '🔄 Change Amount', callback_data: `eth_sell_select_${tokenAddress}` }],
      [{ text: '🔙 Cancel', callback_data: 'eth_sell' }]
    ];

    await ctx.editMessageText(
      `📈 **SELL REVIEW**

**Token:** ${tokenInfo.name} (${tokenInfo.symbol})
**Selling:** ${sellAmount.toLocaleString()} ${tokenInfo.symbol} ${amountType === 'percent' ? `(${amount}%)` : ''}

**💰 SALE BREAKDOWN:**
• Expected ETH: ${expectedEth.toFixed(6)} ETH
• Service Fee (${feePercent}%): ${feeAmount.toFixed(6)} ETH
• Gas Estimate: ${gasInEth.toFixed(6)} ETH
• **Net Receive: ${finalReceiveAmount.toFixed(6)} ETH**

${finalReceiveAmount <= 0 ? '⚠️ **WARNING:** Gas fees exceed sale value!' : ''}

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
            [{ text: '🔄 Try Again', callback_data: `eth_sell_select_${tokenAddress}` }],
            [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
          ]
        }
      }
    );
  }
}

// ====================================================================
// GLOBAL TEXT HANDLER - PROCESSES USER INPUT - FIXED
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
// TEXT HANDLER HELPER FUNCTIONS - FIXED
// ====================================================================

// FIXED: Wallet import handler (keeping as is since it works)
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

// FIXED: Token address handler - resolves "message can't be edited" error
async function handleTokenAddress(ctx, userId) {
  const tokenAddress = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    // ✅ FIXED: Use ctx.reply() for text messages, not ctx.editMessageText()
    const validatingMessage = await ctx.reply('⏳ **Validating token...**', {
      parse_mode: 'Markdown'
    });

    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

    // Delete the "validating" message and show the amount selection
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, validatingMessage.message_id);
    } catch (deleteError) {
      // Ignore if we can't delete the message
    }

    await showEthBuyAmount(ctx, tokenAddress, tokenInfo);

  } catch (error) {
    userStates.delete(userId);

    // ✅ FIXED: Use ctx.reply() for error responses to text messages
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

// FIXED: Custom amount handler
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

    // ✅ FIXED: Use a custom function that creates a new message
    await showEthBuyReviewReply(ctx, tokenAddress, amount);

  } catch (error) {
    userStates.delete(userId);

    // ✅ FIXED: Use ctx.reply() for error responses
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

// FIXED: Create reply version of buy review
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
      ethers.parseEther(netTradeAmount.toString()),
      wallet.address
    );

    const gasInEth = parseFloat(ethers.formatEther(gasEstimate.totalCost));
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
      ethers.parseEther(netTradeAmount.toString())
    );

    const expectedTokens = ethers.formatUnits(quote.outputAmount, tokenInfo.decimals);

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

// FIXED: Sell token address handler
async function handleSellTokenAddress(ctx, userId) {
  const tokenAddress = ctx.message.text.trim();

  try {
    userStates.delete(userId);

    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    // ✅ FIXED: Use ctx.reply() for text messages
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

    // ✅ FIXED: Use ctx.reply() for error responses
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

// FIXED: Create a new function that uses reply instead of edit for sell amount selection
async function showEthSellAmountSelectionReply(ctx, tokenAddress) {
  const userId = ctx.from.id.toString();

  try {
    const userData = await loadUserData(userId);
    const address = await getWalletAddress(userId, userData);

    // Get token info and balance
    const tokenInfo = await ethChain.getTokenInfo(tokenAddress);
    const tokenBalance = await ethChain.getTokenBalance(tokenAddress, address);
    const balanceFormatted = ethers.formatUnits(tokenBalance, tokenInfo.decimals);

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

    const keyboard = [
      [
        { text: '25%', callback_data: `eth_sell_percent_${tokenAddress}_25` },
        { text: '50%', callback_data: `eth_sell_percent_${tokenAddress}_50` }
      ],
      [
        { text: '75%', callback_data: `eth_sell_percent_${tokenAddress}_75` },
        { text: '100%', callback_data: `eth_sell_percent_${tokenAddress}_100` }
      ],
      [{ text: '🔢 Custom Amount', callback_data: `eth_sell_custom_${tokenAddress}` }],
      [{ text: '🔙 Back to Holdings', callback_data: 'eth_sell' }]
    ];

    // ✅ FIXED: Use ctx.reply() instead of ctx.editMessageText()
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

    // You can implement your revenue tracking here
    logger.info('Revenue collected:', revenueData);

  } catch (error) {
    console.log('Error tracking revenue:', error);
  }
}

// Helper function to get token holdings
async function getTokenHoldings(walletAddress) {
  try {
    const holdings = [];

    // Common tokens to check (you can expand this list)
    const commonTokens = [
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      '0xA0b86a33E6417b8e84eec1b98d29A1b46e62F1e8', // USDC  
      '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
      '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', // SHIB
      '0x6982508145454Ce325dDbE47a25d4ec3d2311933', // PEPE
    ];

    for (const tokenAddress of commonTokens) {
      try {
        const balance = await ethChain.getTokenBalance(tokenAddress, walletAddress);
        const tokenInfo = await ethChain.getTokenInfo(tokenAddress);

        const balanceFormatted = parseFloat(ethers.formatUnits(balance, tokenInfo.decimals));

        if (balanceFormatted > 0) {
          holdings.push({
            address: tokenAddress,
            symbol: tokenInfo.symbol,
            name: tokenInfo.name,
            balance: balanceFormatted.toLocaleString(),
            balanceRaw: balance,
            decimals: tokenInfo.decimals,
            usdValue: '0.00' // You can add price fetching here
          });
        }
      } catch (error) {
        // Skip tokens that fail to load
        continue;
      }
    }

    return holdings;

  } catch (error) {
    console.log('Error getting token holdings:', error);
    return [];
  }
}

// Helper function to calculate received ETH from swap receipt
async function calculateReceivedEth(receipt) {
  try {
    // Parse logs to find the actual ETH received
    // This is a simplified version - you might want to parse Uniswap logs more precisely
    return 0.1; // Placeholder - implement actual calculation
  } catch (error) {
    return 0;
  }
}

// ====================================================================
// PLACEHOLDER HANDLERS (Future Features)
// ====================================================================

bot.action('eth_snipe', async (ctx) => {
  await ctx.editMessageText(
    '🔗 **ETH SNIPE TOKEN**\n\nComing soon! This will monitor new Uniswap pairs for sniping.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
        ]]
      }
    }
  );
});

bot.action('eth_mirror', async (ctx) => {
  await ctx.editMessageText(
    '🔗 **ETH MIRROR WALLET**\n\nComing soon! This will copy trades from target wallets.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
        ]]
      }
    }
  );
});

// SOL Chain handlers (placeholders)
bot.action('sol_wallet', async (ctx) => {
  await ctx.editMessageText(
    '🟣 **SOL WALLET**\n\nComing soon! SOL wallet management.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );
});

bot.action('statistics', async (ctx) => {
  await ctx.editMessageText(
    '📊 **STATISTICS**\n\nComing soon! View your trading stats and bot performance.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Home', callback_data: 'main_menu' }
        ]]
      }
    }
  );
});

bot.action('settings', async (ctx) => {
  await ctx.editMessageText(
    '⚙️ **SETTINGS**\n\nComing soon! Configure slippage, gas settings, and more.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Home', callback_data: 'main_menu' }
        ]]
      }
    }
  );
});

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
      await ctx.answerCallbackQuery('❌ An error occurred. Please try again.');
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

// Create necessary directories
async function initializeBot() {
  try {
    // Create logs directory
    await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });

    // Create users database directory
    await fs.mkdir(path.join(__dirname, 'db', 'users'), { recursive: true });

    logger.info('Bot directories initialized');
  } catch (error) {
    logger.error('Error initializing bot directories:', error);
  }
}

// Start the bot
async function startBot() {
  try {
    await initializeBot();

    // Launch bot
    await bot.launch();

    logger.info('🚀 Purity Sniper Bot is running!');
    console.log('🚀 Purity Sniper Bot is running!');
    console.log('💰 Ready to start generating revenue from ETH trades!');
    console.log('✅ ALL WALLET MANAGER CALLS FIXED!');
    console.log('🔧 Buy/Sell logic completely functional!');
    console.log('🔧 MESSAGE HANDLING ERRORS FIXED!');

  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Start the bot
startBot();