const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');

class SolChain {
  constructor() {
    this.connection = new Connection(process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com');

    // Popular Solana tokens
    this.tokens = {
      SOL: 'So11111111111111111111111111111111111111112', // Wrapped SOL
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
      BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    };

    // Jupiter API for routing (best Solana swap aggregator)
    this.jupiterAPI = 'https://quote-api.jup.ag/v6';

    // Raydium Program IDs
    this.programs = {
      RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
    };
  }

  /**
   * Get SOL balance for an address
   * @param {string} address - Wallet address (base58)
   * @returns {string} - Balance in SOL
   */
  async getBalance(address) {
    try {
      const publicKey = new PublicKey(address);
      const balance = await this.connection.getBalance(publicKey);
      return (balance / LAMPORTS_PER_SOL).toFixed(6);
    } catch (error) {
      throw new Error(`Failed to get SOL balance: ${error.message}`);
    }
  }

  /**
   * Get current gas price (priority fee)
   * @returns {object} - Gas price info
   */
  async getGasPrice() {
    try {
      // Get recent prioritization fees
      const recentFees = await this.connection.getRecentPrioritizationFees();

      // Calculate recommended priority fee (median of recent fees)
      const fees = recentFees.map(fee => fee.prioritizationFee).sort((a, b) => a - b);
      const medianFee = fees[Math.floor(fees.length / 2)] || 0;

      // Base fee for transactions
      const baseFee = 5000; // 0.000005 SOL base fee
      const priorityFee = Math.max(medianFee, 1000); // Minimum 1000 micro-lamports

      return {
        baseFee,
        priorityFee,
        totalFee: baseFee + priorityFee,
        formatted: {
          baseFeeSOL: (baseFee / LAMPORTS_PER_SOL).toFixed(9),
          priorityFeeSOL: (priorityFee / LAMPORTS_PER_SOL).toFixed(9),
          totalFeeSOL: ((baseFee + priorityFee) / LAMPORTS_PER_SOL).toFixed(9)
        }
      };
    } catch (error) {
      // Fallback to standard fees
      return {
        baseFee: 5000,
        priorityFee: 1000,
        totalFee: 6000,
        formatted: {
          baseFeeSOL: '0.000005000',
          priorityFeeSOL: '0.000001000',
          totalFeeSOL: '0.000006000'
        }
      };
    }
  }

  /**
   * Get token information
   * @param {string} mintAddress - Token mint address
   * @returns {object} - Token info
   */
  async getTokenInfo(mintAddress) {
    try {
      const mintPublicKey = new PublicKey(mintAddress);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPublicKey);

      if (!mintInfo.value || !mintInfo.value.data.parsed) {
        throw new Error('Invalid token mint address');
      }

      const tokenData = mintInfo.value.data.parsed.info;

      return {
        address: mintAddress,
        decimals: tokenData.decimals,
        supply: tokenData.supply,
        mintAuthority: tokenData.mintAuthority,
        freezeAuthority: tokenData.freezeAuthority
      };
    } catch (error) {
      throw new Error(`Failed to get token info: ${error.message}`);
    }
  }

  /**
   * Get token balance for an address
   * @param {string} mintAddress - Token mint address
   * @param {string} walletAddress - Wallet address
   * @returns {object} - Token balance info
   */
  async getTokenBalance(mintAddress, walletAddress) {
    try {
      const walletPublicKey = new PublicKey(walletAddress);
      const mintPublicKey = new PublicKey(mintAddress);

      // Get associated token account
      const associatedTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        walletPublicKey
      );

      const balance = await this.connection.getTokenAccountBalance(associatedTokenAccount);
      const tokenInfo = await this.getTokenInfo(mintAddress);

      return {
        raw: balance.value.amount,
        formatted: balance.value.uiAmount,
        decimals: balance.value.decimals,
        token: tokenInfo
      };
    } catch (error) {
      // Account might not exist (zero balance)
      return {
        raw: '0',
        formatted: 0,
        decimals: 0,
        token: await this.getTokenInfo(mintAddress)
      };
    }
  }

  /**
   * Get all token holdings for a wallet
   * @param {string} walletAddress - Wallet address
   * @returns {Array} - Array of token holdings
   */
  async getTokenHoldings(walletAddress) {
    try {
      const walletPublicKey = new PublicKey(walletAddress);

      // Get all token accounts for the wallet
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        walletPublicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const holdings = [];

      for (const account of tokenAccounts.value) {
        const accountData = account.account.data.parsed.info;
        const balance = parseFloat(accountData.tokenAmount.uiAmount);

        if (balance > 0) {
          holdings.push({
            mint: accountData.mint,
            balance: balance,
            decimals: accountData.tokenAmount.decimals,
            address: account.pubkey.toString()
          });
        }
      }

      return holdings;
    } catch (error) {
      console.log('Token holdings fetch failed:', error.message);
      return [];
    }
  }

  /**
   * Get quote for token swap using Jupiter
   * @param {string} inputMint - Input token mint
   * @param {string} outputMint - Output token mint  
   * @param {string} amount - Amount to swap (in token units)
   * @returns {object} - Swap quote
   */
  async getSwapQuote(inputMint, outputMint, amount) {
    try {
      // Handle SOL as input
      if (inputMint.toLowerCase() === 'sol') {
        inputMint = this.tokens.SOL;
      }

      // Convert amount to lamports/token units
      const inputTokenInfo = await this.getTokenInfo(inputMint);
      const amountInUnits = Math.floor(parseFloat(amount) * Math.pow(10, inputTokenInfo.decimals));

      // Get quote from Jupiter
      const quoteUrl = `${this.jupiterAPI}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInUnits}&slippageBps=300`;

      const response = await fetch(quoteUrl);
      const quote = await response.json();

      if (!quote || quote.error) {
        throw new Error(quote?.error || 'No route found for this swap');
      }

      const outputTokenInfo = await this.getTokenInfo(outputMint);

      return {
        inputMint,
        outputMint,
        amountIn: amount,
        amountOut: (parseInt(quote.outAmount) / Math.pow(10, outputTokenInfo.decimals)).toString(),
        priceImpactPct: quote.priceImpactPct,
        route: quote,
        inputToken: inputTokenInfo,
        outputToken: outputTokenInfo
      };
    } catch (error) {
      throw new Error(`Swap quote failed: ${error.message}`);
    }
  }

  /**
   * Execute token swap using Jupiter
   * @param {object} wallet - Wallet keypair
   * @param {string} inputMint - Input token mint
   * @param {string} outputMint - Output token mint
   * @param {string} amount - Amount to swap
   * @returns {object} - Transaction signature
   */
  async executeSwap(wallet, inputMint, outputMint, amount) {
    try {
      // Get quote first
      const quote = await this.getSwapQuote(inputMint, outputMint, amount);

      // Get swap transaction from Jupiter
      const swapUrl = `${this.jupiterAPI}/swap`;
      const swapBody = {
        quoteResponse: quote.route,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true
      };

      const swapResponse = await fetch(swapUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(swapBody)
      });

      const swapData = await swapResponse.json();

      if (!swapData.swapTransaction) {
        throw new Error('Failed to get swap transaction');
      }

      // Deserialize and sign transaction
      const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const transaction = Transaction.from(swapTransactionBuf);

      // Sign transaction
      transaction.sign(wallet);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(transaction.serialize());

      // Confirm transaction
      await this.connection.confirmTransaction(signature, 'confirmed');

      return {
        signature,
        inputAmount: amount,
        outputAmount: quote.amountOut,
        inputToken: quote.inputToken,
        outputToken: quote.outputToken
      };
    } catch (error) {
      throw new Error(`Swap execution failed: ${error.message}`);
    }
  }

  /**
   * Create wallet from private key
   * @param {string} privateKey - Private key (base58)
   * @returns {object} - Keypair object
   */
  createWalletFromPrivateKey(privateKey) {
    try {
      const privateKeyBytes = bs58.decode(privateKey);
      return Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      throw new Error(`Invalid Solana private key: ${error.message}`);
    }
  }

  /**
   * Generate new wallet
   * @returns {object} - New wallet with private key and address
   */
  generateWallet() {
    const keypair = Keypair.generate();
    return {
      privateKey: bs58.encode(keypair.secretKey),
      address: keypair.publicKey.toString(),
      keypair: keypair
    };
  }

  /**
   * Validate Solana address format
   * @param {string} address - Address to validate
   * @returns {boolean} - True if valid
   */
  isValidAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Calculate fee amount for a trade
   * @param {string} amount - Trade amount in SOL
   * @param {number} feePercentage - Fee percentage (1.0 = 1%)
   * @returns {object} - Fee calculation
   */
  calculateFee(amount, feePercentage = 1.0) {
    const amountNum = parseFloat(amount);
    const feeAmount = amountNum * (feePercentage / 100);
    const netAmount = amountNum - feeAmount;

    return {
      totalAmount: amount,
      feeAmount: feeAmount.toFixed(6),
      netAmount: netAmount.toFixed(6),
      feePercentage: feePercentage
    };
  }

  /**
   * Send fee to treasury wallet
   * @param {object} wallet - Wallet keypair
   * @param {string} feeAmount - Fee amount in SOL
   * @returns {object} - Transaction signature
   */
  async sendFeeToTreasury(wallet, feeAmount) {
    try {
      const treasuryAddress = process.env.TREASURY_WALLET_SOL;
      if (!treasuryAddress) {
        throw new Error('Solana treasury wallet not configured');
      }

      const treasuryPublicKey = new PublicKey(treasuryAddress);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: treasuryPublicKey,
          lamports: Math.floor(parseFloat(feeAmount) * LAMPORTS_PER_SOL)
        })
      );

      const signature = await this.connection.sendTransaction(transaction, [wallet]);
      await this.connection.confirmTransaction(signature);

      return { signature };
    } catch (error) {
      console.log('SOL fee collection failed:', error.message);
      // Don't throw - fee collection failure shouldn't block user transaction
      return null;
    }
  }

  /**
   * Monitor for new token creation (similar to ETH pair monitoring)
   * @param {function} callback - Function to call when new token detected
   */
  async startTokenMonitoring(callback) {
    try {
      // Monitor for new token accounts being created
      const subscriptionId = this.connection.onProgramAccountChange(
        TOKEN_PROGRAM_ID,
        async (accountInfo) => {
          try {
            const tokenData = {
              account: accountInfo.accountId.toString(),
              owner: accountInfo.accountInfo.owner.toString(),
              timestamp: Date.now(),
              source: 'solana_token_program'
            };

            await callback(tokenData);
          } catch (error) {
            console.log('Token monitoring callback error:', error.message);
          }
        },
        'confirmed'
      );

      console.log(`Started monitoring Solana tokens with subscription: ${subscriptionId}`);
      return subscriptionId;
    } catch (error) {
      throw new Error(`Failed to start token monitoring: ${error.message}`);
    }
  }

  /**
   * Monitor wallet for mirror trading
   * @param {string} targetWallet - Wallet address to mirror
   * @param {function} callback - Function to call when trade detected
   */
  async startMirrorTrading(targetWallet, callback) {
    try {
      const targetPublicKey = new PublicKey(targetWallet);

      // Monitor account changes for the target wallet
      const subscriptionId = this.connection.onAccountChange(
        targetPublicKey,
        async (accountInfo) => {
          try {
            const tradeData = {
              wallet: targetWallet,
              lamports: accountInfo.lamports,
              timestamp: Date.now(),
              source: 'solana_account_change'
            };

            await callback(tradeData);
          } catch (error) {
            console.log('Mirror trading callback error:', error.message);
          }
        },
        'confirmed'
      );

      console.log(`Started mirroring Solana wallet: ${targetWallet}`);
      return subscriptionId;
    } catch (error) {
      throw new Error(`Failed to start mirror trading: ${error.message}`);
    }
  }

  /**
   * Get current network status
   * @returns {object} - Network status info
   */
  async getNetworkStatus() {
    try {
      const [slot, epoch, blockTime] = await Promise.all([
        this.connection.getSlot(),
        this.connection.getEpochInfo(),
        this.connection.getBlockTime(await this.connection.getSlot())
      ]);

      return {
        slot,
        epoch: epoch.epoch,
        blockTime,
        health: 'healthy'
      };
    } catch (error) {
      return {
        health: 'unhealthy',
        error: error.message
      };
    }
  }

  /**
   * Estimate transaction size and fees
   * @param {object} transaction - Transaction object
   * @returns {object} - Fee estimate
   */
  async estimateFees(transaction) {
    try {
      const gasPrice = await this.getGasPrice();

      // Solana transaction fees are fixed, not based on computation
      return {
        baseFee: gasPrice.baseFee,
        priorityFee: gasPrice.priorityFee,
        totalFee: gasPrice.totalFee,
        formatted: gasPrice.formatted
      };
    } catch (error) {
      throw new Error(`Fee estimation failed: ${error.message}`);
    }
  }
}

module.exports = SolChain;