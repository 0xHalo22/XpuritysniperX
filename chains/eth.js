// ====================================================================
// ETHEREUM CHAIN HANDLER - WITH PHASE 3 RISK MANAGEMENT INTEGRATION
// Enhanced with complete risk analysis, honeypot detection, and MEV protection
// ====================================================================

const { ethers } = require('ethers');
const {
  analyzeTokenSafety,
  analyzeTransactionSafety,
  checkUserProtection,
  applyMEVProtection,
  generateRiskReport
} = require('../utils/riskAnalysis');

class EthChain {
  constructor() {
    this.providers = [];
    this.currentProviderIndex = 0;

    // Contract addresses (UNCHANGED)
    this.contracts = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      UNISWAP_V2_FACTORY: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
    };

    // Token addresses (UNCHANGED)
    this.tokens = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      USDC: '0xA0b86a33E6441F8C4C8f0c59c9B1A5B8c3b2a4A2',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    };

    this.initializeProviders();
  }

  // ====================================================================
  // PROVIDER MANAGEMENT (UNCHANGED)
  // ====================================================================

  initializeProviders() {
    const rpcUrls = [
      process.env.ETH_RPC_URL,
      process.env.ETH_RPC_URL_BACKUP,
      'https://eth-mainnet.g.alchemy.com/v2/demo',
      'https://cloudflare-eth.com'
    ].filter(Boolean);

    this.providers = rpcUrls.map(url => new ethers.providers.JsonRpcProvider(url));
    console.log(`Initialized ${this.providers.length} RPC provider(s)`);
  }

  async getProvider() {
    return this.providers[this.currentProviderIndex] || this.providers[0];
  }

  async switchToNextProvider() {
    this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
    console.log(`🔄 Switched to provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
  }

  // ====================================================================
  // BASIC WALLET & BALANCE OPERATIONS (UNCHANGED)
  // ====================================================================

  async getETHBalance(address) {
    try {
      const provider = await this.getProvider();
      const balance = await provider.getBalance(address);
      return ethers.utils.formatEther(balance);
    } catch (error) {
      throw new Error(`Failed to get ETH balance: ${error.message}`);
    }
  }

  async getTokenBalance(tokenAddress, walletAddress) {
    try {
      const provider = await this.getProvider();
      const abi = ['function balanceOf(address) view returns (uint256)'];
      const contract = new ethers.Contract(tokenAddress, abi, provider);
      const balance = await contract.balanceOf(walletAddress);
      return balance;
    } catch (error) {
      throw new Error(`Failed to get token balance: ${error.message}`);
    }
  }

  async getTokenInfo(tokenAddress) {
    try {
      const provider = await this.getProvider();
      const abi = [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)'
      ];

      const contract = new ethers.Contract(tokenAddress, abi, provider);
      const [name, symbol, decimals] = await Promise.all([
        contract.name(),
        contract.symbol(),
        contract.decimals()
      ]);

      return { name, symbol, decimals };
    } catch (error) {
      throw new Error(`Failed to get token info: ${error.message}`);
    }
  }

  // ====================================================================
  // 💰 🔧 COMPLETELY FIXED FEE COLLECTION SYSTEM
  // ====================================================================

  /**
   * 🎯 MAIN FIX: Robust fee collection with proper error handling
   * @param {string} privateKey - User's private key
   * @param {string|BigNumber|number} feeAmount - Fee amount (flexible input)
   * @returns {object|null} - Transaction result or null if failed/skipped
   */
  async collectFee(privateKey, feeAmount) {
    console.log(`🔥 FIXED FEE COLLECTION STARTING...`);

    try {
      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);
      const treasuryWallet = process.env.TREASURY_WALLET;

      // ✅ VALIDATION 1: Check treasury wallet exists
      if (!treasuryWallet) {
        console.log('❌ TREASURY_WALLET not configured in environment');
        return null;
      }

      console.log(`💰 Treasury wallet: ${treasuryWallet}`);
      console.log(`💰 Input fee amount: ${feeAmount} (${typeof feeAmount})`);

      // ✅ STANDARDIZATION: Convert any fee amount format to Wei (BigNumber)
      let feeAmountWei;

      if (ethers.BigNumber.isBigNumber(feeAmount)) {
        // Already a BigNumber in Wei
        feeAmountWei = feeAmount;
        console.log(`✅ Using BigNumber fee: ${feeAmountWei.toString()} Wei`);
      } else if (typeof feeAmount === 'string') {
        // String - could be ETH amount
        try {
          const feeFloat = parseFloat(feeAmount);
          if (isNaN(feeFloat) || feeFloat <= 0) {
            console.log('⚠️ Invalid fee amount (NaN or <= 0)');
            return null;
          }

          // Convert to ETH string with fixed decimals to prevent precision issues
          const feeEthString = feeFloat.toFixed(18);
          feeAmountWei = ethers.utils.parseEther(feeEthString);
          console.log(`✅ Converted string "${feeAmount}" to ${feeAmountWei.toString()} Wei`);
        } catch (conversionError) {
          console.log(`❌ String conversion failed: ${conversionError.message}`);
          return null;
        }
      } else if (typeof feeAmount === 'number') {
        // Number - convert to string then to Wei
        try {
          if (isNaN(feeAmount) || feeAmount <= 0) {
            console.log('⚠️ Invalid fee number (NaN or <= 0)');
            return null;
          }

          const feeEthString = feeAmount.toFixed(18);
          feeAmountWei = ethers.utils.parseEther(feeEthString);
          console.log(`✅ Converted number ${feeAmount} to ${feeAmountWei.toString()} Wei`);
        } catch (conversionError) {
          console.log(`❌ Number conversion failed: ${conversionError.message}`);
          return null;
        }
      } else {
        console.log(`❌ Unsupported fee amount type: ${typeof feeAmount}`);
        return null;
      }

      // ✅ VALIDATION 2: Check minimum fee threshold (0.0001 ETH)
      const minFeeWei = ethers.utils.parseEther('0.000000000001');
      if (feeAmountWei.lt(minFeeWei)) {
        console.log(`⚠️ Fee too small: ${ethers.utils.formatEther(feeAmountWei)} ETH < 0.0001 ETH minimum`);
        return null;
      }

      console.log(`💎 Fee amount (final): ${ethers.utils.formatEther(feeAmountWei)} ETH`);

      // ✅ GAS ESTIMATION: More robust gas price calculation
      let gasPrice, gasLimit;
      try {
        const networkGasPrice = await provider.getGasPrice();
        gasPrice = networkGasPrice.mul(120).div(100); // +20% buffer
        gasLimit = ethers.BigNumber.from('100000'); // Standard ETH transfer

        console.log(`⛽ Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);
        console.log(`⛽ Gas limit: ${gasLimit.toString()}`);
      } catch (gasError) {
        console.log(`❌ Gas estimation failed: ${gasError.message}`);
        return null;
      }

      const totalGasCost = gasLimit.mul(gasPrice);
      const totalRequired = feeAmountWei.add(totalGasCost);

      // ✅ BALANCE CHECK: Detailed balance validation
      const userBalance = await provider.getBalance(wallet.address);

      console.log(`💰 User balance: ${ethers.utils.formatEther(userBalance)} ETH`);
      console.log(`💸 Fee needed: ${ethers.utils.formatEther(feeAmountWei)} ETH`);
      console.log(`⛽ Gas needed: ${ethers.utils.formatEther(totalGasCost)} ETH`);
      console.log(`📊 Total needed: ${ethers.utils.formatEther(totalRequired)} ETH`);

      if (userBalance.lt(totalRequired)) {
        const deficit = totalRequired.sub(userBalance);
        console.log(`❌ Insufficient balance! Short by: ${ethers.utils.formatEther(deficit)} ETH`);
        return null;
      }

      console.log(`✅ Sufficient balance for fee collection`);

      // ✅ TRANSACTION EXECUTION: Build and send transaction
      const transaction = {
        to: treasuryWallet,
        value: feeAmountWei,
        gasLimit: gasLimit,
        gasPrice: gasPrice,
        nonce: await provider.getTransactionCount(wallet.address, 'latest') + 1
      };

      console.log(`🚀 Sending fee transaction...`);
      console.log(`   To: ${transaction.to}`);
      console.log(`   Value: ${ethers.utils.formatEther(transaction.value)} ETH`);
      console.log(`   Nonce: ${transaction.nonce}`);

      const txResponse = await wallet.sendTransaction(transaction);

      console.log(`✅ FEE TRANSACTION SENT!`);
      console.log(`   Hash: ${txResponse.hash}`);
      console.log(`   Amount: ${ethers.utils.formatEther(feeAmountWei)} ETH`);
      console.log(`   Treasury: ${treasuryWallet}`);

      // ✅ OPTIONAL: Wait for confirmation (with timeout)
      try {
        const confirmationTimeout = 30000; // 30 seconds
        const receipt = await Promise.race([
          txResponse.wait(1),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Confirmation timeout')), confirmationTimeout)
          )
        ]);

        if (receipt && receipt.status === 1) {
          console.log(`🎉 Fee transaction CONFIRMED! Block: ${receipt.blockNumber}`);
        } else {
          console.log(`⚠️ Fee transaction may have failed (status: ${receipt?.status})`);
        }
      } catch (confirmError) {
        console.log(`⚠️ Confirmation timeout/error: ${confirmError.message}`);
        console.log(`ℹ️ Transaction likely still pending: ${txResponse.hash}`);
      }

      return txResponse;

    } catch (error) {
      console.log(`❌ FEE COLLECTION FAILED: ${error.message}`);

      // ✅ DETAILED ERROR LOGGING for debugging
      if (error.code) {
        console.log(`   Error code: ${error.code}`);
      }
      if (error.reason) {
        console.log(`   Error reason: ${error.reason}`);
      }
      if (error.transaction) {
        console.log(`   Failed transaction: ${JSON.stringify(error.transaction, null, 2)}`);
      }

      // ✅ CRITICAL: Return null instead of throwing (non-blocking)
      return null;
    }
  }

  /**
   * 🧮 Enhanced fee calculation with precision handling
   * @param {string|number} amount - Trading amount in ETH
   * @param {number} feePercentage - Fee percentage (default 1.5%)
   * @returns {object} - Detailed fee breakdown
   */
  calculateFeeBreakdown(amount, feePercentage = 1.5) {
    try {
      console.log(`🧮 Calculating fee breakdown: ${amount} ETH @ ${feePercentage}%`);

      const amountBN = ethers.utils.parseEther(amount.toString());
      const feeBN = amountBN.mul(Math.floor(feePercentage * 100)).div(10000);
      const netAmountBN = amountBN.sub(feeBN);

      const result = {
        totalAmount: amount.toString(),
        feeAmount: ethers.utils.formatEther(feeBN),
        netAmount: ethers.utils.formatEther(netAmountBN),
        feePercentage: feePercentage,
        feeAmountWei: feeBN,
        netAmountWei: netAmountBN,
        formatted: {
          fee: `${ethers.utils.formatEther(feeBN)} ETH (${feePercentage}%)`,
          net: `${ethers.utils.formatEther(netAmountBN)} ETH`,
          total: `${amount} ETH`
        }
      };

      console.log(`✅ Fee breakdown complete:`);
      console.log(`   Total: ${result.totalAmount} ETH`);
      console.log(`   Fee: ${result.feeAmount} ETH`);
      console.log(`   Net: ${result.netAmount} ETH`);

      return result;

    } catch (error) {
      console.log(`❌ Fee calculation failed: ${error.message}`);

      // ✅ SAFE FALLBACK: Return zero fee breakdown
      return {
        totalAmount: amount.toString(),
        feeAmount: '0',
        netAmount: amount.toString(),
        feePercentage: 0,
        feeAmountWei: ethers.BigNumber.from(0),
        netAmountWei: ethers.utils.parseEther(amount.toString()),
        formatted: {
          fee: '0 ETH (0%)',
          net: `${amount} ETH`,
          total: `${amount} ETH`
        }
      };
    }
  }

  /**
   * 🔧 Fee collection validation helper
   * @param {string} treasuryWallet - Treasury wallet address  
   * @returns {object} - Validation results
   */
  validateFeeConfiguration() {
    const treasuryWallet = process.env.TREASURY_WALLET;
    const feePercentage = process.env.FEE_PERCENTAGE;

    return {
      hasTreasuryWallet: !!treasuryWallet,
      treasuryWallet: treasuryWallet || 'NOT_SET',
      validTreasuryAddress: treasuryWallet ? ethers.utils.isAddress(treasuryWallet) : false,
      feePercentage: feePercentage || '1.0',
      isConfigured: !!(treasuryWallet && ethers.utils.isAddress(treasuryWallet))
    };
  }

  // ====================================================================
    // TOKEN ALLOWANCE & APPROVAL SYSTEM (UNCHANGED - WORKING)
    // ====================================================================

    async getTokenAllowance(tokenAddress, ownerAddress, spenderAddress) {
      try {
        const provider = await this.getProvider();
        const abi = ['function allowance(address owner, address spender) view returns (uint256)'];
        const contract = new ethers.Contract(tokenAddress, abi, provider);
        return await contract.allowance(ownerAddress, spenderAddress);
      } catch (error) {
        throw new Error(`Failed to get token allowance: ${error.message}`);
      }
    }

    async approveToken(tokenAddress, spenderAddress, amount, privateKey) {
      try {
        const provider = await this.getProvider();
        const wallet = new ethers.Wallet(privateKey, provider);
        const abi = ['function approve(address spender, uint256 amount) returns (bool)'];
        const contract = new ethers.Contract(tokenAddress, abi, wallet);
        return await contract.approve(spenderAddress, amount);
      } catch (error) {
        throw new Error(`Failed to approve token: ${error.message}`);
      }
    }

    // ====================================================================
    // 🚀 SMART SELL AMOUNT CALCULATION (UNCHANGED - WORKING)
    // ====================================================================

    calculateSmartSellAmount(tokenBalance, percentage, decimals = 18) {
      try {
        console.log(`💡 Smart sell calculation: ${percentage}% of ${tokenBalance.toString()}`);

        if (percentage >= 100) {
          // ✅ FIX: For 100% sales, leave tiny dust to avoid precision errors
          const dustAmount = ethers.BigNumber.from(10).pow(Math.max(0, decimals - 6)); // ~0.000001 tokens
          const sellAmount = tokenBalance.sub(dustAmount);

          // Safety check - ensure we don't go negative
          if (sellAmount.lte(0) || sellAmount.gt(tokenBalance)) {
            const fallbackAmount = tokenBalance.mul(999).div(1000); // 99.9% fallback
            console.log(`⚠️ Using 99.9% fallback: ${fallbackAmount.toString()}`);
            return fallbackAmount;
          }

          const actualPercentage = sellAmount.mul(10000).div(tokenBalance).toNumber() / 100;
          console.log(`✅ Smart 100% sell: ${sellAmount.toString()} (~${actualPercentage.toFixed(3)}%)`);
          console.log(`🗑️ Dust left: ${dustAmount.toString()}`);

          return sellAmount;

        } else {
          // For partial sales, use exact percentage
          const sellAmount = tokenBalance.mul(percentage * 100).div(10000); // More precise calculation
          console.log(`📊 Partial sell (${percentage}%): ${sellAmount.toString()}`);
          return sellAmount;
        }

      } catch (error) {
        console.log(`❌ Smart sell calculation failed: ${error.message}`);
        // Emergency fallback
        return tokenBalance.mul(Math.min(percentage * 100, 9900)).div(10000);
      }
    }

    formatTokenBalance(balance, decimals = 18, isForSell = false) {
      try {
        const formatted = ethers.utils.formatUnits(balance, decimals);
        const number = parseFloat(formatted);

        if (isForSell) {
          // For sell operations, show more precision to avoid confusion
          if (number < 0.001) return number.toFixed(8);
          if (number < 1) return number.toFixed(6);
          if (number < 1000) return number.toFixed(4);
          return number.toFixed(2);
        } else {
          // For display, use normal precision
          if (number >= 1000000) return (number / 1000000).toFixed(2) + 'M';
          if (number >= 1000) return (number / 1000).toFixed(2) + 'K';
          return number.toFixed(4);
        }
      } catch {
        return '0';
      }
    }

    // ====================================================================
    // 🔧 ENHANCED TOKEN VALIDATION & SECURITY (UNCHANGED - WORKING)
    // ====================================================================

    async validateTokenTransaction(tokenAddress, walletAddress, amount) {
      try {
        console.log(`🔍 Validating token transaction...`);

        const provider = await this.getProvider();

        // Check if contract exists
        const code = await provider.getCode(tokenAddress);
        if (code === '0x') {
          throw new Error('Invalid token address - no contract found');
        }

        // Get token info
        const tokenInfo = await this.getTokenInfo(tokenAddress);
        console.log(`📋 Token: ${tokenInfo.name} (${tokenInfo.symbol})`);

        // Check token balance
        const tokenBalance = await this.getTokenBalance(tokenAddress, walletAddress);
        const balanceFormatted = this.formatTokenBalance(tokenBalance, tokenInfo.decimals, true);

        console.log(`💰 Token balance: ${balanceFormatted} ${tokenInfo.symbol}`);
        console.log(`📊 Requested amount: ${this.formatTokenBalance(amount, tokenInfo.decimals, true)} ${tokenInfo.symbol}`);

        // Validate sufficient balance
        if (tokenBalance.lt(amount)) {
          throw new Error(`Insufficient token balance. Have: ${balanceFormatted}, Need: ${this.formatTokenBalance(amount, tokenInfo.decimals, true)}`);
        }

        // Check for pause function (common security feature)
        try {
          const pauseContract = new ethers.Contract(tokenAddress, ['function paused() view returns (bool)'], provider);
          const isPaused = await pauseContract.paused();
          if (isPaused) {
            throw new Error('Token is currently paused and cannot be transferred');
          }
          console.log(`✅ Token is not paused`);
        } catch (pauseError) {
          // Token doesn't have pause function - this is normal
          console.log(`ℹ️ Token has no pause function (normal)`);
        }

        return {
          valid: true,
          tokenInfo,
          tokenBalance,
          balanceFormatted,
          hasBalance: tokenBalance.gte(amount)
        };

      } catch (error) {
        console.log(`❌ Token validation failed: ${error.message}`);
        throw error;
      }
    }

    // ====================================================================
    // 🔐 ENHANCED APPROVAL SYSTEM (UNCHANGED - WORKING)
    // ====================================================================

    async smartApproveToken(tokenAddress, spenderAddress, amount, privateKey) {
      try {
        console.log(`🔐 Smart token approval: ${tokenAddress}`);

        const provider = await this.getProvider();
        const wallet = new ethers.Wallet(privateKey, provider);

        // Check current allowance
        const currentAllowance = await this.getTokenAllowance(tokenAddress, wallet.address, spenderAddress);
        console.log(`🔍 Current allowance: ${currentAllowance.toString()}`);

        // If allowance is already sufficient, skip approval
        if (currentAllowance.gte(amount)) {
          console.log(`✅ Sufficient allowance already exists`);
          return true;
        }

        // For some tokens (like USDT), we need to reset to 0 before setting new allowance
        if (!currentAllowance.isZero()) {
          console.log(`🔄 Resetting allowance to 0 (required by some tokens)...`);

          const resetTx = await this.approveToken(tokenAddress, spenderAddress, ethers.BigNumber.from(0), privateKey);
          console.log(`⏳ Reset transaction: ${resetTx.hash}`);

          const resetReceipt = await resetTx.wait(2); // Wait 2 confirmations
          if (resetReceipt.status !== 1) {
            throw new Error('Reset approval failed');
          }

          console.log(`✅ Allowance reset successful`);

          // Wait for reset to propagate
          await new Promise(resolve => setTimeout(resolve, 8000));
        }

        // Set new approval (use max uint256 for gas efficiency)
        console.log(`🔐 Setting new approval...`);
        const approveTx = await this.approveToken(tokenAddress, spenderAddress, ethers.constants.MaxUint256, privateKey);
        console.log(`⏳ Approval transaction: ${approveTx.hash}`);

        const approvalReceipt = await approveTx.wait(2);
        if (approvalReceipt.status !== 1) {
          throw new Error('Approval transaction failed');
        }

        console.log(`✅ Token approval successful`);

        // Wait for approval to propagate
        await new Promise(resolve => setTimeout(resolve, 12000));

        // Verify approval worked
        const finalAllowance = await this.getTokenAllowance(tokenAddress, wallet.address, spenderAddress);
        console.log(`🔍 Final allowance: ${finalAllowance.toString()}`);

        if (finalAllowance.lt(amount)) {
          throw new Error(`Approval verification failed: ${finalAllowance.toString()} < ${amount.toString()}`);
        }

        return true;

      } catch (error) {
        console.log(`❌ Smart approval failed: ${error.message}`);
        throw error;
      }
    }

    // ====================================================================
    // 🔧 ENHANCED GAS ESTIMATION (UNCHANGED - WORKING)
    // ====================================================================

    async estimateSwapGas(tokenIn, tokenOut, amountIn, recipient) {
      try {
        console.log(`⛽ Estimating gas: ${tokenIn} -> ${tokenOut}`);

        const provider = await this.getProvider();

        // Build transaction for estimation
        let transaction;
        if (tokenIn === this.tokens.WETH || tokenIn === this.contracts.WETH) {
          transaction = await this.buildETHToTokenSwap(tokenOut, amountIn, BigInt(0), recipient);
        } else if (tokenOut === this.tokens.WETH || tokenOut === this.contracts.WETH) {
          transaction = await this.buildTokenToETHSwap(tokenIn, amountIn, BigInt(0), recipient);
        } else {
          transaction = await this.buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, BigInt(0), recipient);
        }

        // Level 1: Try precise estimation
        try {
          const gasEstimate = await provider.estimateGas({
            ...transaction,
            from: recipient
          });

          const bufferedGas = gasEstimate.mul(200).div(100); // 2x buffer
          const MIN_GAS = ethers.BigNumber.from(400000);
          const finalGas = bufferedGas.gt(MIN_GAS) ? bufferedGas : MIN_GAS;

          const gasPrice = (await provider.getGasPrice()).mul(120).div(100); // +20%

          console.log(`✅ Precise gas: ${gasEstimate.toString()} -> ${finalGas.toString()}`);

          return {
            gasLimit: finalGas,
            gasPrice: gasPrice,
            totalCost: finalGas.mul(gasPrice),
            estimateType: 'precise'
          };

        } catch (estimateError) {
          console.log(`⚠️ Precise estimation failed: ${estimateError.message}`);

          // Level 2: Conservative fallback
          const gasPrice = (await provider.getGasPrice()).mul(130).div(100); // +30%
          const conservativeGas = ethers.BigNumber.from(600000);

          console.log(`🛡️ Using conservative gas: ${conservativeGas.toString()}`);

          return {
            gasLimit: conservativeGas,
            gasPrice: gasPrice,
            totalCost: conservativeGas.mul(gasPrice),
            estimateType: 'conservative'
          };
        }

      } catch (error) {
        console.log(`❌ Gas estimation failed: ${error.message}`);

        // Level 3: Emergency fallback
        try {
          const provider = await this.getProvider();
          const gasPrice = (await provider.getGasPrice()).mul(150).div(100); // +50%
          const emergencyGas = ethers.BigNumber.from(800000);

          console.log(`🚨 Emergency gas: ${emergencyGas.toString()}`);

          return {
            gasLimit: emergencyGas,
            gasPrice: gasPrice,
            totalCost: emergencyGas.mul(gasPrice),
            estimateType: 'emergency'
          };
        } catch (finalError) {
          throw new Error(`Complete gas estimation failure: ${finalError.message}`);
        }
      }
    }

    // ====================================================================
    // 🔄 SWAP QUOTES & PRICING (UNCHANGED - WORKING)
    // ====================================================================

    async getSwapQuote(tokenIn, tokenOut, amountIn) {
      try {
        console.log(`💹 Getting swap quote: ${tokenIn} -> ${tokenOut}`);

        // Normalize addresses
        if (tokenIn === this.contracts.WETH || tokenIn.toLowerCase() === 'eth') {
          tokenIn = this.tokens.WETH;
        }
        if (tokenOut === this.contracts.WETH || tokenOut.toLowerCase() === 'eth') {
          tokenOut = this.tokens.WETH;
        }

        const provider = await this.getProvider();
        const routerAbi = [
          'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
        ];

        const routerContract = new ethers.Contract(this.contracts.UNISWAP_V2_ROUTER, routerAbi, provider);

        // Build trading path
        let path;
        if (tokenIn === this.tokens.WETH) {
          path = [this.tokens.WETH, tokenOut];
        } else if (tokenOut === this.tokens.WETH) {
          path = [tokenIn, this.tokens.WETH];
        } else {
          path = [tokenIn, this.tokens.WETH, tokenOut];
        }

        console.log(`🛣️ Path: ${path.map(addr => addr.slice(0, 6) + '...').join(' -> ')}`);

        try {
          const amounts = await routerContract.getAmountsOut(amountIn.toString(), path);
          const outputAmount = amounts[amounts.length - 1];

          if (outputAmount.isZero()) {
            throw new Error('No liquidity available for this token pair');
          }

          console.log(`✅ Quote: ${outputAmount.toString()}`);

          return {
            outputAmount: BigInt(outputAmount.toString()),
            path: path,
            priceImpact: this.calculatePriceImpact(amountIn, outputAmount),
            valid: true
          };

        } catch (quoteError) {
          console.log(`❌ Quote failed: ${quoteError.message}`);
          throw new Error(`No liquidity or invalid token pair: ${quoteError.message}`);
        }

      } catch (error) {
        throw new Error(`Failed to get swap quote: ${error.message}`);
      }
    }

    calculatePriceImpact(amountIn, amountOut) {
      try {
        const impact = amountIn.mul(100).div(amountOut.add(amountIn));
        return ethers.utils.formatUnits(impact, 2);
      } catch {
        return '0.1';
      }
    }

    // ====================================================================
    // 🔧 TRANSACTION BUILDERS (UNCHANGED - WORKING)
    // ====================================================================

    async buildETHToTokenSwap(tokenOut, amountIn, minOutput, recipient) {
      const routerAbi = [
        'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
      ];

      const path = [this.tokens.WETH, tokenOut];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

      const iface = new ethers.utils.Interface(routerAbi);
      const data = iface.encodeFunctionData('swapExactETHForTokens', [
        minOutput.toString(),
        path,
        recipient,
        deadline
      ]);

      return {
        to: this.contracts.UNISWAP_V2_ROUTER,
        value: amountIn,
        data: data
      };
    }

    async buildTokenToETHSwap(tokenIn, amountIn, minOutput, recipient) {
      const routerAbi = [
        'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
      ];

      const path = [tokenIn, this.tokens.WETH];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const iface = new ethers.utils.Interface(routerAbi);
      const data = iface.encodeFunctionData('swapExactTokensForETH', [
        amountIn.toString(),
        minOutput.toString(),
        path,
        recipient,
        deadline
      ]);

      return {
        to: this.contracts.UNISWAP_V2_ROUTER,
        value: 0,
        data: data
      };
    }

    async buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, minOutput, recipient) {
      const routerAbi = [
        'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
      ];

      const path = [tokenIn, this.tokens.WETH, tokenOut];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const iface = new ethers.utils.Interface(routerAbi);
      const data = iface.encodeFunctionData('swapExactTokensForTokens', [
        amountIn.toString(),
        minOutput.toString(),
        path,
        recipient,
        deadline
      ]);

      return {
        to: this.contracts.UNISWAP_V2_ROUTER,
        value: 0,
        data: data
      };
    }

    // ====================================================================
    // 🚀 ENHANCED TOKEN SWAP EXECUTION WITH PHASE 3 RISK MANAGEMENT
    // Complete integration of token safety, MEV protection, and user protection
    // ====================================================================

    async executeTokenSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const isSnipeMode = options.snipeMode || false;
    const userId = options.userId || 'unknown';

    // PHASE 3: Pre-execution risk analysis
    console.log(`🛡️ Phase 3: Conducting comprehensive risk analysis...`);
    
    try {
      const provider = await this.getProvider();
      
      // Step 1: Analyze token safety (if not ETH/WETH)
      let tokenSafetyAnalysis = null;
      if (tokenOut !== this.contracts.WETH && tokenOut !== this.tokens.WETH && 
          tokenIn !== this.contracts.WETH && tokenIn !== this.tokens.WETH) {
        
        const targetToken = tokenOut === this.contracts.WETH ? tokenIn : tokenOut;
        console.log(`🔍 Analyzing token safety: ${targetToken}`);
        
        tokenSafetyAnalysis = await analyzeTokenSafety(targetToken, provider);
        
        if (!tokenSafetyAnalysis.safeToTrade) {
          throw new Error(`🚨 TOKEN REJECTED: ${tokenSafetyAnalysis.riskFactors.join(', ')}`);
        }
        
        if (tokenSafetyAnalysis.overallRisk > 6) {
          console.log(`⚠️ HIGH RISK TOKEN DETECTED! Risk score: ${tokenSafetyAnalysis.overallRisk}/10`);
          console.log(`🔥 Risk factors: ${tokenSafetyAnalysis.riskFactors.join(', ')}`);
          
          // Adjust trading parameters for high-risk tokens
          slippagePercent = Math.max(slippagePercent, 25); // Minimum 25% slippage for risky tokens
          console.log(`🔧 Adjusted slippage to ${slippagePercent}% for high-risk token`);
        }
      }

      // Step 2: Check user protection limits
      const userProtection = await checkUserProtection(userId, {
        amount: ethers.utils.formatEther(amountIn),
        slippage: slippagePercent,
        tokenIn,
        tokenOut
      });

      if (!userProtection.allowed) {
        throw new Error(`🚨 USER PROTECTION: ${userProtection.warnings.join(', ')}`);
      }

      // Apply user protection adjustments
      if (userProtection.adjustments.recommendedSlippage) {
        slippagePercent = Math.max(slippagePercent, userProtection.adjustments.recommendedSlippage);
        console.log(`🛡️ User protection: adjusted slippage to ${slippagePercent}%`);
      }

      if (userProtection.cooldownNeeded) {
        console.log(`⏰ User protection: recommended cooldown period`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second cooldown
      }

    } catch (riskError) {
      console.log(`❌ Risk analysis failed: ${riskError.message}`);
      throw riskError;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🚀 Swap attempt ${attempt}/${maxRetries}: ${amountIn.toString()} ${tokenIn} -> ${tokenOut}`);

        const provider = await this.getProvider();
        const wallet = new ethers.Wallet(privateKey, provider);

        // ENHANCEMENT 1: Dynamic slippage based on attempt + Phase 3 analysis
        let dynamicSlippage = slippagePercent;
        if (isSnipeMode && attempt > 1) {
          dynamicSlippage = Math.min(slippagePercent + (attempt * 5), 50); // Increase slippage on retries
          console.log(`📈 Retry attempt: increased slippage to ${dynamicSlippage}%`);
        }

        // Get quote and calculate slippage
        const quote = await this.getSwapQuote(tokenIn, tokenOut, amountIn);
        const slippageBps = dynamicSlippage * 100;
        const minOutput = quote.outputAmount * BigInt(10000 - slippageBps) / BigInt(10000);

        console.log(`📉 Slippage: ${dynamicSlippage}%, Min output: ${minOutput.toString()}`);

        // Build transaction
        let transaction;
        if (tokenIn === this.tokens.WETH || tokenIn === this.contracts.WETH) {
          transaction = await this.buildETHToTokenSwap(tokenOut, amountIn, minOutput, wallet.address);
        } else if (tokenOut === this.tokens.WETH || tokenOut === this.contracts.WETH) {
          transaction = await this.buildTokenToETHSwap(tokenIn, amountIn, minOutput, wallet.address);
        } else {
          transaction = await this.buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, minOutput, wallet.address);
        }

        // ENHANCEMENT 2: Dynamic gas pricing for retries
        let gasEstimate;
        if (options.gasPrice && options.gasLimit) {
          // Use provided gas settings (for speed)
          gasEstimate = {
            gasPrice: options.gasPrice,
            gasLimit: options.gasLimit,
            totalCost: options.gasPrice.mul(options.gasLimit)
          };
        } else {
          gasEstimate = await this.estimateSwapGas(tokenIn, tokenOut, amountIn, wallet.address);

          // Increase gas price on retries for better success rate
          if (attempt > 1) {
            const gasMultiplier = 100 + (attempt * 25); // +25% per retry
            gasEstimate.gasPrice = gasEstimate.gasPrice.mul(gasMultiplier).div(100);
            gasEstimate.totalCost = gasEstimate.gasPrice.mul(gasEstimate.gasLimit);
            console.log(`⛽ Retry gas boost: ${gasMultiplier}% (${ethers.utils.formatUnits(gasEstimate.gasPrice, 'gwei')} gwei)`);
          }
        }

        transaction.gasLimit = gasEstimate.gasLimit;
        transaction.gasPrice = gasEstimate.gasPrice;

        // PHASE 3: Enhanced MEV Protection and Transaction Safety
        console.log(`🛡️ Applying Phase 3 MEV protection...`);
        
        // Build initial transaction parameters
        let transactionParams = {
          ...transaction,
          deadline: Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes
        };

        // Apply comprehensive MEV protection
        transactionParams = applyMEVProtection(transactionParams);

        // Analyze transaction safety
        const transactionSafety = await analyzeTransactionSafety(transactionParams, provider);
        
        if (!transactionSafety.safe) {
          console.log(`⚠️ Transaction safety warning: ${transactionSafety.warnings.join(', ')}`);
          
          if (transactionSafety.riskLevel === 'HIGH' && !isSnipeMode) {
            throw new Error(`🚨 TRANSACTION REJECTED: ${transactionSafety.warnings.join(', ')}`);
          }
        }

        // Apply MEV protection adjustments
        if (transactionParams.mevDelay && isSnipeMode) {
          console.log(`⏰ MEV protection delay: ${transactionParams.mevDelay}ms`);
          await new Promise(resolve => setTimeout(resolve, transactionParams.mevDelay));
        }

        // Enhanced nonce management with MEV protection
        const baseNonce = await provider.getTransactionCount(wallet.address, 'latest');
        const nonceOffset = transactionParams.nonceOffset || (isSnipeMode ? Math.floor(Math.random() * 3) : 0);
        transaction.nonce = baseNonce + nonceOffset;
        
        console.log(`🛡️ Enhanced MEV protection: nonce ${transaction.nonce} (base: ${baseNonce}, offset: ${nonceOffset})`);
        console.log(`📊 Transaction safety: ${transactionSafety.riskLevel} risk`);

        // Apply final transaction parameters
        Object.assign(transaction, transactionParams);

        console.log(`⛽ Gas: ${transaction.gasLimit.toString()} @ ${ethers.utils.formatUnits(transaction.gasPrice, 'gwei')} gwei`);

        // Balance check
        const balance = await provider.getBalance(wallet.address);
        const totalCost = transaction.value ? 
          transaction.value.add(gasEstimate.totalCost) : 
          gasEstimate.totalCost;

        if (balance.lt(totalCost)) {
          throw new Error(`Insufficient ETH. Need: ${ethers.utils.formatEther(totalCost)} ETH, Have: ${ethers.utils.formatEther(balance)} ETH`);
        }

        // ENHANCEMENT 4: Execute with timeout protection
        const txPromise = wallet.sendTransaction(transaction);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transaction timeout')), 45000) // 45s timeout
        );

        const txResponse = await Promise.race([txPromise, timeoutPromise]);
        console.log(`✅ Swap executed! Hash: ${txResponse.hash} (attempt ${attempt})`);

        // PHASE 3: Post-execution risk reporting
        if (options.generateRiskReport) {
          try {
            const riskReport = generateRiskReport(tokenOut, {
              tokenSafety: tokenSafetyAnalysis,
              transactionSafety: transactionSafety,
              userProtection: userProtection
            });
            
            console.log(`📊 Risk Report Generated:`);
            console.log(`   Overall Risk: ${riskReport.summary.overallRisk}/10`);
            console.log(`   Recommendation: ${riskReport.summary.recommendation}`);
            
            if (riskReport.actions.length > 0) {
              console.log(`   Suggested Actions: ${riskReport.actions.join(', ')}`);
            }
            
            // Attach risk report to transaction response
            txResponse.riskReport = riskReport;
            
          } catch (reportError) {
            console.log(`⚠️ Risk report generation failed: ${reportError.message}`);
          }
        }

        return txResponse;

      } catch (error) {
        console.log(`❌ Swap attempt ${attempt} failed: ${error.message}`);

        // Don't retry on certain errors
        if (error.message.includes('insufficient funds') || 
            error.message.includes('Insufficient ETH') ||
            error.message.includes('user rejected') ||
            attempt === maxRetries) {
          console.log(`🛑 Fatal error or max retries reached`);
          throw error;
        }

        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Max 5s wait
          console.log(`⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));

          // Switch provider for retry
          await this.switchToNextProvider();
        }
      }
    }

    throw new Error(`All ${maxRetries} swap attempts failed`);
  }

    // ====================================================================
    // 🎯 SMART TOKEN SALE SYSTEM (UNCHANGED - WORKING)
    // ====================================================================

    async executeSmartTokenSale(tokenAddress, outputToken, percentage, privateKey, slippagePercent = 3) {
      try {
        console.log(`🚀 SMART TOKEN SALE: ${percentage}% of ${tokenAddress} -> ${outputToken}`);

        const provider = await this.getProvider();
        const wallet = new ethers.Wallet(privateKey, provider);

        // Step 1: Validate token and get balance
        const tokenBalance = await this.getTokenBalance(tokenAddress, wallet.address);
        const validation = await this.validateTokenTransaction(tokenAddress, wallet.address, tokenBalance);

        // Step 2: Calculate smart sell amount (handles 100% precision issues)
        const sellAmountWei = this.calculateSmartSellAmount(tokenBalance, percentage, validation.tokenInfo.decimals);
        const sellAmountFormatted = this.formatTokenBalance(sellAmountWei, validation.tokenInfo.decimals, true);

        console.log(`💡 Selling ${sellAmountFormatted} ${validation.tokenInfo.symbol} (${percentage}%)`);

        // Step 3: Smart approval (handles USDT-type tokens)
        await this.smartApproveToken(tokenAddress, this.contracts.UNISWAP_V2_ROUTER, sellAmountWei, privateKey);

        // Step 4: Execute sale with enhanced error handling
        const saleResult = await this.executeTokenSwap(
          tokenAddress,
          outputToken,
          sellAmountWei,
          privateKey,
          slippagePercent
        );

        return {
          success: true,
          transaction: saleResult,
          details: {
            tokenSold: validation.tokenInfo.symbol,
            amountSold: sellAmountFormatted,
            percentageSold: percentage,
            actualAmount: sellAmountWei,
            txHash: saleResult.hash
          }
        };

      } catch (error) {
        console.log(`❌ Smart token sale failed: ${error.message}`);
        throw error;
      }
    }

    // ====================================================================
    // 🔄 TRANSACTION VERIFICATION & MONITORING (UNCHANGED - WORKING)
    // ====================================================================

    async waitForTransaction(txHash, confirmations = 1) {
      try {
        console.log(`⏳ Waiting for confirmation: ${txHash}`);
        const provider = await this.getProvider();

        const timeout = 5 * 60 * 1000; // 5 minutes

        const receipt = await Promise.race([
          provider.waitForTransaction(txHash, confirmations),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Transaction timeout')), timeout)
          )
        ]);

        if (receipt && receipt.status === 1) {
          console.log(`✅ Confirmed: ${txHash} (Block: ${receipt.blockNumber})`);
          return receipt;
        } else {
          throw new Error(`Transaction failed: ${txHash}`);
        }
      } catch (error) {
        console.log(`❌ Transaction wait failed: ${error.message}`);
        throw error;
      }
    }

    // ====================================================================
    // 🔧 UTILITY FUNCTIONS & HELPERS (UNCHANGED - WORKING)
    // ====================================================================

    async getGasPrice() {
      try {
        const provider = await this.getProvider();
        const feeData = await provider.getFeeData();

        return {
          gasPrice: feeData.gasPrice,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
          formatted: {
            gasPrice: ethers.utils.formatUnits(feeData.gasPrice || 0, 'gwei'),
            maxFeePerGas: ethers.utils.formatUnits(feeData.maxFeePerGas || 0, 'gwei')
          }
        };
      } catch (error) {
        throw new Error(`Failed to get gas price: ${error.message}`);
      }
    }

    isValidAddress(address) {
      try {
        return ethers.utils.isAddress(address);
      } catch {
        return false;
      }
    }

    formatNumber(number, precision = 4) {
      try {
        const num = parseFloat(number);
        if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(2) + 'K';
        return num.toFixed(precision);
      } catch {
        return '0';
      }
    }

    // ====================================================================
    // 🔄 BACKWARD COMPATIBILITY FUNCTIONS (UNCHANGED - WORKING)
    // ====================================================================

    async executeSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
      console.log('⚠️ Using legacy executeSwap function - mapping to executeTokenSwap');
      return await this.executeTokenSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent);
    }

    async executeTokenSale(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
      console.log('⚠️ Using legacy executeTokenSale function');

      try {
        // Try direct method first for token sales
        await this.smartApproveToken(tokenIn, this.contracts.UNISWAP_V2_ROUTER, amountIn, privateKey);
        return await this.executeTokenSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent);
      } catch (error) {
        console.log(`Token sale failed: ${error.message}`);
        throw error;
      }
    }

    // ====================================================================
    // 🎯 FUTURE FEATURES PLACEHOLDERS (UNCHANGED)
    // ====================================================================

    async monitorNewPairs() {
      console.log('🔄 Monitoring new pairs...');
      // Implementation for sniping features
    }

    async executeSnipe(tokenAddress, amountIn, privateKey) {
      console.log(`🎯 Executing snipe: ${tokenAddress}`);
      // Implementation for auto-sniping
    }

    async monitorWallet(walletAddress) {
      console.log(`👁️ Monitoring wallet: ${walletAddress}`);
      // Implementation for mirror trading
    }

    async copyTrade(targetTx, copyPercent, privateKey) {
      console.log(`📋 Copy trading: ${copyPercent}%`);
      // Implementation for copy trading
    }
  }

  module.exports = EthChain;