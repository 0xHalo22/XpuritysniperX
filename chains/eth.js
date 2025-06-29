const { ethers } = require('ethers');
const { AlphaRouter } = require('@uniswap/smart-order-router');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');

class EthChain {
  constructor() {
    this.chainId = 1; // Mainnet
    this.providers = this.initializeProviders();
    this.currentProviderIndex = 0;
    this.router = null;
    this.initializeRouter();

    // Common token addresses
    this.tokens = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      USDC: '0xA0b86a33E6417b8e84eec1b98d29A1b46e62F1e8',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    };

    // Uniswap contract addresses
    this.contracts = {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      UNISWAP_V3_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      UNISWAP_V2_FACTORY: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      UNISWAP_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984'
    };
  }

  /**
   * Initialize multiple RPC providers for failover
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
      throw new Error('No RPC providers configured');
    }

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
      console.log(`Provider ${this.currentProviderIndex} failed, trying next...`);

      // Try next provider
      this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;

      if (this.currentProviderIndex === 0) {
        throw new Error('All RPC providers failed');
      }

      return this.getProvider();
    }
  }

  /**
   * Initialize Uniswap router for optimal routing
   */
  async initializeRouter() {
    try {
      const provider = await this.getProvider();
      this.router = new AlphaRouter({
        chainId: this.chainId,
        provider: provider
      });
    } catch (error) {
      console.log('Router initialization failed:', error.message);
    }
  }

  /**
   * Get ETH balance for an address
   * @param {string} address - Wallet address
   * @returns {string} - Balance in ETH
   */
  async getBalance(address) {
    try {
      const provider = await this.getProvider();
      const balance = await provider.getBalance(address);
      return ethers.utils.formatEther(balance);
    } catch (error) {
      throw new Error(`Failed to get balance: ${error.message}`);
    }
  }

  /**
   * Get ETH balance for an address (alias for compatibility)
   * @param {string} address - Wallet address
   * @returns {string} - Balance in ETH
   */
  async getETHBalance(address) {
    return await this.getBalance(address);
  }

  /**
   * Get current gas price with buffer
   * @returns {object} - Gas price info
   */
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
   * Estimate gas for a transaction with buffer
   * @param {object} transaction - Transaction object
   * @returns {object} - Gas estimate with buffer
   */
  async estimateGas(transaction) {
    try {
      const provider = await this.getProvider();
      const estimate = await provider.estimateGas(transaction);
      const buffered = estimate.mul(120).div(100); // 20% buffer

      const gasPrice = await this.getGasPrice();
      const cost = buffered.mul(gasPrice.gasPrice);

      return {
        gasLimit: buffered,
        gasPrice: gasPrice.gasPrice,
        totalCost: cost,
        formatted: {
          gasLimit: estimate.toString(),
          bufferedLimit: buffered.toString(),
          totalCostETH: ethers.utils.formatEther(cost),
          gasPriceGwei: gasPrice.formatted.gasPrice
        }
      };
    } catch (error) {
      throw new Error(`Gas estimation failed: ${error.message}`);
    }
  }

  /**
   * Get token information
   * @param {string} tokenAddress - Token contract address
   * @returns {object} - Token info
   */
  async getTokenInfo(tokenAddress) {
    try {
      const provider = await this.getProvider();

      // ERC-20 ABI for basic token info
      const erc20Abi = [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)',
        'function balanceOf(address) view returns (uint256)'
      ];

      const contract = new ethers.Contract(tokenAddress, erc20Abi, provider);

      const [name, symbol, decimals, totalSupply] = await Promise.all([
        contract.name(),
        contract.symbol(),
        contract.decimals(),
        contract.totalSupply()
      ]);

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
   * Get token balance for a wallet (returns BigInt for compatibility)
   * @param {string} tokenAddress - Token contract address  
   * @param {string} walletAddress - Wallet address to check
   * @returns {BigInt} Token balance in wei
   */
  async getTokenBalance(tokenAddress, walletAddress) {
    try {
      const provider = await this.getProvider();
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );

      return await tokenContract.balanceOf(walletAddress);
    } catch (error) {
      throw new Error(`Failed to get token balance: ${error.message}`);
    }
  }

  /**
   * Get token allowance for spender
   * @param {string} tokenAddress - Token contract address
   * @param {string} owner - Owner wallet address
   * @param {string} spender - Spender contract address
   * @returns {BigInt} Allowance amount
   */
  async getTokenAllowance(tokenAddress, owner, spender) {
    try {
      const provider = await this.getProvider();
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function allowance(address,address) view returns (uint256)'],
        provider
      );

      return await tokenContract.allowance(owner, spender);
    } catch (error) {
      throw new Error(`Failed to get token allowance: ${error.message}`);
    }
  }

  /**
   * Approve token for spending
   * @param {string} tokenAddress - Token contract address
   * @param {string} spender - Spender contract address  
   * @param {BigInt} amount - Amount to approve
   * @param {string} privateKey - Wallet private key
   * @returns {TransactionResponse} Transaction response
   */
  async approveToken(tokenAddress, spender, amount, privateKey) {
    try {
      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function approve(address,uint256) returns (bool)'],
        wallet
      );

      // Use max uint256 for unlimited approval to save gas on future trades
      const maxApproval = ethers.constants.MaxUint256;

      const transaction = await tokenContract.approve(spender, maxApproval);

      console.log(`Token approval sent: ${transaction.hash}`);
      return transaction;

    } catch (error) {
      throw new Error(`Failed to approve token: ${error.message}`);
    }
  }

  /**
   * Get all token holdings for a wallet
   * @param {string} walletAddress - Wallet address
   * @returns {Array} - Array of token holdings
   */
  async getTokenHoldings(walletAddress) {
    // Note: In production, you'd want to use a service like Alchemy's getTokenBalances
    // For MVP, we'll return empty array and implement properly later
    try {
      // Placeholder - implement with Alchemy API or similar
      return [];
    } catch (error) {
      console.log('Token holdings fetch failed:', error.message);
      return [];
    }
  }

  /**
   * Get swap quote using Uniswap Alpha Router
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address  
   * @param {BigInt} amountIn - Input amount in wei
   * @returns {Object} Quote object with outputAmount and route
   */
  async getSwapQuote(tokenIn, tokenOut, amountIn) {
    try {
      if (!this.router) {
        await this.initializeRouter();
      }

      // Handle WETH properly
      if (tokenIn === this.contracts.WETH || tokenIn.toLowerCase() === 'eth') {
        tokenIn = this.tokens.WETH;
      }
      if (tokenOut === this.contracts.WETH || tokenOut.toLowerCase() === 'eth') {
        tokenOut = this.tokens.WETH;
      }

      // Get token info
      const tokenInInfo = await this.getTokenInfo(tokenIn);
      const tokenOutInfo = await this.getTokenInfo(tokenOut);

      const tokenInObj = new Token(this.chainId, tokenIn, tokenInInfo.decimals, tokenInInfo.symbol, tokenInInfo.name);
      const tokenOutObj = new Token(this.chainId, tokenOut, tokenOutInfo.decimals, tokenOutInfo.symbol, tokenOutInfo.name);

      // Create currency amount
      const currencyAmount = CurrencyAmount.fromRawAmount(tokenInObj, amountIn.toString());

      // Get route
      const route = await this.router.route(
        currencyAmount,
        tokenOutObj,
        TradeType.EXACT_INPUT,
        {
          recipient: ethers.constants.AddressZero, // Will be replaced with actual recipient
          slippageTolerance: new Percent(300, 10000), // 3%
          deadline: Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes
        }
      );

      if (!route) {
        throw new Error('No route found for this trade');
      }

      return {
        outputAmount: BigInt(route.quote.quotient.toString()),
        route: route,
        gas: route.estimatedGasUsed?.toString() || '200000'
      };

    } catch (error) {
      throw new Error(`Failed to get swap quote: ${error.message}`);
    }
  }

  /**
   * Execute token swap
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {BigInt} amountIn - Input amount in wei
   * @param {string} privateKey - Wallet private key
   * @param {number} slippagePercent - Slippage tolerance percentage
   * @returns {TransactionResponse} Transaction response
   */
  async executeSwap(tokenIn, tokenOut, amountIn, privateKey, slippagePercent = 3) {
    try {
      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      // Get quote
      const quote = await this.getSwapQuote(tokenIn, tokenOut, amountIn);

      // Calculate minimum output with slippage
      const slippageBps = slippagePercent * 100; // Convert to basis points
      const minOutput = quote.outputAmount * BigInt(10000 - slippageBps) / BigInt(10000);

      // Build transaction data based on token types
      let transaction;

      if (tokenIn === this.tokens.WETH || tokenIn === this.contracts.WETH) {
        // ETH to Token swap
        transaction = await this.buildETHToTokenSwap(tokenOut, amountIn, minOutput, wallet.address);
      } else if (tokenOut === this.tokens.WETH || tokenOut === this.contracts.WETH) {
        // Token to ETH swap  
        transaction = await this.buildTokenToETHSwap(tokenIn, amountIn, minOutput, wallet.address);
      } else {
        // Token to Token swap
        transaction = await this.buildTokenToTokenSwap(tokenIn, tokenOut, amountIn, minOutput, wallet.address);
      }

      // Add gas settings
      const gasEstimate = await provider.estimateGas(transaction);
      transaction.gasLimit = gasEstimate.mul(120).div(100); // 20% buffer
      transaction.gasPrice = await provider.getGasPrice();

      // Send transaction
      const txResponse = await wallet.sendTransaction(transaction);
      console.log(`Swap executed: ${txResponse.hash}`);

      return txResponse;

    } catch (error) {
      throw new Error(`Failed to execute swap: ${error.message}`);
    }
  }

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
      minOutput,
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
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

    const iface = new ethers.utils.Interface(routerAbi);
    const data = iface.encodeFunctionData('swapExactTokensForETH', [
      amountIn,
      minOutput,
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
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

    const iface = new ethers.utils.Interface(routerAbi);
    const data = iface.encodeFunctionData('swapExactTokensForTokens', [
      amountIn,
      minOutput,
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
   * Estimate gas for swap transaction
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {BigInt} amountIn - Input amount
   * @param {string} recipient - Recipient address
   * @returns {Object} Gas estimate with limit and price
   */
  async estimateSwapGas(tokenIn, tokenOut, amountIn, recipient) {
    try {
      const provider = await this.getProvider();

      // Build transaction for estimation
      let transaction;
      if (tokenIn === this.tokens.WETH || tokenIn === this.contracts.WETH) {
        transaction = await this.buildETHToTokenSwap(tokenOut, amountIn, BigInt(0), recipient);
      } else {
        transaction = await this.buildTokenToETHSwap(tokenIn, amountIn, BigInt(0), recipient);
      }

      const gasEstimate = await provider.estimateGas({
        ...transaction,
        from: recipient
      });

      const gasPrice = await provider.getGasPrice();

      return {
        gasLimit: gasEstimate.mul(120).div(100), // 20% buffer
        gasPrice: gasPrice,
        totalCost: gasEstimate.mul(120).div(100).mul(gasPrice)
      };

    } catch (error) {
      // Return conservative estimate if exact estimation fails
      const gasPrice = await (await this.getProvider()).getGasPrice();
      const conservativeGas = ethers.BigNumber.from(250000); // Conservative gas limit

      return {
        gasLimit: conservativeGas,
        gasPrice: gasPrice,
        totalCost: conservativeGas.mul(gasPrice)
      };
    }
  }

  /**
   * Collect fee to treasury
   * @param {BigInt} feeAmount - Fee amount in wei
   * @param {string} privateKey - User's private key
   * @returns {TransactionResponse} Transaction response
   */
  async collectFee(feeAmount, privateKey) {
    try {
      const provider = await this.getProvider();
      const wallet = new ethers.Wallet(privateKey, provider);

      const treasuryWallet = process.env.TREASURY_WALLET;
      if (!treasuryWallet) {
        throw new Error('Treasury wallet not configured');
      }

      const transaction = {
        to: treasuryWallet,
        value: feeAmount,
        gasLimit: 21000 // Standard ETH transfer
      };

      const txResponse = await wallet.sendTransaction(transaction);
      console.log(`Fee collection sent: ${txResponse.hash}`);
      return txResponse;
    } catch (error) {
      console.log('Fee collection failed:', error.message);
      // Don't throw - fee collection failure shouldn't block user transaction
      return null;
    }
  }

  /**
   * Calculate fee amount for a trade
   * @param {string} amount - Trade amount
   * @param {number} feePercentage - Fee percentage (1.0 = 1%)
   * @returns {object} - Fee calculation
   */
  calculateFee(amount, feePercentage = 1.0) {
    const amountBN = ethers.utils.parseEther(amount);
    const feeBN = amountBN.mul(Math.floor(feePercentage * 100)).div(10000);
    const netAmountBN = amountBN.sub(feeBN);

    return {
      totalAmount: amount,
      feeAmount: ethers.utils.formatEther(feeBN),
      netAmount: ethers.utils.formatEther(netAmountBN),
      feePercentage: feePercentage
    };
  }

  /**
   * Send fee to treasury wallet
   * @param {object} wallet - Connected wallet instance
   * @param {string} feeAmount - Fee amount in ETH
   * @returns {object} - Transaction receipt
   */
  async sendFeeToTreasury(wallet, feeAmount) {
    try {
      const treasuryWallet = process.env.TREASURY_WALLET;
      if (!treasuryWallet) {
        throw new Error('Treasury wallet not configured');
      }

      const transaction = {
        to: treasuryWallet,
        value: ethers.utils.parseEther(feeAmount),
        gasLimit: 21000 // Standard ETH transfer
      };

      const txResponse = await wallet.sendTransaction(transaction);
      return await txResponse.wait();
    } catch (error) {
      console.log('Fee collection failed:', error.message);
      // Don't throw - fee collection failure shouldn't block user transaction
      return null;
    }
  }

  /**
   * Monitor for new token pairs (sniping)
   * @param {function} callback - Function to call when new pair detected
   */
  async startPairMonitoring(callback) {
    try {
      const provider = await this.getProvider();

      // Listen for PairCreated events on Uniswap V2
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
            source: 'uniswap_v2'
          };

          await callback(pairInfo);
        } catch (error) {
          console.log('Pair monitoring callback error:', error.message);
        }
      });

      console.log('Started monitoring for new pairs...');
    } catch (error) {
      throw new Error(`Failed to start pair monitoring: ${error.message}`);
    }
  }

  /**
   * Monitor wallet for mirror trading
   * @param {string} targetWallet - Wallet address to mirror
   * @param {function} callback - Function to call when trade detected
   */
  async startMirrorTrading(targetWallet, callback) {
    try {
      const provider = await this.getProvider();

      // Monitor pending transactions for the target wallet
      provider.on('pending', async (txHash) => {
        try {
          const tx = await provider.getTransaction(txHash);
          if (tx && tx.from.toLowerCase() === targetWallet.toLowerCase()) {
            await callback(tx);
          }
        } catch (error) {
          // Ignore errors for pending tx fetching
        }
      });

      console.log(`Started mirroring wallet: ${targetWallet}`);
    } catch (error) {
      throw new Error(`Failed to start mirror trading: ${error.message}`);
    }
  }
}

module.exports = EthChain;