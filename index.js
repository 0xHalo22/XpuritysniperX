require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const winston = require('winston');

// Import our modules
const WalletManager = require('./wallets/manager');
const EthChain = require('./chains/eth');
const SolChain = require('./chains/sol');
const { loadUserData, saveUserData } = require('./utils/storage');
const { checkRateLimit, logTransaction } = require('./utils/security');

// Initialize logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const walletManager = new WalletManager();
const ethChain = new EthChain();
const solChain = new SolChain();

// Health check server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

app.listen(PORT, () => {
  logger.info(`Health check server running on port ${PORT}`);
});

// Bot middleware for error handling
bot.catch((err, ctx) => {
  logger.error('Bot error:', err);
  ctx.reply('❌ Something went wrong. Please try again.');
});

// Welcome message and main menu
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  logger.info(`New user started bot: ${userId}`);

  await showMainMenu(ctx);
});

// Main menu display function
async function showMainMenu(ctx) {
  const keyboard = [
    [
      { text: '○ ETH', callback_data: 'chain_eth' },
      { text: '○ SOL', callback_data: 'chain_sol' }
    ],
    [
      { text: '○ Statistics', callback_data: 'stats' },
      { text: '○ Settings', callback_data: 'settings' }
    ]
  ];

  const message = `❕ *WELCOME BACK* @ PURITY SNIPER BOT - 1.0 - A Pure Sniping Experience. 

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

// ETH Chain Menu
async function showEthMenu(ctx) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

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
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

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

// ETH Wallet Management
async function showEthWallet(ctx) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  if (!userData.ethWallets || userData.ethWallets.length === 0) {
    await showEthWalletSetup(ctx);
  } else {
    await showEthWalletManagement(ctx, userData);
  }
}

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
  const activeWallet = userData.ethWallets[userData.activeEthWallet || 0];
  const address = await walletManager.getWalletAddress(activeWallet, ctx.from.id.toString());
  const balance = await ethChain.getBalance(address);

  const keyboard = [
    [{ text: '💰 View Balance', callback_data: 'eth_view_balance' }],
    [{ text: '➕ Add Wallet', callback_data: 'import_eth_wallet' }],
    [{ text: '🔄 Switch Wallet', callback_data: 'switch_eth_wallet' }],
    [{ text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }]
  ];

  await ctx.editMessageText(
    `🔗 **ETH WALLET**

Address: ${address.slice(0, 6)}...${address.slice(-4)}
Balance: ${balance} ETH

Active Wallet: ${(userData.activeEthWallet || 0) + 1}/${userData.ethWallets.length}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// SOL Wallet Management
async function showSolWallet(ctx) {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  if (!userData.solWallets || userData.solWallets.length === 0) {
    await showSolWalletSetup(ctx);
  } else {
    await showSolWalletManagement(ctx, userData);
  }
}

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

async function showSolWalletManagement(ctx, userData) {
  // Placeholder until we implement SOL wallet management
  const keyboard = [
    [{ text: '💰 View Balance', callback_data: 'sol_view_balance' }],
    [{ text: '➕ Add Wallet', callback_data: 'import_sol_wallet' }],
    [{ text: '🔄 Switch Wallet', callback_data: 'switch_sol_wallet' }],
    [{ text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }]
  ];

  await ctx.editMessageText(
    `🟣 **SOL WALLET**

Address: Coming soon...
Balance: Coming soon...

SOL wallet management will be implemented next!`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// Navigation handlers
bot.action('main_menu', showMainMenu);
bot.action('chain_eth', showEthMenu);
bot.action('chain_sol', showSolMenu);

// ETH Chain handlers
bot.action('eth_wallet', showEthWallet);
bot.action('eth_buy', async (ctx) => {
  await ctx.editMessageText(
    '🔗 **ETH BUY TOKEN**\n\nComing soon! This will allow you to buy any ERC-20 token.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
        ]]
      }
    }
  );
});

bot.action('eth_sell', async (ctx) => {
  await ctx.editMessageText(
    '🔗 **ETH SELL TOKEN**\n\nComing soon! This will show your token holdings for selling.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to ETH Menu', callback_data: 'chain_eth' }
        ]]
      }
    }
  );
});

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

// SOL Chain handlers
bot.action('sol_wallet', showSolWallet);
bot.action('sol_buy', async (ctx) => {
  await ctx.editMessageText(
    '🟣 **SOL BUY TOKEN**\n\nComing soon! This will allow you to buy any SPL token.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );
});

bot.action('sol_sell', async (ctx) => {
  await ctx.editMessageText(
    '🟣 **SOL SELL TOKEN**\n\nComing soon! This will show your token holdings for selling.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );
});

bot.action('sol_snipe', async (ctx) => {
  await ctx.editMessageText(
    '🟣 **SOL SNIPE TOKEN**\n\nComing soon! This will monitor new Raydium pairs for sniping.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );
});

bot.action('sol_mirror', async (ctx) => {
  await ctx.editMessageText(
    '🟣 **SOL MIRROR WALLET**\n\nComing soon! This will copy trades from target wallets.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );
});

// Import wallet handlers
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

  // Set up listener for ETH private key
  bot.on('text', async (textCtx) => {
    if (textCtx.from.id === ctx.from.id) {
      const privateKey = textCtx.message.text.trim();

      try {
        // Validate and encrypt private key
        const encryptedKey = await walletManager.importWallet(privateKey, userId);

        // Save to user data
        const userData = await loadUserData(userId);
        if (!userData.ethWallets) userData.ethWallets = [];
        userData.ethWallets.push(encryptedKey);
        userData.activeEthWallet = userData.ethWallets.length - 1;
        await saveUserData(userId, userData);

        // Delete user's private key message
        try {
          await textCtx.deleteMessage();
        } catch (e) {
          // Ignore if can't delete
        }

        // Success message
        const address = await walletManager.getWalletAddress(encryptedKey, userId);
        await textCtx.reply(
          `✅ **ETH WALLET IMPORTED**

Address: ${address}
Wallet ${userData.ethWallets.length} added successfully!

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
        await textCtx.reply('❌ Invalid ETH private key. Please try again.');
      }
    }
  });
});

bot.action('import_sol_wallet', async (ctx) => {
  await ctx.editMessageText(
    '🟣 **SOL WALLET IMPORT**\n\nComing soon! SOL wallet import functionality.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to SOL Menu', callback_data: 'chain_sol' }
        ]]
      }
    }
  );
});

// Navigation
bot.action('main_menu', showMainMenu);

// Statistics
bot.action('stats', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  const stats = {
    totalTrades: userData.transactions?.length || 0,
    totalVolume: userData.transactions?.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0) || 0,
    totalFees: userData.transactions?.reduce((sum, tx) => sum + parseFloat(tx.fee || 0), 0) || 0
  };

  await ctx.editMessageText(
    `📊 STATISTICS

🏆 Total Trades: ${stats.totalTrades}
💰 Total Volume: $${stats.totalVolume.toFixed(2)}
💸 Total Fees Paid: $${stats.totalFees.toFixed(2)}

📈 Performance coming in v1.1!`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Home', callback_data: 'main_menu' }
        ]]
      }
    }
  );
});

// Settings
bot.action('settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = await loadUserData(userId);

  const settings = userData.settings || {
    slippage: 3,
    gasMultiplier: 1.2,
    snipeStrategy: 'both'
  };

  const keyboard = [
    [{ text: `⚡ Slippage: ${settings.slippage}%`, callback_data: 'set_slippage' }],
    [{ text: `⛽ Gas: ${settings.gasMultiplier}x`, callback_data: 'set_gas' }],
    [{ text: `🎯 Snipe: ${settings.snipeStrategy}`, callback_data: 'set_strategy' }],
    [{ text: '🔙 Back to Home', callback_data: 'main_menu' }]
  ];

  await ctx.editMessageText(
    `⚙️ SETTINGS

Current Configuration:
⚡ Slippage Tolerance: ${settings.slippage}%
⛽ Gas Multiplier: ${settings.gasMultiplier}x
🎯 Snipe Strategy: ${settings.snipeStrategy}

Tap to modify:`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
});

// Error handling for unknown actions
bot.on('callback_query', async (ctx) => {
  if (!ctx.callbackQuery.data) return;

  // If we get here, it's an unhandled callback
  await ctx.answerCbQuery('Feature coming soon! 🚀');
});

// Launch bot
bot.launch().then(() => {
  logger.info('Purity Sniper Bot launched successfully! 🚀');
}).catch((error) => {
  logger.error('Failed to launch bot:', error);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));