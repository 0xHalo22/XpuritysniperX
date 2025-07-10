
const { ethers } = require('ethers');
const EthChain = require('../chains/eth');
const SolChain = require('../chains/sol');
const { getUser, saveUser, addTransaction } = require('./database');

class MirrorTradingSystem {
  constructor() {
    this.ethChain = new EthChain();
    this.solChain = new SolChain();
    this.activeMirrors = new Map(); // userId -> mirror config
    this.monitoredWallets = new Map(); // walletAddress -> Set of userIds
  }

  /**
   * Start mirroring a target wallet
   * @param {string} userId - User ID starting the mirror
   * @param {string} targetWallet - Wallet address to mirror
   * @param {object} config - Mirror configuration
   */
  async startMirrorTrading(userId, targetWallet, config) {
    try {
      // Validate target wallet
      const isValidEth = ethers.isAddress(targetWallet);
      const isValidSol = this.solChain.isValidAddress(targetWallet);
      
      if (!isValidEth && !isValidSol) {
        throw new Error('Invalid wallet address format');
      }

      const chain = isValidEth ? 'ethereum' : 'solana';
      
      // Default configuration
      const mirrorConfig = {
        targetWallet: targetWallet,
        chain: chain,
        copyPercentage: config.copyPercentage || 100, // 100% = same amount
        maxAmount: config.maxAmount || 1.0, // Max 1 ETH/SOL per trade
        enabledTokens: config.enabledTokens || 'all', // 'all' or specific token list
        slippage: config.slippage || 5,
        active: true,
        startedAt: Date.now()
      };

      // Store mirror configuration
      this.activeMirrors.set(userId, mirrorConfig);

      // Add user to wallet monitoring
      if (!this.monitoredWallets.has(targetWallet)) {
        this.monitoredWallets.set(targetWallet, new Set());
      }
      this.monitoredWallets.get(targetWallet).add(userId);

      // Start monitoring based on chain
      if (chain === 'ethereum') {
        await this.startEthWalletMonitoring(targetWallet);
      } else {
        await this.startSolWalletMonitoring(targetWallet);
      }

      console.log(`🪞 Started mirroring ${targetWallet} for user ${userId} on ${chain}`);
      return mirrorConfig;

    } catch (error) {
      console.log(`❌ Failed to start mirror trading: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stop mirroring for a user
   * @param {string} userId - User ID to stop mirroring
   */
  async stopMirrorTrading(userId) {
    try {
      const mirrorConfig = this.activeMirrors.get(userId);
      if (!mirrorConfig) {
        return; // Not mirroring
      }

      const targetWallet = mirrorConfig.targetWallet;
      
      // Remove user from wallet monitoring
      const walletUsers = this.monitoredWallets.get(targetWallet);
      if (walletUsers) {
        walletUsers.delete(userId);
        
        // If no more users monitoring this wallet, stop monitoring
        if (walletUsers.size === 0) {
          this.monitoredWallets.delete(targetWallet);
          // Stop provider monitoring would go here
        }
      }

      // Remove user's mirror config
      this.activeMirrors.delete(userId);

      console.log(`🛑 Stopped mirroring for user ${userId}`);

    } catch (error) {
      console.log(`❌ Error stopping mirror trading: ${error.message}`);
    }
  }

  /**
   * Start monitoring Ethereum wallet
   * @param {string} walletAddress - ETH wallet to monitor
   */
  async startEthWalletMonitoring(walletAddress) {
    try {
      const provider = await this.ethChain.getProvider();

      // Monitor all transactions from this wallet
      const filter = {
        fromBlock: 'latest',
        address: null,
        topics: null
      };

      // Listen for new blocks and check transactions
      provider.on('block', async (blockNumber) => {
        try {
          const block = await provider.getBlockWithTransactions(blockNumber);
          
          for (const tx of block.transactions) {
            if (tx.from.toLowerCase() === walletAddress.toLowerCase()) {
              await this.processMirrorTransaction(tx, 'ethereum');
            }
          }
        } catch (blockError) {
          console.log(`Error processing block ${blockNumber}:`, blockError.message);
        }
      });

      console.log(`👁️ Started monitoring ETH wallet: ${walletAddress}`);

    } catch (error) {
      console.log(`❌ Failed to start ETH monitoring: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start monitoring Solana wallet
   * @param {string} walletAddress - SOL wallet to monitor  
   */
  async startSolWalletMonitoring(walletAddress) {
    try {
      // Use Solana's built-in account monitoring
      const subscriptionId = await this.solChain.startMirrorTrading(
        walletAddress,
        (tradeData) => this.processMirrorTransaction(tradeData, 'solana')
      );

      console.log(`👁️ Started monitoring SOL wallet: ${walletAddress}`);
      return subscriptionId;

    } catch (error) {
      console.log(`❌ Failed to start SOL monitoring: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process detected transaction for mirroring
   * @param {object} transaction - Transaction data
   * @param {string} chain - blockchain chain
   */
  async processMirrorTransaction(transaction, chain) {
    try {
      const fromAddress = chain === 'ethereum' ? transaction.from : transaction.wallet;
      const users = this.monitoredWallets.get(fromAddress.toLowerCase());
      
      if (!users || users.size === 0) {
        return; // No users mirroring this wallet
      }

      // Parse transaction to extract trade details
      const tradeDetails = await this.parseTradeTransaction(transaction, chain);
      
      if (!tradeDetails) {
        return; // Not a trade transaction
      }

      console.log(`🔍 Detected ${chain} trade: ${tradeDetails.type} ${tradeDetails.amount} ${tradeDetails.token}`);

      // Execute mirror trades for all users
      for (const userId of users) {
        await this.executeMirrorTrade(userId, tradeDetails, chain);
      }

    } catch (error) {
      console.log(`❌ Error processing mirror transaction: ${error.message}`);
    }
  }

  /**
   * Parse transaction to extract trade information
   * @param {object} transaction - Raw transaction
   * @param {string} chain - Blockchain chain
   * @returns {object} - Trade details or null
   */
  async parseTradeTransaction(transaction, chain) {
    try {
      if (chain === 'ethereum') {
        return await this.parseEthTransaction(transaction);
      } else {
        return await this.parseSolTransaction(transaction);
      }
    } catch (error) {
      console.log(`Error parsing ${chain} transaction:`, error.message);
      return null;
    }
  }

  /**
   * Parse Ethereum transaction for DEX trades
   * @param {object} tx - Ethereum transaction
   * @returns {object} - Trade details
   */
  async parseEthTransaction(tx) {
    // Check if transaction is to Uniswap router
    const uniswapRouters = [
      '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2
      '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3
      '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45'  // Universal Router
    ];

    const toAddress = tx.to?.toLowerCase();
    if (!uniswapRouters.includes(toAddress)) {
      return null; // Not a Uniswap trade
    }

    // Decode transaction data (simplified)
    const value = parseFloat(ethers.utils.formatEther(tx.value || '0'));
    
    if (value > 0) {
      // ETH to Token trade
      return {
        type: 'buy',
        amount: value,
        token: 'unknown', // Would need ABI decoding to get exact token
        fromToken: 'ETH',
        toToken: 'TOKEN',
        hash: tx.hash,
        timestamp: Date.now()
      };
    } else {
      // Token to ETH trade (would need more parsing)
      return {
        type: 'sell',
        amount: 0, // Would extract from logs
        token: 'unknown',
        fromToken: 'TOKEN', 
        toToken: 'ETH',
        hash: tx.hash,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Parse Solana transaction for DEX trades
   * @param {object} tx - Solana transaction data
   * @returns {object} - Trade details
   */
  async parseSolTransaction(tx) {
    // For Solana, we'd parse Jupiter/Raydium transactions
    // This is simplified - real implementation would decode instruction data
    return {
      type: 'buy', // or 'sell'
      amount: 1.0, // SOL amount
      token: 'unknown',
      fromToken: 'SOL',
      toToken: 'TOKEN',
      signature: tx.signature || 'unknown',
      timestamp: Date.now()
    };
  }

  /**
   * Execute mirror trade for a user
   * @param {string} userId - User executing mirror trade
   * @param {object} tradeDetails - Original trade details
   * @param {string} chain - Blockchain chain
   */
  async executeMirrorTrade(userId, tradeDetails, chain) {
    try {
      const mirrorConfig = this.activeMirrors.get(userId);
      if (!mirrorConfig || !mirrorConfig.active) {
        return;
      }

      // Calculate copy amount based on user's percentage setting
      const originalAmount = tradeDetails.amount;
      const copyPercentage = mirrorConfig.copyPercentage / 100;
      let copyAmount = originalAmount * copyPercentage;

      // Apply maximum amount limit
      if (copyAmount > mirrorConfig.maxAmount) {
        copyAmount = mirrorConfig.maxAmount;
      }

      // Apply minimum amount (0.001 ETH/SOL)
      if (copyAmount < 0.001) {
        console.log(`Mirror amount too small: ${copyAmount}, skipping`);
        return;
      }

      console.log(`🪞 Executing mirror trade for user ${userId}: ${copyAmount} ${chain === 'ethereum' ? 'ETH' : 'SOL'}`);

      // Get user's wallet data
      const userData = await getUser(userId);
      const walletKey = chain === 'ethereum' ? 'ethWallets' : 'solWallets';
      
      if (!userData[walletKey] || userData[walletKey].length === 0) {
        console.log(`❌ User ${userId} has no ${chain} wallet for mirror trading`);
        return;
      }

      // Execute the mirror trade
      let result;
      if (chain === 'ethereum') {
        result = await this.executeMirrorEthTrade(userId, userData, tradeDetails, copyAmount);
      } else {
        result = await this.executeMirrorSolTrade(userId, userData, tradeDetails, copyAmount);
      }

      // Record mirror transaction
      await addTransaction(userId, {
        type: 'mirror',
        originalType: tradeDetails.type,
        amount: copyAmount,
        originalAmount: originalAmount,
        targetWallet: mirrorConfig.targetWallet,
        originalHash: tradeDetails.hash || tradeDetails.signature,
        txHash: result?.hash || result?.signature,
        timestamp: Date.now(),
        chain: chain,
        copyPercentage: mirrorConfig.copyPercentage,
        success: !!result
      });

      console.log(`✅ Mirror trade executed successfully for user ${userId}`);

    } catch (error) {
      console.log(`❌ Mirror trade execution failed for user ${userId}: ${error.message}`);

      // Record failed mirror attempt
      try {
        await addTransaction(userId, {
          type: 'mirror',
          originalType: tradeDetails.type,
          amount: 0,
          originalAmount: tradeDetails.amount,
          targetWallet: mirrorConfig?.targetWallet,
          originalHash: tradeDetails.hash || tradeDetails.signature,
          timestamp: Date.now(),
          chain: chain,
          failed: true,
          error: error.message,
          success: false
        });
      } catch (recordError) {
        console.log(`Failed to record mirror error: ${recordError.message}`);
      }
    }
  }

  /**
   * Execute ETH mirror trade
   * @param {string} userId - User ID
   * @param {object} userData - User data
   * @param {object} tradeDetails - Trade details
   * @param {number} copyAmount - Amount to copy
   * @returns {object} - Transaction result
   */
  async executeMirrorEthTrade(userId, userData, tradeDetails, copyAmount) {
    // This would integrate with your existing ETH trading logic
    // For now, return mock result
    console.log(`📈 Executing ETH mirror trade: ${tradeDetails.type} ${copyAmount} ETH`);
    
    // Would call your existing buy/sell functions:
    // if (tradeDetails.type === 'buy') {
    //   return await this.ethChain.executeSwap(...);
    // } else {
    //   return await this.ethChain.executeTokenSale(...);
    // }
    
    return {
      hash: '0x' + Math.random().toString(16).substr(2, 64),
      success: true
    };
  }

  /**
   * Execute SOL mirror trade
   * @param {string} userId - User ID
   * @param {object} userData - User data
   * @param {object} tradeDetails - Trade details
   * @param {number} copyAmount - Amount to copy
   * @returns {object} - Transaction result
   */
  async executeMirrorSolTrade(userId, userData, tradeDetails, copyAmount) {
    // This would integrate with your existing SOL trading logic
    console.log(`📈 Executing SOL mirror trade: ${tradeDetails.type} ${copyAmount} SOL`);
    
    // Would call your existing SOL swap functions:
    // return await this.solChain.executeSwap(...);
    
    return {
      signature: Math.random().toString(16).substr(2, 64),
      success: true
    };
  }

  /**
   * Get mirror trading statistics for a user
   * @param {string} userId - User ID
   * @returns {object} - Mirror statistics
   */
  async getMirrorStats(userId) {
    try {
      const userData = await getUser(userId);
      const mirrorTxs = (userData.transactions || []).filter(tx => tx.type === 'mirror');

      const stats = {
        totalMirrors: mirrorTxs.length,
        successfulMirrors: mirrorTxs.filter(tx => tx.success).length,
        failedMirrors: mirrorTxs.filter(tx => tx.failed).length,
        totalVolume: mirrorTxs.reduce((sum, tx) => sum + (parseFloat(tx.amount) || 0), 0),
        isActive: this.activeMirrors.has(userId)
      };

      stats.successRate = stats.totalMirrors > 0 
        ? Math.round((stats.successfulMirrors / stats.totalMirrors) * 100)
        : 0;

      return stats;

    } catch (error) {
      console.log(`Error getting mirror stats: ${error.message}`);
      return {
        totalMirrors: 0,
        successfulMirrors: 0,
        failedMirrors: 0,
        totalVolume: 0,
        successRate: 0,
        isActive: false
      };
    }
  }

  /**
   * Get current mirror configuration for a user
   * @param {string} userId - User ID
   * @returns {object} - Mirror configuration
   */
  getMirrorConfig(userId) {
    return this.activeMirrors.get(userId) || null;
  }

  /**
   * Update mirror configuration
   * @param {string} userId - User ID
   * @param {object} updates - Configuration updates
   */
  updateMirrorConfig(userId, updates) {
    const currentConfig = this.activeMirrors.get(userId);
    if (currentConfig) {
      const updatedConfig = { ...currentConfig, ...updates };
      this.activeMirrors.set(userId, updatedConfig);
      console.log(`🔄 Updated mirror config for user ${userId}`);
      return updatedConfig;
    }
    return null;
  }

  /**
   * Cleanup - stop all mirror trading
   */
  cleanup() {
    console.log(`🧹 Cleaning up mirror trading system...`);
    this.activeMirrors.clear();
    this.monitoredWallets.clear();
    console.log(`✅ Mirror trading cleanup complete`);
  }
}

module.exports = MirrorTradingSystem;
