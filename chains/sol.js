const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');
const fetch = require('node-fetch');

class SolChain {
  constructor() {
    this.connection = new Connection(process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com');

    // Jupiter API for best swap routing
    this.jupiterAPI = 'https://quote-api.jup.ag/v6';

    // Native SOL mint address
    this.NATIVE_SOL = 'So11111111111111111111111111111111111111112';

    console.log('✅ SOL Chain initialized with Jupiter integration');
  }

  /**
   * Get SOL balance for an address
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
   */
  async getGasPrice() {
    try {
      const recentFees = await this.connection.getRecentPrioritizationFees();
      const fees = recentFees.map(fee => fee.prioritizationFee).sort((a, b) => a - b);
      const medianFee = fees[Math.floor(fees.length / 2)] || 1000;

      const baseFee = 5000;
      const priorityFee = Math.max(medianFee, 1000);

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
   */
  async getTokenInfo(mintAddress) {
    try {
      const mintPublicKey = new PublicKey(mintAddress);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPublicKey);

      if (!mintInfo.value) {
        throw new Error('Token mint not found');
      }

      // Handle different account types
      let decimals = 9; // Default for SOL
      let supply = '0';

      if (mintInfo.value.data.parsed) {
        const tokenData = mintInfo.value.data.parsed.info;
        decimals = tokenData.decimals;
        supply = tokenData.supply;
      }

      return {
        address: mintAddress,
        decimals: decimals,
        supply: supply,
        isNative: mintAddress === this.NATIVE_SOL
      };
    } catch (error) {
      // Return default info for unknown tokens
      return {
        address: mintAddress,
        decimals: 9,
        supply: '0',
        isNative: mintAddress === this.NATIVE_SOL
      };
    }
  }

  /**
   * Get token holdings for a wallet
   */
  async getTokenHoldings(walletAddress) {
    try {
      const walletPublicKey = new PublicKey(walletAddress);
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
   * Get swap quote using Jupiter
   */
  async getSwapQuote(inputMint, outputMint, amount) {
    try {
      // Handle SOL input
      if (inputMint.toLowerCase() === 'sol') {
        inputMint = this.NATIVE_SOL;
      }
      if (outputMint.toLowerCase() === 'sol') {
        outputMint = this.NATIVE_SOL;
      }

      // Convert amount to smallest units
      const inputTokenInfo = await this.getTokenInfo(inputMint);
      const amountInUnits = Math.floor(parseFloat(amount) * Math.pow(10, inputTokenInfo.decimals));

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
        priceImpactPct: quote.priceImpactPct || '0',
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
   */
  async executeSwap(wallet, inputMint, outputMint, amount) {
    try {
      console.log(`🔄 Executing SOL swap: ${amount} ${inputMint} -> ${outputMint}`);

      // Handle SOL input/output
      if (inputMint.toLowerCase() === 'sol') {
        inputMint = this.NATIVE_SOL;
      }
      if (outputMint.toLowerCase() === 'sol') {
        outputMint = this.NATIVE_SOL;
      }

      // Get quote first
      const quote = await this.getSwapQuote(inputMint, outputMint, amount);

      // Get swap transaction from Jupiter
      const swapResponse = await fetch(`${this.jupiterAPI}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote.route,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto'
        })
      });

      const swapData = await swapResponse.json();

      if (!swapData.swapTransaction) {
        throw new Error('Failed to get swap transaction from Jupiter');
      }

      // Deserialize transaction - handle versioned transactions
      const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
      
      let transaction;
      try {
        // Try versioned message first (Jupiter's new format)
        const { VersionedTransaction } = require('@solana/web3.js');
        transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      } catch (versionedError) {
        // Fallback to legacy transaction format
        transaction = Transaction.from(swapTransactionBuf);
      }

      // Sign and send transaction
      let signature;
      
      if (transaction.version !== undefined) {
        // Handle versioned transaction
        transaction.sign([wallet]);
        signature = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        });
        
        // Confirm transaction using polling instead of subscription
        await this.confirmTransactionPolling(signature);
      } else {
        // Handle legacy transaction - this method uses polling internally
        signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [wallet],
          { commitment: 'confirmed' }
        );
      }

      console.log(`✅ SOL swap completed: ${signature}`);

      return {
        signature,
        inputAmount: amount,
        outputAmount: quote.amountOut,
        inputToken: quote.inputToken,
        outputToken: quote.outputToken
      };

    } catch (error) {
      console.log(`❌ SOL swap failed: ${error.message}`);
      throw new Error(`Swap execution failed: ${error.message}`);
    }
  }

  /**
   * Create wallet from private key
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
   */
  isValidAddress(address) {
    try {
      if (!address || typeof address !== 'string') {
        return false;
      }
      
      // Basic length check (Solana addresses are typically 32-44 characters)
      if (address.length < 32 || address.length > 44) {
        return false;
      }
      
      new PublicKey(address);
      return true;
    } catch (error) {
      console.log(`SOL address validation failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Calculate fee for a trade
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
   * Send fee to treasury wallet - IMPLEMENTED
   */
  async sendFeeToTreasury(wallet, feeAmount) {
    try {
      const treasuryAddress = process.env.TREASURY_WALLET_SOL;
      if (!treasuryAddress) {
        console.log('⚠️ SOL treasury wallet not configured');
        return null;
      }

      const treasuryPublicKey = new PublicKey(treasuryAddress);
      const lamports = Math.floor(parseFloat(feeAmount) * LAMPORTS_PER_SOL);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: treasuryPublicKey,
          lamports: lamports
        })
      );

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [wallet],
        { commitment: 'confirmed' }
      );

      console.log(`💰 SOL fee collected: ${feeAmount} SOL - TX: ${signature}`);
      return { signature };

    } catch (error) {
      console.log(`⚠️ SOL fee collection failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Monitor for new token creation
   */
  async startTokenMonitoring(callback) {
    try {
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

      console.log(`🔍 Started SOL token monitoring: ${subscriptionId}`);
      return subscriptionId;
    } catch (error) {
      throw new Error(`Failed to start token monitoring: ${error.message}`);
    }
  }

  /**
   * Monitor wallet for mirror trading - IMPLEMENTED
   */
  async startMirrorTrading(targetWallet, callback) {
    try {
      const targetPublicKey = new PublicKey(targetWallet);

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
            console.log('SOL mirror callback error:', error.message);
          }
        },
        'confirmed'
      );

      console.log(`🪞 Started SOL mirror monitoring: ${targetWallet}`);
      return subscriptionId;
    } catch (error) {
      throw new Error(`Failed to start SOL mirror trading: ${error.message}`);
    }
  }

  /**
   * Confirm transaction using polling (works with all RPC providers)
   */
  async confirmTransactionPolling(signature, commitment = 'confirmed', timeout = 60000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const status = await this.connection.getSignatureStatus(signature);
        
        if (status && status.value) {
          if (status.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
          }
          
          if (status.value.confirmationStatus === commitment || 
              status.value.confirmationStatus === 'finalized') {
            console.log(`✅ Transaction confirmed: ${signature}`);
            return status.value;
          }
        }
        
        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.log(`⚠️ Error checking transaction status: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    throw new Error(`Transaction confirmation timeout after ${timeout}ms`);
  }

  /**
   * Get network status
   */
  async getNetworkStatus() {
    try {
      const [slot, epoch] = await Promise.all([
        this.connection.getSlot(),
        this.connection.getEpochInfo()
      ]);

      return {
        slot,
        epoch: epoch.epoch,
        health: 'healthy',
        network: 'mainnet-beta'
      };
    } catch (error) {
      return {
        health: 'unhealthy',
        error: error.message
      };
    }
  }
}

module.exports = SolChain;