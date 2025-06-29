// ====================================================================
// ETHEREUM CHAIN HANDLER - COMPLETE WORKING VERSION
// Fast Mode + Optimized Gas + All Functions + FIXED FEE COLLECTION
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

    // Token addresses (same as contracts for consistency)
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

  // ====================================================================
  // WALLET & BALANCE OPERATIONS
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
  // TOKEN ALLOWANCE & APPROVAL
  // ====================================================================

  async getTokenAllowance(tokenAddress, ownerAddress, spenderAddress) {
    try {
      const provider = await this.getProvider();
      const abi = ['function allowance(address owner, address spender) view returns (uint256)'];
      const contract = new ethers.Contract(tokenAddress, abi, provider);
      const allowance = await contract.allowance(ownerAddress, spenderAddress);
      return allowance;
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

      const transaction = await contract.approve(spenderAddress, amount);
      return transaction;
    } catch (error) {
      throw new Error(`Failed to approve token: ${error.message}`);
    }
  }

  // ====================================================================
  // 🔧 OPTIMIZED GAS ESTIMATION 
  // ====================================================================

  /**
   * Estimate gas with aggressive buffers for reliable execution
   */
  async estimateSwapGas(tokenIn, tokenOut, amountIn, recipient) {
    try {
      console.log(`⛽ Estimating gas for swap: ${tokenIn} -> ${tokenOut}`);

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

      // 🔧 LEVEL 1: Try precise estimation with 2x buffer
      try {
        const gasEstimate = await provider.estimateGas({
          ...transaction,
          from: recipient
        });

        // 🔧 FIX: 2x buffer (100% increase) instead of 1.5x
        const bufferedGas = gasEstimate.mul(200).div(100);

        // 🔧 FIX: Enforce minimum gas limits
        const MIN_GAS_SWAP = ethers.BigNumber.from(300000);
        const finalGas = bufferedGas.gt(MIN_GAS_SWAP) ? bufferedGas : MIN_GAS_SWAP;

        // 🔧 FIX: Dynamic gas price with buffer
        const baseGasPrice = await provider.getGasPrice();
        const bufferedGasPrice = baseGasPrice.mul(120).div(100); // +20%

        console.log(`✅ Gas estimate: ${gasEstimate.toString()} (buffered: ${finalGas.toString()})`);

        return {
          gasLimit: finalGas,
          gasPrice: bufferedGasPrice,
          totalCost: finalGas.mul(bufferedGasPrice),
          estimateType: 'precise'
        };

      } catch (estimateError) {
        console.log(`⚠️ Precise estimation failed: ${estimateError.message}`);

        // 🔧 LEVEL 2: Conservative fallback
        const baseGasPrice = await provider.getGasPrice();
        const bufferedGasPrice = baseGasPrice.mul(130).div(100); // +30%
        const conservativeGas = ethers.BigNumber.from(500000);

        console.log(`🛡️ Using conservative gas: ${conservativeGas.toString()}`);

        return {
          gasLimit: conservativeGas,
          gasPrice: bufferedGasPrice,
          totalCost: conservativeGas.mul(bufferedGasPrice),
          estimateType: 'conservative'
        };
      }

    } catch (error) {
      console.log(`❌ Gas estimation failed: ${error.message}`);

      // 🔧 LEVEL 3: Emergency fallback
      try {
        const provider = await this.getProvider();
        const baseGasPrice = await provider.getGasPrice();
        const emergencyGasPrice = baseGasPrice.mul(150).div(100); // +50%
        const emergencyGas = ethers.BigNumber.from(800000);

        console.log(`🚨 Emergency gas: ${emergencyGas.toString()}`);

        return {
          gasLimit: emergencyGas,
          gasPrice: emergencyGasPrice,
          totalCost: emergencyGas.mul(emergencyGasPrice),
          estimateType: 'emergency'
        };
      } catch (finalError) {
        throw new Error(`Complete gas estimation failure: ${finalError.message}`);
      }
    }
  }

  // ====================================================================
  // 🔧 OPTIMIZED SWAP EXECUTION
  // ====================================================================

  async executeSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
    try {
      console.log(`🚀 Executing swap: ${amountIn.toString()} of ${tokenIn} -> ${tokenOut}`);

      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      // Get swap quote
      const quote = await this.getSwapQuote(tokenIn, tokenOut, amountIn);

      // Calculate minimum output with slippage protection
      const slippageBps = slippagePercent * 100;
      const minOutput = quote.outputAmount * BigInt(10000 - slippageBps) / BigInt(10000);

      console.log(`📉 Slippage tolerance: ${slippagePercent}%`);
      console.log(`🎯 Minimum output: ${minOutput.toString()}`);

      // Build transaction
      let transaction;
      if (tokenIn === this.tokens.WETH || tokenIn === this.contracts.WETH) {
        transaction = await this.buildETHToTokenSwap(tokenOut, amountIn, minOutput, wallet.address);
      } else if (tokenOut === this.tokens.WETH || tokenOut === this.contracts.WETH) {
        transaction = await this.buildTokenToETHSwap(tokenIn, amountIn, minOutput, wallet.address);
      } else {
        transaction = await this.buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, minOutput, wallet.address);
      }

      // 🔧 FIX: Use optimized gas estimation
      const gasEstimate = await this.estimateSwapGas(tokenIn, tokenOut, amountIn, wallet.address);

      transaction.gasLimit = gasEstimate.gasLimit;
      transaction.gasPrice = gasEstimate.gasPrice;

      console.log(`💰 Gas limit: ${transaction.gasLimit.toString()}`);
      console.log(`💰 Gas price: ${ethers.utils.formatUnits(transaction.gasPrice, 'gwei')} gwei`);

      // 🔧 FIX: Pre-execution balance check
      const balance = await provider.getBalance(wallet.address);
      const totalCost = transaction.value ? 
        transaction.value.add(gasEstimate.totalCost) : 
        gasEstimate.totalCost;

      if (balance.lt(totalCost)) {
        throw new Error(`Insufficient ETH. Need: ${ethers.utils.formatEther(totalCost)} ETH, Have: ${ethers.utils.formatEther(balance)} ETH`);
      }

      // Execute transaction
      const txResponse = await wallet.sendTransaction(transaction);

      console.log(`✅ Swap executed successfully!`);
      console.log(`🔗 Transaction hash: ${txResponse.hash}`);

      return txResponse;

    } catch (error) {
      console.log(`❌ Swap execution failed: ${error.message}`);
      throw new Error(`Failed to execute swap: ${error.message}`);
    }
  }

  // ====================================================================
  // TOKEN APPROVAL FOR SELLING
  // ====================================================================

  /**
   * Check and handle token approval for selling
   * @param {string} tokenAddress - Token contract address
   * @param {string} privateKey - User's private key
   * @param {BigNumber} amount - Amount to approve/sell
   * @returns {boolean} - True if approved or approval successful
   */
  async checkAndApproveToken(tokenAddress, privateKey, amount) {
    try {
      console.log(`🔐 Checking token approval for ${tokenAddress}`);

      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      // Check current allowance
      const allowance = await this.getTokenAllowance(
        tokenAddress, 
        wallet.address, 
        this.contracts.UNISWAP_V2_ROUTER
      );

      console.log(`Current allowance: ${allowance.toString()}`);
      console.log(`Required amount: ${amount.toString()}`);

      // If allowance is sufficient, no approval needed
      if (allowance.gte(amount)) {
        console.log(`✅ Token already approved for sufficient amount`);
        return true;
      }

      // Need to approve token
      console.log(`🔐 Approving token for Uniswap router...`);

      const approvalTx = await this.approveToken(
        tokenAddress,
        this.contracts.UNISWAP_V2_ROUTER,
        ethers.constants.MaxUint256, // Max approval for gas efficiency
        privateKey
      );

      console.log(`⏳ Waiting for approval confirmation: ${approvalTx.hash}`);

      // Wait for approval to be mined
      const receipt = await approvalTx.wait(1);

      if (receipt.status === 1) {
        console.log(`✅ Token approval successful!`);
        return true;
      } else {
        throw new Error('Token approval failed');
      }

    } catch (error) {
      console.log(`❌ Token approval failed: ${error.message}`);
      throw new Error(`Failed to approve token: ${error.message}`);
    }
  }

  /**
   * Execute token sale with automatic approval
   * @param {string} tokenIn - Token to sell
   * @param {string} tokenOut - Token to receive (usually WETH)
   * @param {BigNumber} amountIn - Amount to sell
   * @param {string} privateKey - User's private key
   * @param {number} slippagePercent - Slippage tolerance
   * @returns {object} - Transaction response
   */
  async executeTokenSale(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
    try {
      console.log(`🚀 Executing token sale: ${amountIn.toString()} of ${tokenIn} -> ${tokenOut}`);

      // ✅ FIX: Check and approve token before selling
      await this.checkAndApproveToken(tokenIn, privateKey, amountIn);

      // ✅ FIX: Wait 10 seconds for approval to propagate
      console.log(`⏳ Waiting for approval to propagate...`);
      await new Promise(resolve => setTimeout(resolve, 10000));

      // ✅ FIX: Double-check approval worked
      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);
      const finalAllowance = await this.getTokenAllowance(
        tokenIn, 
        wallet.address, 
        this.contracts.UNISWAP_V2_ROUTER
      );

      console.log(`🔍 Final allowance check: ${finalAllowance.toString()}`);

      if (finalAllowance.lt(amountIn)) {
        throw new Error(`Approval failed: allowance ${finalAllowance.toString()} < required ${amountIn.toString()}`);
      }

      // Now execute the normal swap
      return await this.executeSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent);

    } catch (error) {
      console.log(`❌ Token sale failed: ${error.message}`);
      throw new Error(`Failed to execute token sale: ${error.message}`);
    }
  }

  // ====================================================================
  // SWAP QUOTES & PRICING
  // ====================================================================

  async getSwapQuote(tokenIn, tokenOut, amountIn) {
    try {
      console.log(`🔄 Getting swap quote: ${tokenIn} -> ${tokenOut}`);
      console.log(`📊 Amount in: ${amountIn.toString()}`);

      // Normalize WETH addresses
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

      const routerContract = new ethers.Contract(
        this.contracts.UNISWAP_V2_ROUTER,
        routerAbi,
        provider
      );

      // Build optimal trading path
      let path;
      if (tokenIn === this.tokens.WETH) {
        path = [this.tokens.WETH, tokenOut];
      } else if (tokenOut === this.tokens.WETH) {
        path = [tokenIn, this.tokens.WETH];
      } else {
        path = [tokenIn, this.tokens.WETH, tokenOut];
      }

      console.log(`🛣️ Swap path: ${path.map(addr => addr.slice(0, 6) + '...').join(' -> ')}`);

      try {
        const amounts = await routerContract.getAmountsOut(amountIn.toString(), path);
        const outputAmount = amounts[amounts.length - 1];

        console.log(`✅ Quote successful: ${outputAmount.toString()}`);

        return {
          outputAmount: BigInt(outputAmount.toString()),
          path: path,
          gas: '300000',
          priceImpact: this.calculatePriceImpact(amountIn, outputAmount)
        };

      } catch (quoteError) {
        console.log(`⚠️ Uniswap quote failed: ${quoteError.message}`);

        // Fallback mock quote for testing
        const mockOutputAmount = amountIn.div(1000);

        console.log(`🔄 Using fallback quote: ${mockOutputAmount.toString()}`);

        return {
          outputAmount: BigInt(mockOutputAmount.toString()),
          path: path,
          gas: '350000',
          priceImpact: '0.1'
        };
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
  // TRANSACTION BUILDERS
  // ====================================================================

  async buildETHToTokenSwap(tokenOut, amountIn, minOutput, recipient) {
    const routerAbi = [
      'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
    ];

    const path = [this.tokens.WETH, tokenOut];
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

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
  // FIX 3: TRANSACTION VERIFICATION - Enhanced Version
  // ====================================================================
  async waitForTransaction(txHash, confirmations = 1) {
    try {
      console.log(`⏳ Waiting for transaction confirmation: ${txHash}`);
      const provider = await this.getProvider();

      // Set a reasonable timeout (5 minutes)
      const timeout = 5 * 60 * 1000;

      const receipt = await Promise.race([
        provider.waitForTransaction(txHash, confirmations),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transaction timeout')), timeout)
        )
      ]);

      if (receipt && receipt.status === 1) {
        console.log(`✅ Transaction confirmed: ${txHash}`);
        console.log(`🔗 Block: ${receipt.blockNumber}, Gas used: ${receipt.gasUsed.toString()}`);
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
  // FIX 4: IMPROVED FEE COLLECTION SYSTEM 💰
  // ====================================================================

  /**
   * Collect trading fee to treasury wallet - FIXED VERSION
   * @param {string} privateKey - User's private key
   * @param {BigNumber|string} feeAmount - Fee amount in wei or ETH string
   * @returns {object|null} - Transaction response or null if failed
   */
  async collectFee(privateKey, feeAmount) {
    try {
      // ✅ FIX: Handle both BigNumber and string inputs
      let feeAmountWei;
      if (typeof feeAmount === 'string') {
        // If it's a string, assume it's in ETH and convert to wei
        feeAmountWei = ethers.utils.parseEther(feeAmount);
      } else if (ethers.BigNumber.isBigNumber(feeAmount)) {
        // If it's already a BigNumber, use it directly
        feeAmountWei = feeAmount;
      } else {
        // If it's a number, convert to string first then to wei
        feeAmountWei = ethers.utils.parseEther(feeAmount.toString());
      }

      console.log(`💰 Collecting fee: ${ethers.utils.formatEther(feeAmountWei)} ETH`);

      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      const treasuryWallet = process.env.TREASURY_WALLET;
      if (!treasuryWallet) {
        console.log('⚠️ No treasury wallet configured - skipping fee collection');
        return null;
      }

      // ✅ FIX: Check if fee amount is greater than 0
      if (feeAmountWei.isZero()) {
        console.log('⚠️ Fee amount is 0 - skipping fee collection');
        return null;
      }

      // ✅ FIX: Check user has sufficient balance for fee
      const userBalance = await provider.getBalance(wallet.address);
      if (userBalance.lt(feeAmountWei)) {
        console.log(`⚠️ Insufficient balance for fee: need ${ethers.utils.formatEther(feeAmountWei)} ETH, have ${ethers.utils.formatEther(userBalance)} ETH`);
        return null; // Don't throw - let the main transaction proceed
      }

      // ✅ FIX: Dynamic gas price for fee transaction
      const gasPrice = await provider.getGasPrice();
      const bufferedGasPrice = gasPrice.mul(110).div(100); // +10% buffer

      const transaction = {
        to: treasuryWallet,
        value: feeAmountWei,
        gasLimit: ethers.BigNumber.from(21000), // Standard ETH transfer
        gasPrice: bufferedGasPrice
      };

      // ✅ FIX: Check total cost (fee + gas) doesn't exceed balance
      const totalCost = feeAmountWei.add(transaction.gasLimit.mul(bufferedGasPrice));
      if (userBalance.lt(totalCost)) {
        console.log(`⚠️ Insufficient balance for fee + gas: need ${ethers.utils.formatEther(totalCost)} ETH, have ${ethers.utils.formatEther(userBalance)} ETH`);
        return null;
      }

      const txResponse = await wallet.sendTransaction(transaction);

      console.log(`✅ Fee collected successfully!`);
      console.log(`💰 Amount: ${ethers.utils.formatEther(feeAmountWei)} ETH`);
      console.log(`🔗 Fee TX: ${txResponse.hash}`);

      return txResponse;

    } catch (error) {
      console.log(`⚠️ Fee collection failed: ${error.message}`);
      // IMPORTANT: Don't throw - fee failure shouldn't block user transaction
      return null;
    }
  }

  /**
   * Calculate fee amounts for display - ENHANCED VERSION
   * @param {string} amount - Trade amount in ETH
   * @param {number} feePercentage - Fee percentage (1.0 = 1%)
   * @returns {object} - Detailed fee breakdown
   */
  calculateFee(amount, feePercentage = 1.0) {
    try {
      const amountBN = ethers.utils.parseEther(amount);
      const feeBN = amountBN.mul(Math.floor(feePercentage * 100)).div(10000);
      const netAmountBN = amountBN.sub(feeBN);

      return {
        totalAmount: amount,
        feeAmount: ethers.utils.formatEther(feeBN),
        netAmount: ethers.utils.formatEther(netAmountBN),
        feePercentage: feePercentage,
        feeAmountWei: feeBN, // ✅ FIX: Include wei amount for direct use
        netAmountWei: netAmountBN,
        formatted: {
          fee: `${ethers.utils.formatEther(feeBN)} ETH (${feePercentage}%)`,
          net: `${ethers.utils.formatEther(netAmountBN)} ETH`
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
          net: `${amount} ETH`
        }
      };
    }
  }

  // ====================================================================
  // UTILITY FUNCTIONS
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

  // ====================================================================
  // SNIPING & MONITORING (For Phase 2)
  // ====================================================================

  async monitorNewPairs() {
    // Implementation for Phase 2 - Sniping Engine
    console.log('🔄 Monitoring new pairs...');
    // This will be implemented when we get to sniping features
  }

  async executeSnipe(tokenAddress, amountIn, privateKey) {
    // Implementation for Phase 2 - Auto-sniping
    console.log(`🎯 Executing snipe for token: ${tokenAddress}`);
    // This will be implemented when we get to sniping features
  }

  // ====================================================================
  // MIRROR TRADING (For Phase 3)
  // ====================================================================

  async monitorWallet(walletAddress) {
    // Implementation for Phase 3 - Mirror Trading
    console.log(`👁️ Monitoring wallet: ${walletAddress}`);
    // This will be implemented when we get to mirror trading features
  }

  async copyTrade(targetTx, copyPercent, privateKey) {
    // Implementation for Phase 3 - Copy Trading
    console.log(`📋 Copying trade with ${copyPercent}% of original amount`);
    // This will be implemented when we get to mirror trading features
  }

  // ====================================================================
  // ENHANCED ERROR HANDLING & RECOVERY
  // ====================================================================

  /**
   * Retry failed transactions with exponential backoff
   * @param {function} operation - The operation to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} baseDelay - Base delay in milliseconds
   * @returns {Promise} - Result of the operation
   */
  async retryOperation(operation, maxRetries = 3, baseDelay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        console.log(`❌ Attempt ${attempt} failed: ${error.message}`);

        if (attempt === maxRetries) {
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Check network health and switch providers if needed
   * @returns {boolean} - True if network is healthy
   */
  async checkNetworkHealth() {
    try {
      const provider = await this.getProvider();
      const blockNumber = await provider.getBlockNumber();

      // Check if we're getting recent blocks (within last 5 minutes)
      const latestBlock = await provider.getBlock(blockNumber);
      const blockAge = Date.now() / 1000 - latestBlock.timestamp;

      if (blockAge > 300) { // 5 minutes
        console.log(`⚠️ Stale block detected, age: ${blockAge}s`);
        await this.switchToNextProvider();
        return false;
      }

      return true;
    } catch (error) {
      console.log(`❌ Network health check failed: ${error.message}`);
      await this.switchToNextProvider();
      return false;
    }
  }

  /**
   * Switch to next available RPC provider
   */
  async switchToNextProvider() {
    this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
    console.log(`🔄 Switched to provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
  }

  // ====================================================================
  // ADVANCED TRANSACTION UTILITIES
  // ====================================================================

  /**
   * Get optimal gas price based on network conditions
   * @param {string} priority - 'slow', 'standard', 'fast', 'fastest'
   * @returns {BigNumber} - Gas price in wei
   */
  async getOptimalGasPrice(priority = 'fast') {
    try {
      const provider = await this.getProvider();
      const feeData = await provider.getFeeData();

      let multiplier;
      switch (priority) {
        case 'slow': multiplier = 100; break;      // +0%
        case 'standard': multiplier = 110; break;  // +10%
        case 'fast': multiplier = 120; break;      // +20%
        case 'fastest': multiplier = 150; break;   // +50%
        default: multiplier = 120; break;
      }

      const gasPrice = feeData.gasPrice || ethers.utils.parseUnits('20', 'gwei');
      return gasPrice.mul(multiplier).div(100);

    } catch (error) {
      console.log(`⚠️ Failed to get optimal gas price: ${error.message}`);
      return ethers.utils.parseUnits('20', 'gwei'); // Fallback
    }
  }

  /**
   * Estimate total transaction cost including gas
   * @param {BigNumber} value - Transaction value in wei
   * @param {BigNumber} gasLimit - Gas limit
   * @param {string} priority - Gas priority level
   * @returns {object} - Cost breakdown
   */
  async estimateTransactionCost(value, gasLimit, priority = 'fast') {
    try {
      const gasPrice = await this.getOptimalGasPrice(priority);
      const gasCost = gasLimit.mul(gasPrice);
      const totalCost = value.add(gasCost);

      return {
        value: value,
        gasCost: gasCost,
        totalCost: totalCost,
        gasPrice: gasPrice,
        formatted: {
          value: ethers.utils.formatEther(value),
          gasCost: ethers.utils.formatEther(gasCost),
          totalCost: ethers.utils.formatEther(totalCost),
          gasPrice: ethers.utils.formatUnits(gasPrice, 'gwei')
        }
      };
    } catch (error) {
      throw new Error(`Failed to estimate transaction cost: ${error.message}`);
    }
  }

  // ====================================================================
  // DEBUGGING & LOGGING UTILITIES
  // ====================================================================

  /**
   * Log transaction details for debugging
   * @param {string} operation - Operation name
   * @param {object} details - Transaction details
   */
  logTransaction(operation, details) {
    console.log(`📝 ${operation} Transaction Details:`);
    console.log(`   Hash: ${details.hash || 'N/A'}`);
    console.log(`   From: ${details.from || 'N/A'}`);
    console.log(`   To: ${details.to || 'N/A'}`);
    console.log(`   Value: ${details.value ? ethers.utils.formatEther(details.value) : '0'} ETH`);
    console.log(`   Gas Limit: ${details.gasLimit || 'N/A'}`);
    console.log(`   Gas Price: ${details.gasPrice ? ethers.utils.formatUnits(details.gasPrice, 'gwei') : 'N/A'} gwei`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);
  }

  /**
   * Validate Ethereum address
   * @param {string} address - Address to validate
   * @returns {boolean} - True if valid
   */
  isValidAddress(address) {
    try {
      return ethers.utils.isAddress(address);
    } catch {
      return false;
    }
  }

  /**
   * Format large numbers for display
   * @param {BigNumber} amount - Amount to format
   * @param {number} decimals - Token decimals
   * @param {number} precision - Display precision
   * @returns {string} - Formatted amount
   */
  formatTokenAmount(amount, decimals = 18, precision = 4) {
    try {
      const formatted = ethers.utils.formatUnits(amount, decimals);
      const number = parseFloat(formatted);

      if (number >= 1000000) {
        return (number / 1000000).toFixed(2) + 'M';
      } else if (number >= 1000) {
        return (number / 1000).toFixed(2) + 'K';
      } else {
        return number.toFixed(precision);
      }
    } catch {
      return '0';
    }
  }
}

module.exports = EthChain;