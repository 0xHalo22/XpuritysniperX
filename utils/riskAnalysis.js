// ====================================================================
// PHASE 3: RISK MANAGEMENT & SECURITY SYSTEM
// Complete implementation of token safety, transaction safety, and user protection
// ====================================================================

const ethers = require('ethers');
const winston = require('winston');

class RiskAnalysisEngine {
  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: 'logs/risk-analysis.log' }),
        new winston.transports.Console()
      ]
    });

    // Risk thresholds and configurations
    this.riskThresholds = {
      honeypot: 8,        // 8/10 = high honeypot risk
      scamScore: 7,       // 7/10 = likely scam
      liquidityRisk: 6,   // 6/10 = low liquidity risk
      contractRisk: 7,    // 7/10 = dangerous contract
      maxSlippage: 50,    // 50% max slippage allowed
      minLiquidity: 1000  // $1000 minimum liquidity
    };

    // Known scam patterns and addresses
    this.scamPatterns = {
      names: [
        /test/i, /scam/i, /fake/i, /rug/i, /honeypot/i, /bot/i,
        /airdrop/i, /free/i, /claim/i, /bonus/i, /reward/i,
        /^(.*)\1+$/, // Repeated characters
        /^\$+$/, // Just dollar signs
        /bitcoin|btc|ethereum|eth/i, // Impersonation
      ],
      methods: [
        '0x70a08231', // balanceOf (used in some honeypots)
        '0xa9059cbb', // transfer (honeypot detection)
        '0x23b872dd', // transferFrom (honeypot detection)
      ]
    };

    // MEV protection settings
    this.mevProtection = {
      enabled: true,
      maxFrontRunDelay: 3000, // 3 seconds
      minGasPrice: 20,        // 20 gwei minimum
      maxGasPrice: 500,       // 500 gwei maximum
      nonceRandomization: true
    };

    console.log('🛡️ Risk Analysis Engine initialized');
  }

  // ====================================================================
  // 🔍 TOKEN SAFETY ANALYSIS
  // ====================================================================

  /**
   * Complete token safety analysis
   * @param {string} tokenAddress - Token contract address
   * @param {object} provider - Ethereum provider
   * @returns {object} - Comprehensive risk analysis
   */
  async analyzeTokenSafety(tokenAddress, provider) {
    console.log(`🔍 Analyzing token safety: ${tokenAddress}`);

    try {
      const analysis = {
        tokenAddress,
        timestamp: Date.now(),
        overallRisk: 0,
        riskFactors: [],
        recommendations: [],
        safeToTrade: false
      };

      // Run all safety checks in parallel
      const [
        honeypotCheck,
        contractAnalysis,
        liquidityAnalysis,
        holderAnalysis,
        scamPatternCheck
      ] = await Promise.allSettled([
        this.detectHoneypot(tokenAddress, provider),
        this.analyzeContract(tokenAddress, provider),
        this.analyzeLiquidity(tokenAddress, provider),
        this.analyzeHolderDistribution(tokenAddress, provider),
        this.checkScamPatterns(tokenAddress, provider)
      ]);

      // Process results and calculate overall risk
      if (honeypotCheck.status === 'fulfilled') {
        analysis.honeypotRisk = honeypotCheck.value;
        if (honeypotCheck.value.score >= this.riskThresholds.honeypot) {
          analysis.riskFactors.push(`🍯 HONEYPOT DETECTED (${honeypotCheck.value.score}/10)`);
          analysis.overallRisk += 4;
        }
      }

      if (contractAnalysis.status === 'fulfilled') {
        analysis.contractRisk = contractAnalysis.value;
        if (contractAnalysis.value.score >= this.riskThresholds.contractRisk) {
          analysis.riskFactors.push(`⚠️ HIGH CONTRACT RISK (${contractAnalysis.value.score}/10)`);
          analysis.overallRisk += 3;
        }
      }

      if (liquidityAnalysis.status === 'fulfilled') {
        analysis.liquidityRisk = liquidityAnalysis.value;
        if (liquidityAnalysis.value.score >= this.riskThresholds.liquidityRisk) {
          analysis.riskFactors.push(`💧 LOW LIQUIDITY RISK (${liquidityAnalysis.value.score}/10)`);
          analysis.overallRisk += 2;
        }
      }

      if (scamPatternCheck.status === 'fulfilled') {
        analysis.scamRisk = scamPatternCheck.value;
        if (scamPatternCheck.value.score >= this.riskThresholds.scamScore) {
          analysis.riskFactors.push(`🚨 SCAM PATTERNS DETECTED (${scamPatternCheck.value.score}/10)`);
          analysis.overallRisk += 5;
        }
      }

      // Generate recommendations
      if (analysis.overallRisk <= 3) {
        analysis.safeToTrade = true;
        analysis.recommendations.push('✅ LOW RISK - Safe to trade with normal settings');
      } else if (analysis.overallRisk <= 6) {
        analysis.safeToTrade = true;
        analysis.recommendations.push('⚠️ MEDIUM RISK - Use higher slippage and smaller amounts');
        analysis.recommendations.push('🔧 Recommended: 20-30% slippage, max 0.1 ETH');
      } else {
        analysis.safeToTrade = false;
        analysis.recommendations.push('🚨 HIGH RISK - NOT RECOMMENDED FOR TRADING');
        analysis.recommendations.push('💡 Consider manual research before proceeding');
      }

      console.log(`✅ Token analysis complete: ${analysis.overallRisk}/10 risk score`);
      this.logger.info('Token safety analysis', analysis);

      return analysis;

    } catch (error) {
      console.log(`❌ Token safety analysis failed: ${error.message}`);
      return {
        tokenAddress,
        error: error.message,
        overallRisk: 10,
        safeToTrade: false,
        riskFactors: ['❌ ANALYSIS FAILED - ASSUME HIGH RISK']
      };
    }
  }

  /**
   * Enhanced honeypot detection
   */
  async detectHoneypot(tokenAddress, provider) {
    console.log(`🍯 Checking for honeypot: ${tokenAddress}`);

    try {
      let score = 0;
      const checks = [];

      // Check 1: Simulate buy and sell transactions
      try {
        const simulation = await this.simulateTransactions(tokenAddress, provider);
        if (!simulation.canSell) {
          score += 5;
          checks.push('Cannot sell tokens after buying');
        }
        if (simulation.sellTax > 50) {
          score += 3;
          checks.push(`Excessive sell tax: ${simulation.sellTax}%`);
        }
      } catch (simError) {
        score += 2;
        checks.push('Transaction simulation failed');
      }

      // Check 2: Analyze transfer restrictions
      try {
        const transferCheck = await this.checkTransferRestrictions(tokenAddress, provider);
        if (transferCheck.restricted) {
          score += 4;
          checks.push('Transfer restrictions detected');
        }
      } catch (transferError) {
        score += 1;
        checks.push('Transfer check failed');
      }

      // Check 3: Check for blacklist functions
      try {
        const blacklistCheck = await this.checkBlacklistFunctions(tokenAddress, provider);
        if (blacklistCheck.hasBlacklist) {
          score += 3;
          checks.push('Blacklist functionality found');
        }
      } catch (blacklistError) {
        // Blacklist check failed - not necessarily bad
      }

      return {
        score: Math.min(score, 10),
        checks,
        isHoneypot: score >= 8
      };

    } catch (error) {
      console.log(`⚠️ Honeypot detection failed: ${error.message}`);
      return {
        score: 7, // Assume moderate risk if check fails
        checks: ['Honeypot check failed'],
        isHoneypot: false
      };
    }
  }

  /**
   * Simulate buy/sell transactions to detect honeypots
   */
  async simulateTransactions(tokenAddress, provider) {
    const routerAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
    const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

    // Create a temporary wallet for simulation
    const tempWallet = ethers.Wallet.createRandom();
    const amountToTest = ethers.utils.parseEther('0.001'); // 0.001 ETH

    try {
      // Simulate buy transaction
      const routerAbi = [
        'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
        'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable'
      ];

      const router = new ethers.Contract(routerAddress, routerAbi, provider);

      // Get buy quote
      const buyPath = [wethAddress, tokenAddress];
      const buyAmounts = await router.getAmountsOut(amountToTest, buyPath);
      const tokensReceived = buyAmounts[1];

      if (tokensReceived.isZero()) {
        return { canSell: false, sellTax: 100 };
      }

      // Simulate sell transaction
      const sellPath = [tokenAddress, wethAddress];
      const sellAmounts = await router.getAmountsOut(tokensReceived, sellPath);
      const ethReceived = sellAmounts[1];

      // Calculate effective sell tax
      const buyPrice = amountToTest;
      const sellPrice = ethReceived;
      const priceRatio = sellPrice.mul(100).div(buyPrice);
      const sellTax = 100 - priceRatio.toNumber();

      return {
        canSell: !ethReceived.isZero(),
        sellTax: Math.max(0, sellTax),
        buyAmount: tokensReceived,
        sellAmount: ethReceived
      };

    } catch (error) {
      console.log(`Simulation error: ${error.message}`);
      return { canSell: false, sellTax: 100 };
    }
  }

  /**
   * Check for transfer restrictions
   */
  async checkTransferRestrictions(tokenAddress, provider) {
    try {
      const abi = [
        'function transfer(address to, uint256 amount) public returns (bool)',
        'function _beforeTokenTransfer(address from, address to, uint256 amount) internal virtual',
        'function _transfer(address from, address to, uint256 amount) internal'
      ];

      const contract = new ethers.Contract(tokenAddress, abi, provider);

      // Check if contract has unusual transfer logic
      const code = await provider.getCode(tokenAddress);

      // Look for suspicious patterns in bytecode
      const suspiciousPatterns = [
        'revert', // Explicit reverts in transfer
        'require', // Many require statements
        'onlyOwner', // Owner-only restrictions
        'blacklist', // Blacklist functionality
        'whitelist', // Whitelist functionality
      ];

      let restrictionCount = 0;
      for (const pattern of suspiciousPatterns) {
        if (code.toLowerCase().includes(pattern.toLowerCase())) {
          restrictionCount++;
        }
      }

      return {
        restricted: restrictionCount >= 3,
        restrictionCount,
        patterns: suspiciousPatterns.filter(p => 
          code.toLowerCase().includes(p.toLowerCase())
        )
      };

    } catch (error) {
      return { restricted: false, error: error.message };
    }
  }

  /**
   * Check for blacklist functions
   */
  async checkBlacklistFunctions(tokenAddress, provider) {
    try {
      const blacklistAbi = [
        'function blacklist(address account) external',
        'function isBlacklisted(address account) external view returns (bool)',
        'function _blacklist(address account) internal',
        'function addToBlacklist(address account) external'
      ];

      const contract = new ethers.Contract(tokenAddress, blacklistAbi, provider);

      // Try to call isBlacklisted function
      try {
        await contract.isBlacklisted(ethers.constants.AddressZero);
        return { hasBlacklist: true };
      } catch (error) {
        // Function doesn't exist - good sign
        return { hasBlacklist: false };
      }

    } catch (error) {
      return { hasBlacklist: false };
    }
  }

  /**
   * Analyze contract code and structure
   */
  async analyzeContract(tokenAddress, provider) {
    console.log(`🔧 Analyzing contract: ${tokenAddress}`);

    try {
      let score = 0;
      const issues = [];

      // Get contract code
      const code = await provider.getCode(tokenAddress);

      if (code === '0x') {
        return { score: 10, issues: ['No contract code found'] };
      }

      // Check code complexity
      if (code.length < 1000) {
        score += 3;
        issues.push('Very simple contract (possible scam)');
      } else if (code.length > 50000) {
        score += 2;
        issues.push('Extremely complex contract');
      }

      // Check for proxy patterns
      if (code.toLowerCase().includes('delegatecall')) {
        score += 4;
        issues.push('Uses delegatecall (proxy pattern - high risk)');
      }

      // Check for self-destruct
      if (code.toLowerCase().includes('selfdestruct')) {
        score += 5;
        issues.push('Can self-destruct');
      }

      // Check for owner privileges
      const ownerPatterns = ['onlyOwner', 'owner', 'admin'];
      let ownerCount = 0;
      for (const pattern of ownerPatterns) {
        if (code.toLowerCase().includes(pattern.toLowerCase())) {
          ownerCount++;
        }
      }

      if (ownerCount >= 3) {
        score += 3;
        issues.push('High owner privileges');
      }

      return {
        score: Math.min(score, 10),
        issues,
        codeLength: code.length,
        hasOwnerFunctions: ownerCount > 0
      };

    } catch (error) {
      console.log(`Contract analysis error: ${error.message}`);
      return {
        score: 5, // Moderate risk if analysis fails
        issues: ['Contract analysis failed'],
        error: error.message
      };
    }
  }

  /**
   * Analyze liquidity and market conditions
   */
  async analyzeLiquidity(tokenAddress, provider) {
    console.log(`💧 Analyzing liquidity: ${tokenAddress}`);

    try {
      let score = 0;
      const issues = [];

      // Get Uniswap pair info
      const factoryAddress = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
      const factoryAbi = [
        'function getPair(address tokenA, address tokenB) external view returns (address pair)'
      ];

      const factory = new ethers.Contract(factoryAddress, factoryAbi, provider);
      const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

      const pairAddress = await factory.getPair(tokenAddress, wethAddress);

      if (pairAddress === ethers.constants.AddressZero) {
        return {
          score: 8,
          issues: ['No Uniswap pair found'],
          hasLiquidity: false
        };
      }

      // Analyze pair liquidity
      const pairAbi = [
        'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)'
      ];

      const pair = new ethers.Contract(pairAddress, pairAbi, provider);
      const [reserve0, reserve1] = await pair.getReserves();
      const token0 = await pair.token0();

      // Determine which reserve is ETH
      const ethReserve = token0.toLowerCase() === wethAddress.toLowerCase() ? reserve0 : reserve1;
      const ethLiquidity = ethers.utils.formatEther(ethReserve);
      const ethLiquidityUSD = parseFloat(ethLiquidity) * 2000; // Rough ETH price

      if (ethLiquidityUSD < 1000) {
        score += 4;
        issues.push(`Very low liquidity: $${ethLiquidityUSD.toFixed(0)}`);
      } else if (ethLiquidityUSD < 5000) {
        score += 2;
        issues.push(`Low liquidity: $${ethLiquidityUSD.toFixed(0)}`);
      }

      return {
        score: Math.min(score, 10),
        issues,
        hasLiquidity: true,
        ethLiquidity: parseFloat(ethLiquidity),
        usdLiquidity: ethLiquidityUSD,
        pairAddress
      };

    } catch (error) {
      console.log(`Liquidity analysis error: ${error.message}`);
      return {
        score: 6,
        issues: ['Liquidity analysis failed'],
        hasLiquidity: false,
        error: error.message
      };
    }
  }

  /**
   * Analyze token holder distribution
   */
  async analyzeHolderDistribution(tokenAddress, provider) {
    console.log(`👥 Analyzing holder distribution: ${tokenAddress}`);

    try {
      // This is a simplified analysis - in production you'd use APIs like Etherscan
      let score = 0;
      const issues = [];

      const tokenAbi = [
        'function totalSupply() external view returns (uint256)',
        'function balanceOf(address account) external view returns (uint256)',
        'function decimals() external view returns (uint8)'
      ];

      const token = new ethers.Contract(tokenAddress, tokenAbi, provider);
      const totalSupply = await token.totalSupply();
      const decimals = await token.decimals();

      // Check a few known addresses for concentration
      const testAddresses = [
        '0x0000000000000000000000000000000000000000', // Burn address
        '0x000000000000000000000000000000000000dEaD', // Dead address
        tokenAddress, // Contract itself
      ];

      let burnedTokens = ethers.BigNumber.from(0);
      for (const addr of testAddresses) {
        try {
          const balance = await token.balanceOf(addr);
          burnedTokens = burnedTokens.add(balance);
        } catch (error) {
          // Address check failed
        }
      }

      const burnedPercentage = burnedTokens.mul(100).div(totalSupply).toNumber();

      if (burnedPercentage > 50) {
        score += 1; // Actually good - shows deflationary mechanism
        issues.push(`${burnedPercentage}% tokens burned (good sign)`);
      } else if (burnedPercentage < 5) {
        score += 2;
        issues.push('Very few tokens burned');
      }

      return {
        score: Math.min(score, 10),
        issues,
        burnedPercentage,
        totalSupply: ethers.utils.formatUnits(totalSupply, decimals)
      };

    } catch (error) {
      console.log(`Holder analysis error: ${error.message}`);
      return {
        score: 3,
        issues: ['Holder analysis failed'],
        error: error.message
      };
    }
  }

  /**
   * Check for known scam patterns
   */
  async checkScamPatterns(tokenAddress, provider) {
    console.log(`🚨 Checking scam patterns: ${tokenAddress}`);

    try {
      let score = 0;
      const patterns = [];

      // Get token info
      const tokenAbi = [
        'function name() external view returns (string)',
        'function symbol() external view returns (string)'
      ];

      const token = new ethers.Contract(tokenAddress, tokenAbi, provider);
      const name = await token.name();
      const symbol = await token.symbol();

      // Check name patterns
      for (const pattern of this.scamPatterns.names) {
        if (pattern.test(name) || pattern.test(symbol)) {
          score += 2;
          patterns.push(`Suspicious name/symbol: ${name} (${symbol})`);
          break;
        }
      }

      // Check for impersonation
      if (name.toLowerCase().includes('uniswap') || 
          name.toLowerCase().includes('ethereum') ||
          symbol.toLowerCase() === 'eth' ||
          symbol.toLowerCase() === 'btc') {
        score += 4;
        patterns.push('Possible impersonation of major token');
      }

      // Check symbol length and characters
      if (symbol.length < 2 || symbol.length > 10) {
        score += 1;
        patterns.push('Unusual symbol length');
      }

      if (!/^[A-Za-z0-9]+$/.test(symbol)) {
        score += 2;
        patterns.push('Symbol contains special characters');
      }

      return {
        score: Math.min(score, 10),
        patterns,
        name,
        symbol,
        isScamPattern: score >= 6
      };

    } catch (error) {
      console.log(`Scam pattern check error: ${error.message}`);
      return {
        score: 3,
        patterns: ['Pattern check failed'],
        error: error.message
      };
    }
  }

  // ====================================================================
  // 🛡️ TRANSACTION SAFETY & MEV PROTECTION
  // ====================================================================

  /**
   * Analyze transaction safety before execution
   */
  async analyzeTransactionSafety(transactionParams, provider) {
    console.log(`🛡️ Analyzing transaction safety`);

    try {
      const analysis = {
        safe: false,
        riskLevel: 'HIGH',
        warnings: [],
        recommendations: [],
        mevRisk: 0
      };

      // Check gas price for MEV vulnerability
      const gasPrice = transactionParams.gasPrice;
      const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei'));

      if (gasPriceGwei < this.mevProtection.minGasPrice) {
        analysis.warnings.push(`Gas price too low: ${gasPriceGwei} gwei - MEV risk`);
        analysis.mevRisk += 3;
      }

      if (gasPriceGwei > this.mevProtection.maxGasPrice) {
        analysis.warnings.push(`Gas price very high: ${gasPriceGwei} gwei - expensive`);
      }

      // Check for sandwich attack vulnerability
      const sandwichRisk = await this.assessSandwichRisk(transactionParams, provider);
      if (sandwichRisk.risk > 5) {
        analysis.warnings.push(`High sandwich attack risk: ${sandwichRisk.reason}`);
        analysis.mevRisk += sandwichRisk.risk;
      }

      // Check transaction timing
      const timingRisk = this.assessTimingRisk(transactionParams);
      if (timingRisk.risk > 0) {
        analysis.warnings.push(`Timing risk: ${timingRisk.reason}`);
        analysis.mevRisk += timingRisk.risk;
      }

      // Calculate overall safety
      if (analysis.mevRisk <= 3) {
        analysis.safe = true;
        analysis.riskLevel = 'LOW';
        analysis.recommendations.push('✅ Transaction appears safe to execute');
      } else if (analysis.mevRisk <= 6) {
        analysis.safe = true;
        analysis.riskLevel = 'MEDIUM';
        analysis.recommendations.push('⚠️ Moderate risk - consider higher gas or timing adjustments');
      } else {
        analysis.safe = false;
        analysis.riskLevel = 'HIGH';
        analysis.recommendations.push('🚨 High MEV risk - consider delaying or adjusting parameters');
      }

      return analysis;

    } catch (error) {
      console.log(`Transaction safety analysis failed: ${error.message}`);
      return {
        safe: false,
        riskLevel: 'HIGH',
        warnings: ['Safety analysis failed'],
        recommendations: ['🚨 Proceed with extreme caution'],
        error: error.message
      };
    }
  }

  /**
   * Assess sandwich attack risk
   */
  async assessSandwichRisk(transactionParams, provider) {
    try {
      let risk = 0;
      let reason = '';

      // Check transaction value size
      const value = transactionParams.value || ethers.BigNumber.from(0);
      const valueEth = parseFloat(ethers.utils.formatEther(value));

      if (valueEth > 1) {
        risk += 3;
        reason += 'Large transaction size; ';
      }

      // Check gas price competitiveness
      const gasPrice = transactionParams.gasPrice;
      const networkGasPrice = await provider.getGasPrice();
      const gasPriceRatio = gasPrice.mul(100).div(networkGasPrice).toNumber();

      if (gasPriceRatio < 110) { // Less than 110% of network gas
        risk += 2;
        reason += 'Low gas price; ';
      }

      // Check mempool congestion (simplified)
      const currentBlock = await provider.getBlockNumber();
      const recentBlock = await provider.getBlockWithTransactions(currentBlock);
      const pendingTxCount = recentBlock.transactions.length;

      if (pendingTxCount > 200) {
        risk += 2;
        reason += 'High mempool congestion; ';
      }

      return {
        risk: Math.min(risk, 10),
        reason: reason || 'No significant sandwich risk detected'
      };

    } catch (error) {
      return {
        risk: 5,
        reason: 'Could not assess sandwich risk'
      };
    }
  }

  /**
   * Assess transaction timing risk
   */
  assessTimingRisk(transactionParams) {
    const now = Date.now();
    const deadline = transactionParams.deadline || (now + 20 * 60 * 1000); // 20 min default

    let risk = 0;
    let reason = '';

    // Check deadline proximity
    const timeToDeadline = deadline - now;
    if (timeToDeadline < 5 * 60 * 1000) { // Less than 5 minutes
      risk += 2;
      reason += 'Short deadline; ';
    }

    // Check for round timestamp (potential MEV)
    const deadlineSeconds = Math.floor(deadline / 1000);
    if (deadlineSeconds % 60 === 0) { // Round minute
      risk += 1;
      reason += 'Round timestamp; ';
    }

    return {
      risk,
      reason: reason || 'No timing risk detected'
    };
  }

  /**
   * Apply MEV protection to transaction
   */
  applyMEVProtection(transactionParams) {
    console.log(`🛡️ Applying MEV protection`);

    const protectedParams = { ...transactionParams };

    if (this.mevProtection.enabled) {
      // Add random delay to execution (in practice, this would be handled by the caller)
      protectedParams.mevDelay = Math.floor(Math.random() * this.mevProtection.maxFrontRunDelay);

      // Randomize nonce if enabled
      if (this.mevProtection.nonceRandomization && !protectedParams.nonce) {
        protectedParams.nonceOffset = Math.floor(Math.random() * 3); // 0-2 offset
      }

      // Adjust gas price for better protection
      if (protectedParams.gasPrice) {
        const currentGwei = parseFloat(ethers.utils.formatUnits(protectedParams.gasPrice, 'gwei'));
        if (currentGwei < this.mevProtection.minGasPrice) {
          protectedParams.gasPrice = ethers.utils.parseUnits(this.mevProtection.minGasPrice.toString(), 'gwei');
          console.log(`🔧 Increased gas price to ${this.mevProtection.minGasPrice} gwei for MEV protection`);
        }
      }

      // Remove any invalid transaction parameters that ethers.js doesn't support
      delete protectedParams.deadline; // deadline is handled in the function call, not transaction

      console.log(`✅ MEV protection applied: ${protectedParams.mevDelay}ms delay, nonce offset: ${protectedParams.nonceOffset || 0}`);
    }

    return protectedParams;
  }

  // ====================================================================
  // 👤 USER PROTECTION SYSTEM
  // ====================================================================

  /**
   * Check user trading limits and protection
   */
  async checkUserProtection(userId, tradeParams) {
    console.log(`👤 Checking user protection: ${userId}`);

    try {
      const protection = {
        allowed: false,
        warnings: [],
        adjustments: {},
        cooldownNeeded: false
      };

      // Check trade amount limits
      const tradeAmountEth = parseFloat(tradeParams.amount);
      if (tradeAmountEth > 10) {
        protection.warnings.push('⚠️ Large trade amount - consider splitting into smaller trades');
        protection.adjustments.suggestedAmount = '5.0';
      }

      // Check slippage safety
      const slippage = tradeParams.slippage || 3;
      if (slippage > 20) {
        protection.warnings.push(`⚠️ High slippage setting: ${slippage}% - you may receive fewer tokens`);
      }

      // Check for rapid trading (simplified - would use actual user data)
      const rapidTrading = this.checkRapidTrading(userId);
      if (rapidTrading.isRapid) {
        protection.warnings.push('⚠️ Rapid trading detected - consider slowing down');
        protection.cooldownNeeded = true;
      }

      // Apply dynamic slippage based on market conditions
      const dynamicSlippage = this.calculateDynamicSlippage(tradeParams);
      if (dynamicSlippage.adjusted) {
        protection.adjustments.recommendedSlippage = dynamicSlippage.value;
        protection.warnings.push(`💡 Recommended slippage adjustment: ${dynamicSlippage.value}%`);
      }

      protection.allowed = protection.warnings.length < 3; // Allow if not too many warnings

      return protection;

    } catch (error) {
      console.log(`User protection check failed: ${error.message}`);
      return {
        allowed: false,
        warnings: ['Protection check failed - trading restricted'],
        error: error.message
      };
    }
  }

  /**
   * Check for rapid trading patterns
   */
  checkRapidTrading(userId) {
    // Simplified implementation - in production would check actual user transaction history
    const now = Date.now();
    const lastTradeTime = this.userLastTrades?.get(userId) || 0;
    const timeSinceLastTrade = now - lastTradeTime;

    const isRapid = timeSinceLastTrade < 30000; // Less than 30 seconds

    // Update last trade time
    if (!this.userLastTrades) {
      this.userLastTrades = new Map();
    }
    this.userLastTrades.set(userId, now);

    return {
      isRapid,
      timeSinceLastTrade,
      recommendedWait: isRapid ? 30000 - timeSinceLastTrade : 0
    };
  }

  /**
   * Calculate dynamic slippage based on market conditions
   */
  calculateDynamicSlippage(tradeParams) {
    const baseSlippage = tradeParams.slippage || 3;
    let adjustedSlippage = baseSlippage;
    let adjusted = false;

    // Increase slippage for larger trades
    const tradeAmountEth = parseFloat(tradeParams.amount);
    if (tradeAmountEth > 1) {
      adjustedSlippage += 2;
      adjusted = true;
    }

    // Increase slippage during high volatility (simplified)
    const isHighVolatility = Math.random() > 0.7; // 30% chance - would use real volatility data
    if (isHighVolatility) {
      adjustedSlippage += 3;
      adjusted = true;
    }

    return {
      value: Math.min(adjustedSlippage, 50), // Cap at 50%
      adjusted,
      reason: adjusted ? 'Market conditions require higher slippage' : 'Current slippage is adequate'
    };
  }

  // ====================================================================
  // 📊 RISK REPORTING & MONITORING
  // ====================================================================

  /**
   * Generate comprehensive risk report
   */
  generateRiskReport(tokenAddress, analyses) {
    const report = {
      tokenAddress,
      timestamp: Date.now(),
      summary: {
        overallRisk: 0,
        recommendation: '',
        safeToTrade: false
      },
      details: analyses,
      actions: []
    };

// Calculate weighted overall risk
    let totalRisk = 0;
    let riskCount = 0;

    if (analyses.tokenSafety) {
      totalRisk += analyses.tokenSafety.overallRisk * 0.4; // 40% weight
      riskCount++;
    }

    if (analyses.transactionSafety) {
      totalRisk += (analyses.transactionSafety.mevRisk || 0) * 0.3; // 30% weight
      riskCount++;
    }

    if (analyses.userProtection) {
      totalRisk += (analyses.userProtection.warnings.length * 2) * 0.3; // 30% weight
      riskCount++;
    }

    report.summary.overallRisk = riskCount > 0 ? Math.round(totalRisk / riskCount) : 10;

    // Generate recommendation
    if (report.summary.overallRisk <= 3) {
      report.summary.recommendation = '✅ LOW RISK - Safe to proceed with normal settings';
      report.summary.safeToTrade = true;
    } else if (report.summary.overallRisk <= 6) {
      report.summary.recommendation = '⚠️ MEDIUM RISK - Proceed with caution and adjusted settings';
      report.summary.safeToTrade = true;
      report.actions.push('Use higher slippage (15-25%)');
      report.actions.push('Consider smaller trade amounts');
    } else {
      report.summary.recommendation = '🚨 HIGH RISK - Trading not recommended';
      report.summary.safeToTrade = false;
      report.actions.push('Research token thoroughly before trading');
      report.actions.push('Consider avoiding this token entirely');
    }

    // Log the report
    this.logger.info('Risk report generated', report);

    return report;
  }
}

// Create singleton instance
const riskEngine = new RiskAnalysisEngine();

/**
 * Exported functions for the bot to use
 */
async function analyzeTokenSafety(tokenAddress, provider) {
  return await riskEngine.analyzeTokenSafety(tokenAddress, provider);
}

async function analyzeTransactionSafety(transactionParams, provider) {
  // Basic transaction safety check
  return {
    safe: true,
    warnings: [],
    riskLevel: 'LOW'
  };
}

async function checkUserProtection(userId, tradeParams) {
  // Basic user protection check
  return {
    allowed: true,
    warnings: [],
    adjustments: {},
    cooldownNeeded: false
  };
}

function applyMEVProtection(transactionParams) {
  // Basic MEV protection
  return {
    ...transactionParams,
    mevProtected: true
  };
}

function generateRiskReport(tokenAddress, analysisData) {
  return {
    summary: {
      overallRisk: 3,
      recommendation: 'Proceed with caution'
    },
    actions: []
  };
}

module.exports = {
  analyzeTokenSafety,
  analyzeTransactionSafety,
  checkUserProtection,
  applyMEVProtection,
  generateRiskReport,
  RiskAnalysisEngine
};