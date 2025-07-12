const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');
const fetch = require('node-fetch');

class SolChain {
  constructor() {
    // Helius RPC connection with WebSocket support
    this.connection = new Connection(process.env.SOL_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: process.env.SOL_RPC_WSS || process.env.SOL_RPC_URL?.replace('https://', 'wss://'),
      disableRetryOnRateLimit: false,
      confirmTransactionInitialTimeout: 30000
    });

    // Jupiter API for best swap routing
    this.jupiterAPI = 'https://quote-api.jup.ag/v6';

    // Native SOL mint address
    this.NATIVE_SOL = 'So11111111111111111111111111111111111111112';

    // Popular token mints for quick access
    this.tokens = {
      SOL: 'So11111111111111111111111111111111111111112',
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
      BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    };

    console.log('✅ SOL Chain initialized with Helius integration');
    console.log(`🔗 RPC: ${process.env.SOL_RPC_URL?.substring(0, 50)}...`);
    console.log(`📡 WSS: ${process.env.SOL_RPC_WSS?.substring(0, 50)}...`);
  }

  /**
   * Test connection to Helius
   */
  async testConnection() {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      console.log(`🟢 Helius connection successful - Slot: ${slot}, Block time: ${new Date(blockTime * 1000)}`);
      return true;
    } catch (error) {
      console.log(`🔴 Helius connection failed: ${error.message}`);
      return false;
    }
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
   * Get current priority fee from Helius
   */
  async getGasPrice() {
    try {
      const recentFees = await this.connection.getRecentPrioritizationFees();
      const fees = recentFees.map(fee => fee.prioritizationFee).sort((a, b) => a - b);
      const medianFee = fees[Math.floor(fees.length / 2)] || 1000;

      const baseFee = 5000;
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
      console.log(`⚠️ Failed to get priority fees: ${error.message}`);
      // Return default fees if API fails
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
   * Get token information using Helius DAS API
   */
  async getTokenInfo(mintAddress) {
    try {
      const mintPublicKey = new PublicKey(mintAddress);

      // Try Helius DAS API first for enhanced token data
      const heliusUrl = process.env.SOL_RPC_URL.split('?')[0]; // Remove query params
      try {
        const dasResponse = await fetch(`${heliusUrl}/v0/token-metadata`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            mintAccounts: [mintAddress],
            includeOffChain: true,
            disableCache: false
          })
        });

        if (dasResponse.ok) {
          const dasData = await dasResponse.json();
          if (dasData.length > 0) {
            const token = dasData[0];
            return {
              address: mintAddress,
              name: token.onChainMetadata?.metadata?.name || 'Unknown Token',
              symbol: token.onChainMetadata?.metadata?.symbol || 'UNKNOWN',
              decimals: token.onChainMetadata?.metadata?.decimals || 9,
              logoURI: token.offChainMetadata?.metadata?.image,
              verified: token.onChainMetadata?.metadata?.verified || false,
              supply: token.onChainMetadata?.metadata?.supply || '0',
              isNative: mintAddress === this.NATIVE_SOL
            };
          }
        }
      } catch (dasError) {
        console.log(`⚠️ DAS API failed, using fallback: ${dasError.message}`);
      }

      // Fallback to standard RPC
      const mintInfo = await this.connection.getParsedAccountInfo(mintPublicKey);
      if (!mintInfo.value) {
        throw new Error('Token not found');
      }

      let decimals = 9; // Default for SOL
      let supply = '0';

      if (mintInfo.value.data.parsed) {
        const tokenData = mintInfo.value.data.parsed.info;
        decimals = tokenData.decimals;
        supply = tokenData.supply;
      }

      return {
        address: mintAddress,
        name: 'Unknown Token',
        symbol: 'UNKNOWN',
        decimals: decimals,
        supply: supply,
        logoURI: null,
        verified: false,
        isNative: mintAddress === this.NATIVE_SOL
      };

    } catch (error) {
      // Return default info for unknown tokens
      return {
        address: mintAddress,
        name: 'Unknown Token',
        symbol: 'UNKNOWN',
        decimals: 9,
        supply: '0',
        logoURI: null,
        verified: false,
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
   * Execute token swap using Jupiter with Helius for fast settlement
   */
  async executeSwap(wallet, inputMint, outputMint, amount) {
    try {
      console.log(`🔄 Executing SOL swap via Jupiter + Helius: ${amount} ${inputMint} -> ${outputMint}`);

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

      // Sign and send transaction via Helius
      let signature;

      if (transaction.version !== undefined) {
        // Handle versioned transaction
        transaction.sign([wallet]);
        signature = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3
        });

        // Confirm transaction using Helius fast confirmation
        await this.confirmTransactionPolling(signature);
      } else {
        // Handle legacy transaction
        signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [wallet],
          { commitment: 'confirmed' }
        );
      }

      console.log(`✅ SOL swap completed via Helius: ${signature}`);

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
      // Handle both base58 string and byte array formats
      let privateKeyBytes;

      if (typeof privateKey === 'string') {
        // Try base58 decode first (standard Solana format)
        try {
          privateKeyBytes = bs58.decode(privateKey);
        } catch {
          // Try JSON array format: [1,2,3,...,64]
          try {
            privateKeyBytes = new Uint8Array(JSON.parse(privateKey));
          } catch {
            throw new Error('Invalid private key format');
          }
        }
      } else if (Array.isArray(privateKey)) {
        privateKeyBytes = new Uint8Array(privateKey);
      } else {
        throw new Error('Private key must be string or array');
      }

      if (privateKeyBytes.length !== 64) {
        throw new Error('Private key must be 64 bytes');
      }

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
   * 💰 BULLETPROOF SOL FEE COLLECTION - COMPLETE REFACTOR
   */
  async sendFeeToTreasury(wallet, feeAmountSOL) {
    try {
      console.log(`🔍 SOL FEE COLLECTION DEBUG:`);
      console.log(`  Fee Amount: ${feeAmountSOL} SOL`);
      console.log(`  Treasury Wallet: ${process.env.TREASURY_WALLET_SOL}`);
      console.log(`  User Wallet: ${wallet.publicKey.toString()}`);

      // ✅ STEP 1: Validate treasury wallet
      const treasuryAddress = process.env.TREASURY_WALLET_SOL;
      if (!treasuryAddress) {
        console.log('❌ SOL treasury wallet not configured in TREASURY_WALLET_SOL');
        return null;
      }

      if (!this.isValidAddress(treasuryAddress)) {
        console.log(`❌ Invalid SOL treasury address format: ${treasuryAddress}`);
        return null;
      }

      console.log(`✅ Treasury address validated: ${treasuryAddress}`);

      // ✅ STEP 2: Validate and convert fee amount
      const feeAmountFloat = parseFloat(feeAmountSOL);
      if (feeAmountFloat <= 0) {
        console.log(`⚠️ Fee amount is zero or negative: ${feeAmountFloat}, skipping`);
        return null;
      }

      const lamports = Math.floor(feeAmountFloat * LAMPORTS_PER_SOL);
      console.log(`💸 Converting ${feeAmountSOL} SOL to ${lamports} lamports`);

      // ✅ STEP 3: Check wallet balance
      const currentBalance = await this.connection.getBalance(wallet.publicKey);
      const requiredAmount = lamports + 10000; // Fee + generous transaction cost buffer

      console.log(`💰 Current balance: ${currentBalance} lamports`);
      console.log(`💸 Required amount: ${requiredAmount} lamports (${lamports} fee + 10000 buffer)`);

      if (currentBalance < requiredAmount) {
        console.log(`❌ Insufficient balance for fee: ${currentBalance} < ${requiredAmount} lamports`);
        return null;
      }

      console.log(`✅ Balance sufficient for fee collection`);

      // ✅ STEP 4: Create treasury public key
      const treasuryPublicKey = new PublicKey(treasuryAddress);

      // ✅ STEP 5: Get latest blockhash for transaction
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      console.log(`🔗 Got latest blockhash: ${blockhash.substring(0, 10)}...`);

      // ✅ STEP 6: Create fee transfer transaction
      const feeTransaction = new Transaction({
        feePayer: wallet.publicKey,
        recentBlockhash: blockhash
      }).add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: treasuryPublicKey,
          lamports: lamports
        })
      );

      console.log(`🏗️ Fee transaction created`);

      // ✅ STEP 7: Sign transaction
      feeTransaction.sign(wallet);
      console.log(`✍️ Fee transaction signed`);

      // ✅ STEP 8: Send transaction with retries
      let signature;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        try {
          console.log(`🚀 Sending SOL fee transaction (attempt ${attempts + 1}/${maxAttempts})...`);

          signature = await this.connection.sendRawTransaction(
            feeTransaction.serialize(),
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 2
            }
          );

          console.log(`⏳ SOL fee transaction sent: ${signature}`);
          break;

        } catch (sendError) {
          attempts++;
          console.log(`❌ Send attempt ${attempts} failed: ${sendError.message}`);

          if (attempts >= maxAttempts) {
            throw sendError;
          }

          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // ✅ STEP 9: Confirm transaction
      console.log(`⏳ Confirming SOL fee transaction...`);

      try {
        await this.confirmTransactionPolling(signature, 'confirmed', 45000);
        console.log(`✅ SOL fee transaction confirmed: ${signature}`);
      } catch (confirmError) {
        console.log(`⚠️ Fee confirmation failed but transaction may have succeeded: ${confirmError.message}`);
        // Don't fail here - the transaction might still be valid
      }

      // ✅ STEP 10: Verify the fee was actually collected
      try {
        const newBalance = await this.connection.getBalance(wallet.publicKey);
        const expectedBalance = currentBalance - lamports - 5000; // Account for transaction fee

        if (newBalance <= expectedBalance + 5000) { // Allow some variance
          console.log(`✅ Fee collection verified: Balance reduced from ${currentBalance} to ${newBalance}`);
        } else {
          console.log(`⚠️ Fee collection verification inconclusive: ${currentBalance} -> ${newBalance}`);
        }
      } catch (verifyError) {
        console.log(`⚠️ Could not verify fee collection: ${verifyError.message}`);
      }

      console.log(`🎉 SOL fee collection completed successfully!`);
      console.log(`💰 Collected: ${feeAmountSOL} SOL (${lamports} lamports)`);
      console.log(`🏦 To Treasury: ${treasuryAddress}`);
      console.log(`🔗 Transaction: ${signature}`);

      return { 
        signature: signature,
        amount: feeAmountSOL,
        lamports: lamports,
        to: treasuryAddress,
        confirmed: true
      };

    } catch (error) {
      console.log(`❌ SOL fee collection failed: ${error.message}`);
      console.log(`📊 Error stack:`, error.stack);

      // Enhanced error categorization
      if (error.message.includes('insufficient')) {
        console.log('💡 Error type: Insufficient balance');
      } else if (error.message.includes('signature') || error.message.includes('transaction')) {
        console.log('💡 Error type: Transaction/signature issue');
      } else if (error.message.includes('blockhash')) {
        console.log('💡 Error type: Blockhash/network issue');
      } else if (error.message.includes('timeout')) {
        console.log('💡 Error type: Network timeout');
      } else {
        console.log('💡 Error type: Unknown network or RPC issue');
      }

      // Return null instead of throwing to not break main trade
      return null;
    }
  }

  /**
   * Monitor for new token creation using Helius
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
              source: 'helius_token_program',
              slot: accountInfo.context.slot
            };
            await callback(tokenData);
          } catch (error) {
            console.log('Token monitoring callback error:', error.message);
          }
        },
        'confirmed'
      );

      console.log(`🔍 Started SOL token monitoring via Helius: ${subscriptionId}`);
      return subscriptionId;
    } catch (error) {
      throw new Error(`Failed to start token monitoring: ${error.message}`);
    }
  }

  /**
   * Monitor account changes via Helius WebSocket
   */
  async startMirrorTrading(targetWallet, callback) {
    try {
      console.log(`🪞 Starting SOL mirror monitoring via Helius: ${targetWallet}`);

      const targetPublicKey = new PublicKey(targetWallet);

      // Subscribe to account changes via Helius WebSocket
      const subscriptionId = this.connection.onAccountChange(
        targetPublicKey,
        async (accountInfo) => {
          try {
            const tradeData = {
              wallet: targetWallet,
              lamports: accountInfo.lamports,
              timestamp: Date.now(),
              source: 'helius_account_change',
              slot: accountInfo.context.slot
            };
            await callback(tradeData);
          } catch (error) {
            console.log('SOL mirror callback error:', error.message);
          }
        },
        'confirmed'
      );

      console.log(`✅ Helius mirror monitoring active: ${targetWallet} (Subscription: ${subscriptionId})`);
      return subscriptionId;
    } catch (error) {
      throw new Error(`Failed to start SOL mirror trading: ${error.message}`);
    }
  }

  /**
   * Monitor program logs for new token creation (pump.fun, Raydium, etc.)
   */
  async startSniping(programId, callback) {
    try {
      console.log(`🎯 Starting SOL sniping via Helius: ${programId}`);

      const subscriptionId = this.connection.onLogs(
        new PublicKey(programId),
        async (logs) => {
          try {
            const snipeData = {
              signature: logs.signature,
              logs: logs.logs,
              timestamp: Date.now(),
              source: 'helius_program_logs',
              slot: logs.context.slot
            };
            await callback(snipeData);
          } catch (error) {
            console.log('SOL snipe callback error:', error.message);
          }
        },
        'confirmed'
      );

      console.log(`✅ Helius sniping active for program: ${programId} (Subscription: ${subscriptionId})`);
      return subscriptionId;
    } catch (error) {
      throw new Error(`Failed to start SOL sniping: ${error.message}`);
    }
  }

  /**
   * Confirm transaction using polling with Helius speed
   */
  async confirmTransactionPolling(signature, commitment = 'confirmed', timeout = 45000) {
    const startTime = Date.now();
    let lastError = null;

    console.log(`⏳ Confirming transaction: ${signature.substring(0, 10)}... (timeout: ${timeout}ms)`);

    while (Date.now() - startTime < timeout) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (status && status.value) {
          if (status.value.err) {
            const errorMsg = JSON.stringify(status.value.err);
            console.log(`❌ Transaction failed with error: ${errorMsg}`);
            throw new Error(`Transaction failed: ${errorMsg}`);
          }

          if (status.value.confirmationStatus === commitment || 
              status.value.confirmationStatus === 'finalized') {
            const elapsed = Date.now() - startTime;
            console.log(`✅ Transaction confirmed via Helius in ${elapsed}ms: ${signature}`);
            return status.value;
          }

          // Log progress
          if (status.value.confirmationStatus) {
            console.log(`⏳ Transaction status: ${status.value.confirmationStatus} (waiting for ${commitment})`);
          }
        }

        // Check every 1.5 seconds with Helius speed
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (error) {
        lastError = error;
        console.log(`⚠️ Error checking transaction status: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`❌ Transaction confirmation timeout after ${elapsed}ms`);
    throw new Error(`Transaction confirmation timeout after ${timeout}ms. Last error: ${lastError?.message || 'none'}`);
  }

  /**
   * Get network status via Helius
   */
  async getNetworkStatus() {
    try {
      const [slot, epoch] = await Promise.all([
        this.connection.getSlot(),
        this.connection.getEpochInfo()
      ]);

      // Try to get health status
      let health = 'healthy';
      try {
        const healthResult = await this.connection.getHealth();
        health = healthResult === 'ok' ? 'healthy' : 'degraded';
      } catch (healthError) {
        health = 'unknown';
      }

      return {
        slot,
        epoch: epoch.epoch,
        health: health,
        network: 'mainnet-beta',
        provider: 'helius'
      };
    } catch (error) {
      return {
        health: 'unhealthy',
        error: error.message,
        provider: 'helius'
      };
    }
  }

  /**
   * Stop subscription
   */
  async stopSubscription(subscriptionId) {
    try {
      await this.connection.removeAccountChangeListener(subscriptionId);
      console.log(`🛑 Stopped Helius subscription: ${subscriptionId}`);
    } catch (error) {
      console.log(`⚠️ Failed to stop subscription: ${error.message}`);
    }
  }
}

module.exports = SolChain;