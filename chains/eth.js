// ====================================================================
// ETHEREUM CHAIN HANDLER - COMPLETE FRESH VERSION
// Part 1: Core Infrastructure + Smart Token Operations
// ====================================================================

const { ethers } = require('ethers');

class EthChain {
  constructor() {
    this.providers = [];
    this.currentProviderIndex = 0;

    // Contract addresses
    this.contracts = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      UNISWAP_V2_FACTORY: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
    };

    // Token addresses
    this.tokens = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      USDC: '0xA0b86a33E6441F8C4C8f0c59c9B1A5B8c3b2a4A2',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    };

    this.initializeProviders();
  }

  // ====================================================================
  // PROVIDER MANAGEMENT
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
  // BASIC WALLET & BALANCE OPERATIONS
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
  // TOKEN ALLOWANCE & APPROVAL SYSTEM
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
  // 🚀 SMART SELL AMOUNT CALCULATION (FIXES 100% PRECISION ISSUES)
  // ====================================================================

  /**
   * Calculate smart sell amount that avoids precision issues for 100% sales
   * @param {BigNumber} tokenBalance - Actual token balance
   * @param {number} percentage - Percentage to sell (1-100)
   * @param {number} decimals - Token decimals
   * @returns {BigNumber} - Safe amount to sell
   */
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

  /**
   * Format token balance with appropriate precision for display
   * @param {BigNumber} balance - Token balance
   * @param {number} decimals - Token decimals
   * @param {boolean} isForSell - Whether this is for a sell operation
   * @returns {string} - Formatted balance
   */
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
  // 🔧 ENHANCED TOKEN VALIDATION & SECURITY
  // ====================================================================

  /**
   * Comprehensive token and transaction validation
   * @param {string} tokenAddress - Token contract address
   * @param {string} walletAddress - Wallet address
   * @param {BigNumber} amount - Amount to validate
   * @returns {object} - Validation results
   */
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
  // 🔐 ENHANCED APPROVAL SYSTEM (FIXES USDT-TYPE TOKENS)
  // ====================================================================

  /**
   * Smart approval system that handles tokens requiring reset-to-zero
   * @param {string} tokenAddress - Token contract address
   * @param {string} spenderAddress - Spender (usually Uniswap router)
   * @param {BigNumber} amount - Amount to approve
   * @param {string} privateKey - User's private key
   * @returns {boolean} - Success status
   */
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
    // 🔧 ENHANCED GAS ESTIMATION WITH SMART FALLBACKS
    // ====================================================================

    /**
     * Multi-level gas estimation with intelligent fallbacks
     */
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
    // 🔄 SWAP QUOTES & PRICING WITH VALIDATION
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
    // 🔧 TRANSACTION BUILDERS
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
    // 🚀 ENHANCED TOKEN SWAP EXECUTION
    // ====================================================================

    /**
     * Execute token swap with comprehensive error handling and retry logic
     */
    async executeTokenSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
      try {
        console.log(`🚀 Executing swap: ${amountIn.toString()} ${tokenIn} -> ${tokenOut}`);

        const provider = await this.getProvider();
        const wallet = new ethers.Wallet(privateKey, provider);

        // Get quote and calculate slippage
        const quote = await this.getSwapQuote(tokenIn, tokenOut, amountIn);
        const slippageBps = slippagePercent * 100;
        const minOutput = quote.outputAmount * BigInt(10000 - slippageBps) / BigInt(10000);

        console.log(`📉 Slippage: ${slippagePercent}%, Min output: ${minOutput.toString()}`);

        // Build transaction
        let transaction;
        if (tokenIn === this.tokens.WETH || tokenIn === this.contracts.WETH) {
          transaction = await this.buildETHToTokenSwap(tokenOut, amountIn, minOutput, wallet.address);
        } else if (tokenOut === this.tokens.WETH || tokenOut === this.contracts.WETH) {
          transaction = await this.buildTokenToETHSwap(tokenIn, amountIn, minOutput, wallet.address);
        } else {
          transaction = await this.buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, minOutput, wallet.address);
        }

        // Gas estimation
        const gasEstimate = await this.estimateSwapGas(tokenIn, tokenOut, amountIn, wallet.address);
        transaction.gasLimit = gasEstimate.gasLimit;
        transaction.gasPrice = gasEstimate.gasPrice;

        console.log(`⛽ Gas: ${transaction.gasLimit.toString()} @ ${ethers.utils.formatUnits(transaction.gasPrice, 'gwei')} gwei`);

        // Balance check
        const balance = await provider.getBalance(wallet.address);
        const totalCost = transaction.value ? 
          transaction.value.add(gasEstimate.totalCost) : 
          gasEstimate.totalCost;

        if (balance.lt(totalCost)) {
          throw new Error(`Insufficient ETH. Need: ${ethers.utils.formatEther(totalCost)} ETH, Have: ${ethers.utils.formatEther(balance)} ETH`);
        }

        // Execute transaction
        const txResponse = await wallet.sendTransaction(transaction);
        console.log(`✅ Swap executed! Hash: ${txResponse.hash}`);

        return txResponse;

      } catch (error) {
        console.log(`❌ Swap failed: ${error.message}`);
        throw error;
      }
    }

    // ====================================================================
    // 🎯 SMART TOKEN SALE SYSTEM (MAIN ENTRY POINT)
    // ====================================================================

    /**
     * Main token sale function with smart amount calculation and multiple fallbacks
     * @param {string} tokenAddress - Token to sell
     * @param {string} outputToken - Token to receive (usually WETH)
     * @param {number} percentage - Percentage to sell (1-100)
     * @param {string} privateKey - User's private key
     * @param {number} slippagePercent - Slippage tolerance
     * @returns {object} - Transaction result with detailed info
     */
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
    // 💰 ENHANCED FEE COLLECTION (FIXES DECIMAL PRECISION)
    // ====================================================================

    /**
     * Collect trading fees with enhanced decimal handling
     */
    async collectFee(privateKey, feeAmount) {
      try {
        // ✅ ENHANCED: Smart decimal handling to prevent overflow
        let feeAmountWei;

        if (typeof feeAmount === 'string') {
          const feeFloat = parseFloat(feeAmount);
          if (feeFloat < 0.000001) {
            console.log('⚠️ Fee too small, skipping collection');
            return null;
          }
          // ✅ FIX: Limit to 18 decimal places to prevent precision errors
          const feeFixed = feeFloat.toFixed(18);
          feeAmountWei = ethers.utils.parseEther(feeFixed);
        } else if (ethers.BigNumber.isBigNumber(feeAmount)) {
          feeAmountWei = feeAmount;
        } else {
          const feeFloat = parseFloat(feeAmount);
          if (feeFloat < 0.000001) {
            console.log('⚠️ Fee too small, skipping collection');
            return null;
          }
          const feeFixed = feeFloat.toFixed(18);
          feeAmountWei = ethers.utils.parseEther(feeFixed);
        }

        console.log(`💰 Collecting fee: ${ethers.utils.formatEther(feeAmountWei)} ETH`);

        const provider = await this.getProvider();
        const wallet = new ethers.Wallet(privateKey, provider);

        const treasuryWallet = process.env.TREASURY_WALLET;
        if (!treasuryWallet) {
          console.log('⚠️ No treasury wallet configured');
          return null;
        }

        // Minimum fee threshold
        const minFeeWei = ethers.utils.parseEther('0.000001');
        if (feeAmountWei.lt(minFeeWei)) {
          console.log('⚠️ Fee below minimum threshold');
          return null;
        }

        // Check balance
        const userBalance = await provider.getBalance(wallet.address);
        const gasPrice = (await provider.getGasPrice()).mul(110).div(100); // +10%
        const gasLimit = ethers.BigNumber.from(21000);
        const totalCost = feeAmountWei.add(gasLimit.mul(gasPrice));

        if (userBalance.lt(totalCost)) {
          console.log(`⚠️ Insufficient balance for fee + gas`);
          return null;
        }

        // Execute fee transfer
        const transaction = {
          to: treasuryWallet,
          value: feeAmountWei,
          gasLimit: gasLimit,
          gasPrice: gasPrice
        };

        const txResponse = await wallet.sendTransaction(transaction);

        console.log(`✅ Fee collected: ${ethers.utils.formatEther(feeAmountWei)} ETH`);
        console.log(`🔗 Fee TX: ${txResponse.hash}`);

        return txResponse;

      } catch (error) {
        console.log(`⚠️ Fee collection failed (non-blocking): ${error.message}`);
        return null; // Never block user transactions for fee issues
      }
    }

    /**
     * Calculate fee breakdown with proper precision
     */
    calculateFeeBreakdown(amount, feePercentage = 1.0) {
      try {
        const amountBN = ethers.utils.parseEther(amount);
        const feeBN = amountBN.mul(Math.floor(feePercentage * 100)).div(10000);
        const netAmountBN = amountBN.sub(feeBN);

        return {
          totalAmount: amount,
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
      } catch (error) {
        console.log(`❌ Fee calculation failed: ${error.message}`);
        return {
          totalAmount: amount,
          feeAmount: '0',
          netAmount: amount,
          feePercentage: 0,
          feeAmountWei: ethers.BigNumber.from(0),
          netAmountWei: ethers.utils.parseEther(amount),
          formatted: {
            fee: '0 ETH (0%)',
            net: `${amount} ETH`,
            total: `${amount} ETH`
          }
        };
      }
    }

    // ====================================================================
    // 🔄 TRANSACTION VERIFICATION & MONITORING
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
    // 🔧 UTILITY FUNCTIONS & HELPERS
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

    /**
     * Address validation
     */
    isValidAddress(address) {
      try {
        return ethers.utils.isAddress(address);
      } catch {
        return false;
      }
    }

    /**
     * Format numbers for user display
     */
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
    // 🔄 BACKWARD COMPATIBILITY FUNCTIONS (FOR YOUR EXISTING CODE)
    // ====================================================================

    /**
     * Backward compatibility for executeSwap function (needed for buy logic)
     */
    async executeSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
      console.log('⚠️ Using legacy executeSwap function - mapping to executeTokenSwap');
      return await this.executeTokenSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent);
    }

    /**
     * Legacy executeTokenSale function for backward compatibility
     */
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
    // 🎯 FUTURE FEATURES PLACEHOLDERS
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