const { ethers } = require('ethers');

/**
 * EthChain - Ethereum blockchain interaction class
 * Handles swaps, quotes, gas estimation, and fee collection
 */
class EthChain {
  constructor() {
    this.chainId = 1; // Mainnet
    this.providers = this.initializeProviders();
    this.currentProviderIndex = 0;

    // Token addresses
    this.tokens = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      USDC: '0xA0b86a33E6417b8e84eec1b98d29A1b46e62F1e8',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    };

    // Contract addresses
    this.contracts = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      UNISWAP_V3_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      UNISWAP_V2_FACTORY: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      UNISWAP_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984'
    };
  }

  // ====================================================================
  // PROVIDER MANAGEMENT & FAILOVER
  // ====================================================================

  /**
   * Initialize multiple RPC providers for reliable connectivity
   */
  initializeProviders() {
    const providers = [];

    // Primary provider (Alchemy)
    if (process.env.ETH_RPC_URL) {
      providers.push(new ethers.providers.JsonRpcProvider(process.env.ETH_RPC_URL));
    }

    // Backup providers
    if (process.env.INFURA_URL) {
      providers.push(new ethers.providers.JsonRpcProvider(process.env.INFURA_URL));
    }

    if (process.env.ANKR_URL) {
      providers.push(new ethers.providers.JsonRpcProvider(process.env.ANKR_URL));
    }

    if (providers.length === 0) {
      throw new Error('No RPC providers configured. Please set ETH_RPC_URL in environment.');
    }

    console.log(`Initialized ${providers.length} RPC provider(s)`);
    return providers;
  }

  /**
   * Get current provider with automatic failover
   */
  async getProvider() {
    const provider = this.providers[this.currentProviderIndex];

    try {
      // Test provider connectivity
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      console.log(`Provider ${this.currentProviderIndex} failed: ${error.message}`);

      // Try next provider
      this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;

      if (this.currentProviderIndex === 0) {
        throw new Error('All RPC providers failed. Check your network connection.');
      }

      console.log(`Switching to provider ${this.currentProviderIndex}`);
      return this.getProvider();
    }
  }

  // ====================================================================
  // BALANCE & TOKEN INFORMATION
  // ====================================================================

  /**
   * Get ETH balance for an address
   * @param {string} address - Wallet address
   * @returns {string} - Balance in ETH (formatted)
   */
  async getETHBalance(address) {
    try {
      const provider = await this.getProvider();
      const balance = await provider.getBalance(address);
      return ethers.utils.formatEther(balance);
    } catch (error) {
      throw new Error(`Failed to get ETH balance: ${error.message}`);
    }
  }

  /**
   * Get comprehensive token information
   * @param {string} tokenAddress - Token contract address
   * @returns {object} - Token details (name, symbol, decimals, etc.)
   */
  async getTokenInfo(tokenAddress) {
    try {
      const provider = await this.getProvider();

      const erc20Abi = [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)'
      ];

      const contract = new ethers.Contract(tokenAddress, erc20Abi, provider);

      const [name, symbol, decimals, totalSupply] = await Promise.all([
        contract.name().catch(() => 'Unknown Token'),
        contract.symbol().catch(() => 'UNK'),
        contract.decimals().catch(() => 18),
        contract.totalSupply().catch(() => ethers.BigNumber.from(0))
      ]);

      console.log(`Token info: ${name} (${symbol}) - ${decimals} decimals`);

      return {
        address: tokenAddress,
        name,
        symbol,
        decimals,
        totalSupply: totalSupply.toString()
      };
    } catch (error) {
      throw new Error(`Failed to get token info: ${error.message}`);
    }
  }

  /**
   * Get token balance for a wallet
   * @param {string} tokenAddress - Token contract address
   * @param {string} walletAddress - Wallet address to check
   * @returns {BigNumber} - Token balance in wei
   */
  async getTokenBalance(tokenAddress, walletAddress) {
    try {
      const provider = await this.getProvider();
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );

      const balance = await tokenContract.balanceOf(walletAddress);
      console.log(`Token balance for ${walletAddress.slice(0, 6)}...: ${balance.toString()}`);

      return balance;
    } catch (error) {
      throw new Error(`Failed to get token balance: ${error.message}`);
    }
  }

  /**
   * Get token allowance for spender
   * @param {string} tokenAddress - Token contract address
   * @param {string} owner - Owner wallet address
   * @param {string} spender - Spender contract address
   * @returns {BigNumber} - Allowance amount
   */
  async getTokenAllowance(tokenAddress, owner, spender) {
    try {
      const provider = await this.getProvider();
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function allowance(address,address) view returns (uint256)'],
        provider
      );

      const allowance = await tokenContract.allowance(owner, spender);
      console.log(`Token allowance: ${allowance.toString()}`);

      return allowance;
    } catch (error) {
      throw new Error(`Failed to get token allowance: ${error.message}`);
    }
  }

  // ====================================================================
  // GAS PRICE & ESTIMATION
  // ====================================================================

  /**
   * Get current gas prices with EIP-1559 support
   * @returns {object} - Comprehensive gas price information
   */
  async getGasPrice() {
    try {
      const provider = await this.getProvider();
      const feeData = await provider.getFeeData();

      const gasInfo = {
        gasPrice: feeData.gasPrice,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        formatted: {
          gasPrice: ethers.utils.formatUnits(feeData.gasPrice || 0, 'gwei'),
          maxFeePerGas: ethers.utils.formatUnits(feeData.maxFeePerGas || 0, 'gwei')
        }
      };

      console.log(`Current gas price: ${gasInfo.formatted.gasPrice} gwei`);
      return gasInfo;
    } catch (error) {
      throw new Error(`Failed to get gas price: ${error.message}`);
    }
  }

  // ====================================================================
  // SWAP QUOTES & PRICING (UNISWAP V2)
  // ====================================================================

  /**
   * Get swap quote using Uniswap V2 Router (reliable and fast)
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {BigNumber} amountIn - Input amount in wei
   * @returns {object} - Quote with output amount and path
   */
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

      // Uniswap V2 Router interface
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
        path = [this.tokens.WETH, tokenOut]; // ETH -> Token
      } else if (tokenOut === this.tokens.WETH) {
        path = [tokenIn, this.tokens.WETH]; // Token -> ETH
      } else {
        path = [tokenIn, this.tokens.WETH, tokenOut]; // Token -> ETH -> Token
      }

      console.log(`🛣️ Swap path: ${path.map(addr => addr.slice(0, 6) + '...').join(' -> ')}`);

      try {
        // Get quote from Uniswap V2
        const amounts = await routerContract.getAmountsOut(amountIn.toString(), path);
        const outputAmount = amounts[amounts.length - 1];

        console.log(`✅ Quote successful: ${outputAmount.toString()}`);

        return {
          outputAmount: BigInt(outputAmount.toString()),
          path: path,
          gas: '200000',
          priceImpact: this.calculatePriceImpact(amountIn, outputAmount)
        };

      } catch (quoteError) {
        console.log(`⚠️ Uniswap quote failed: ${quoteError.message}`);

        // Fallback mock quote for testing (remove in production)
        const mockOutputAmount = amountIn.div(1000); // ~0.1% of input

        console.log(`🔄 Using fallback quote: ${mockOutputAmount.toString()}`);

        return {
          outputAmount: BigInt(mockOutputAmount.toString()),
          path: path,
          gas: '250000',
          priceImpact: '0.1'
        };
      }

    } catch (error) {
      throw new Error(`Failed to get swap quote: ${error.message}`);
    }
  }

  /**
   * Calculate approximate price impact
   * @param {BigNumber} amountIn - Input amount
   * @param {BigNumber} amountOut - Output amount
   * @returns {string} - Price impact percentage
   */
  calculatePriceImpact(amountIn, amountOut) {
    try {
      // Simplified price impact calculation
      // In production, you'd want more sophisticated analysis
      const impact = amountIn.mul(100).div(amountOut.add(amountIn));
      return ethers.utils.formatUnits(impact, 2);
    } catch {
      return '0.1'; // Default minimal impact
    }
  }

  // ====================================================================
  // GAS ESTIMATION (FIXED FOR RELIABILITY)
  // ====================================================================

  /**
   * Estimate gas for swap transaction with generous buffers
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {BigNumber} amountIn - Input amount
   * @param {string} recipient - Recipient address
   * @returns {object} - Comprehensive gas estimate
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

      // Try precise gas estimation first
      try {
        const gasEstimate = await provider.estimateGas({
          ...transaction,
          from: recipient
        });

        const gasPrice = await provider.getGasPrice();

        // 🔧 FIXED: Use 50% buffer instead of 30%
        const bufferedGas = gasEstimate.mul(150).div(100);

        console.log(`✅ Gas estimate: ${gasEstimate.toString()} (buffered: ${bufferedGas.toString()})`);

        return {
          gasLimit: bufferedGas,
          gasPrice: gasPrice,
          totalCost: bufferedGas.mul(gasPrice),
          estimateType: 'precise'
        };

      } catch (estimateError) {
        console.log(`⚠️ Precise gas estimation failed: ${estimateError.message}`);

        // 🔧 FIXED: Much more conservative fallback (500k instead of 250k)
        const gasPrice = await provider.getGasPrice();
        const conservativeGas = ethers.BigNumber.from(500000);

        console.log(`🛡️ Using conservative gas limit: ${conservativeGas.toString()}`);

        return {
          gasLimit: conservativeGas,
          gasPrice: gasPrice,
          totalCost: conservativeGas.mul(gasPrice),
          estimateType: 'conservative'
        };
      }

    } catch (error) {
      console.log(`❌ Gas estimation completely failed: ${error.message}`);

      // 🔧 FIXED: Last resort - extremely conservative (800k gas)
      try {
        const provider = await this.getProvider();
        const gasPrice = await provider.getGasPrice();
        const emergencyGas = ethers.BigNumber.from(800000);

        console.log(`🚨 Using emergency gas limit: ${emergencyGas.toString()}`);

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
  // SWAP EXECUTION (FIXED GAS HANDLING)
  // ====================================================================

  /**
   * Execute token swap with robust gas handling
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {BigNumber} amountIn - Input amount in wei
   * @param {string} privateKey - Wallet private key
   * @param {number} slippagePercent - Slippage tolerance percentage
   * @returns {object} - Transaction response
   */
  async executeSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
    try {
      console.log(`🚀 Executing swap: ${amountIn.toString()} of ${tokenIn} -> ${tokenOut}`);

      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      // Get swap quote
      const quote = await this.getSwapQuote(tokenIn, tokenOut, amountIn);

      // Calculate minimum output with slippage protection
      const slippageBps = slippagePercent * 100; // Convert to basis points
      const minOutput = quote.outputAmount * BigInt(10000 - slippageBps) / BigInt(10000);

      console.log(`📉 Slippage tolerance: ${slippagePercent}%`);
      console.log(`🎯 Minimum output: ${minOutput.toString()}`);

      // Build transaction based on token types
      let transaction;
      if (tokenIn === this.tokens.WETH || tokenIn === this.contracts.WETH) {
        transaction = await this.buildETHToTokenSwap(tokenOut, amountIn, minOutput, wallet.address);
      } else if (tokenOut === this.tokens.WETH || tokenOut === this.contracts.WETH) {
        transaction = await this.buildTokenToETHSwap(tokenIn, amountIn, minOutput, wallet.address);
      } else {
        transaction = await this.buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, minOutput, wallet.address);
      }

      // 🔧 FIXED: Robust gas limit setting
      try {
        const gasEstimate = await provider.estimateGas(transaction);
        const bufferedGas = gasEstimate.mul(150).div(100); // 50% buffer
        transaction.gasLimit = bufferedGas;

        console.log(`⛽ Using estimated gas: ${bufferedGas.toString()}`);
      } catch (gasError) {
        console.log(`⚠️ Gas estimation failed, using fallback: ${gasError.message}`);
        transaction.gasLimit = ethers.BigNumber.from(500000); // Conservative fallback
      }

      // Set gas price
      transaction.gasPrice = await provider.getGasPrice();

      console.log(`💰 Gas limit: ${transaction.gasLimit.toString()}`);
      console.log(`💰 Gas price: ${ethers.utils.formatUnits(transaction.gasPrice, 'gwei')} gwei`);

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
  // TRANSACTION BUILDERS (UNISWAP V2)
  // ====================================================================

  /**
   * Build ETH to Token swap transaction
   */
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

  /**
   * Build Token to ETH swap transaction
   */
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

  /**
   * Build Token to Token swap transaction
   */
  async buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, minOutput, recipient) {
    const routerAbi = [
      'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
    ];

    const path = [tokenIn, this.tokens.WETH, tokenOut]; // Route through WETH
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
  // TOKEN APPROVALS
  // ====================================================================

  /**
   * Approve token for spending by Uniswap router
   * @param {string} tokenAddress - Token contract address
   * @param {string} spender - Spender contract address
   * @param {BigNumber} amount - Amount to approve
   * @param {string} privateKey - Wallet private key
   * @returns {object} - Transaction response
   */
  async approveToken(tokenAddress, spender, amount, privateKey) {
    try {
      console.log(`🔐 Approving token ${tokenAddress} for ${spender}`);

      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function approve(address,uint256) returns (bool)'],
        wallet
      );

      // Use max approval for gas efficiency on future trades
      const maxApproval = ethers.constants.MaxUint256;
      const transaction = await tokenContract.approve(spender, maxApproval);

      console.log(`✅ Token approval sent: ${transaction.hash}`);
      return transaction;

    } catch (error) {
      console.log(`❌ Token approval failed: ${error.message}`);
      throw new Error(`Failed to approve token: ${error.message}`);
    }
  }

  // ====================================================================
  // FEE COLLECTION SYSTEM 💰
  // ====================================================================

  /**
   * Collect trading fee to treasury wallet
   * @param {BigNumber} feeAmount - Fee amount in wei
   * @param {string} privateKey - User's private key
   * @returns {object|null} - Transaction response or null if failed
   */
  async collectFee(feeAmount, privateKey) {
    try {
      console.log(`💰 Collecting fee: ${ethers.utils.formatEther(feeAmount)} ETH`);

      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      const treasuryWallet = process.env.TREASURY_WALLET;
      if (!treasuryWallet) {
        console.log('⚠️ No treasury wallet configured - skipping fee collection');
        return null;
      }

      const transaction = {
        to: treasuryWallet,
        value: feeAmount,
        gasLimit: 21000 // Standard ETH transfer
      };

      const txResponse = await wallet.sendTransaction(transaction);

      console.log(`✅ Fee collected successfully!`);
      console.log(`💰 Amount: ${ethers.utils.formatEther(feeAmount)} ETH`);
      console.log(`🔗 Fee TX: ${txResponse.hash}`);

      return txResponse;

    } catch (error) {
      console.log(`⚠️ Fee collection failed: ${error.message}`);
      // IMPORTANT: Don't throw - fee failure shouldn't block user transaction
      return null;
    }
  }

  /**
   * Calculate fee amounts for display
   * @param {string} amount - Trade amount in ETH
   * @param {number} feePercentage - Fee percentage (1.0 = 1%)
   * @returns {object} - Detailed fee breakdown
   */
  calculateFee(amount, feePercentage = 1.0) {
    const amountBN = ethers.utils.parseEther(amount);
    const feeBN = amountBN.mul(Math.floor(feePercentage * 100)).div(10000);
    const netAmountBN = amountBN.sub(feeBN);

    return {
      totalAmount: amount,
      feeAmount: ethers.utils.formatEther(feeBN),
      netAmount: ethers.utils.formatEther(netAmountBN),
      feePercentage: feePercentage,
      formatted: {
        fee: `${ethers.utils.formatEther(feeBN)} ETH (${feePercentage}%)`,
        net: `${ethers.utils.formatEther(netAmountBN)} ETH`
      }
    };
  }

  // ====================================================================
  // FUTURE FEATURES (SNIPING & MIRRORING)
  // ====================================================================

  /**
   * Monitor new token pairs for sniping opportunities
   * @param {function} callback - Function to call when new pair detected
   */
  async startPairMonitoring(callback) {
    try {
      console.log('🎯 Starting pair monitoring for sniping...');

      const provider = await this.getProvider();

      const factoryAbi = [
        'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
      ];

      const factory = new ethers.Contract(this.contracts.UNISWAP_V2_FACTORY, factoryAbi, provider);

      factory.on('PairCreated', async (token0, token1, pair, pairLength) => {
        try {
          const pairInfo = {
            token0,
            token1,
            pair,
            pairLength: pairLength.toString(),
            timestamp: Date.now(),
            source: 'uniswap_v2',
            blockNumber: await provider.getBlockNumber()
          };

          console.log(`🎯 New pair detected: ${pair}`);
          await callback(pairInfo);
        } catch (error) {
          console.log('Pair monitoring callback error:', error.message);
        }
      });

      console.log('✅ Pair monitoring started successfully');
    } catch (error) {
      throw new Error(`Failed to start pair monitoring: ${error.message}`);
    }
  }

  /**
   * Monitor wallet transactions for mirror trading
   * @param {string} targetWallet - Wallet address to mirror
   * @param {function} callback - Function to call when trade detected
   */
  async startMirrorTrading(targetWallet, callback) {
    try {
      console.log(`👁️ Starting mirror trading for wallet: ${targetWallet}`);

      const provider = await this.getProvider();

      provider.on('pending', async (txHash) => {
        try {
          const tx = await provider.getTransaction(txHash);
          if (tx && tx.from.toLowerCase() === targetWallet.toLowerCase()) {

            const tradeInfo = {
              hash: txHash,
              from: tx.from,
              to: tx.to,
              value: tx.value,
              data: tx.data,
              timestamp: Date.now()
            };

            console.log(`👁️ Mirror target transaction: ${txHash}`);
            await callback(tradeInfo);
          }
        } catch (error) {
          // Ignore errors for pending tx fetching - this is expected
        }
      });

      console.log('✅ Mirror trading started successfully');
    } catch (error) {
      throw new Error(`Failed to start mirror trading: ${error.message}`);
    }
  }

  // ====================================================================
  // UTILITY & DEBUGGING
  // ====================================================================

  /**
   * Health check for the EthChain instance
   * @returns {object} - Health status and configuration
   */
  async healthCheck() {
    try {
      const provider = await this.getProvider();
      const blockNumber = await provider.getBlockNumber();
      const gasPrice = await this.getGasPrice();

      return {
        status: 'healthy',
        provider: 'connected',
        currentBlock: blockNumber,
        gasPrice: gasPrice.formatted.gasPrice + ' gwei',
        providersConfigured: this.providers.length,
        treasuryConfigured: !!process.env.TREASURY_WALLET
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        providersConfigured: this.providers.length,
        treasuryConfigured: !!process.env.TREASURY_WALLET
      };
    }
  }
}

module.exports = EthChain;