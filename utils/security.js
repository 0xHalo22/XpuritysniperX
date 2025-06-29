const winston = require('winston');

class SecurityManager {
  constructor() {
    // Rate limiting storage
    this.userLimits = new Map();
    this.ipLimits = new Map();

    // Security event logging
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: 'security.log' }),
        new winston.transports.Console()
      ]
    });

    // Rate limit configurations
    this.limits = {
      transactions: { max: 10, window: 60 * 60 * 1000 }, // 10 per hour
      walletImports: { max: 3, window: 24 * 60 * 60 * 1000 }, // 3 per day
      mirrorTargets: { max: 5, window: 24 * 60 * 60 * 1000 }, // 5 per day
      dailyVolume: { max: 50000, window: 24 * 60 * 60 * 1000 }, // $50k per day
      botRequests: { max: 60, window: 60 * 1000 } // 60 per minute
    };
  }

  /**
   * Check rate limit for user action
   * @param {string} userId - User ID
   * @param {string} action - Action type
   * @param {number} amount - Amount (for volume limits)
   * @returns {boolean} - True if allowed
   */
  async checkRateLimit(userId, action, amount = 0) {
    try {
      const now = Date.now();
      const limit = this.limits[action];

      if (!limit) {
        this.logger.warn(`Unknown action for rate limiting: ${action}`);
        return true;
      }

      // Get or create user limits
      if (!this.userLimits.has(userId)) {
        this.userLimits.set(userId, {});
      }

      const userActions = this.userLimits.get(userId);

      // Initialize action tracking if not exists
      if (!userActions[action]) {
        userActions[action] = [];
      }

      // Clean old entries
      userActions[action] = userActions[action].filter(
        timestamp => now - timestamp < limit.window
      );

      // Check volume-based limits
      if (action === 'dailyVolume') {
        const totalVolume = userActions[action].reduce((sum, entry) => sum + (entry.amount || 0), 0);
        if (totalVolume + amount > limit.max) {
          this.logSecurityEvent('RATE_LIMIT_EXCEEDED', userId, {
            action,
            totalVolume,
            requestedAmount: amount,
            limit: limit.max
          });
          throw new Error(`Daily volume limit exceeded. Current: $${totalVolume.toFixed(2)}, Limit: $${limit.max}`);
        }

        // Add current transaction to tracking
        userActions[action].push({ timestamp: now, amount });
        return true;
      }

      // Check count-based limits
      if (userActions[action].length >= limit.max) {
        this.logSecurityEvent('RATE_LIMIT_EXCEEDED', userId, {
          action,
          currentCount: userActions[action].length,
          limit: limit.max,
          windowMinutes: limit.window / (60 * 1000)
        });

        const windowHours = limit.window / (60 * 60 * 1000);
        throw new Error(`Rate limit exceeded: ${limit.max} ${action} per ${windowHours} hour(s)`);
      }

      // Add current action to tracking
      userActions[action].push(now);

      this.logSecurityEvent('RATE_LIMIT_CHECK', userId, {
        action,
        currentCount: userActions[action].length,
        limit: limit.max
      });

      return true;
    } catch (error) {
      if (error.message.includes('Rate limit exceeded') || error.message.includes('Daily volume limit')) {
        throw error;
      }

      this.logger.error('Rate limit check failed:', error);
      return false;
    }
  }

  /**
   * Log security events
   * @param {string} event - Event type
   * @param {string} userId - User ID
   * @param {object} details - Event details
   */
  logSecurityEvent(event, userId, details = {}) {
    this.logger.info('Security Event', {
      event,
      userId,
      timestamp: new Date().toISOString(),
      details
    });
  }

  /**
   * Log transaction for security monitoring
   * @param {object} transaction - Transaction details
   */
  async logTransaction(transaction) {
    try {
      this.logSecurityEvent('TRANSACTION', transaction.userId, {
        type: transaction.type,
        amount: transaction.amount,
        token: transaction.token,
        hash: transaction.hash,
        success: transaction.success,
        fee: transaction.fee,
        gas: transaction.gas
      });

      // Check for suspicious patterns
      await this.detectSuspiciousActivity(transaction);

    } catch (error) {
      this.logger.error('Failed to log transaction:', error);
    }
  }

  /**
   * Detect suspicious activity patterns
   * @param {object} transaction - Transaction details
   */
  async detectSuspiciousActivity(transaction) {
    try {
      const userId = transaction.userId;
      const userActions = this.userLimits.get(userId) || {};
      const recentTransactions = userActions.transactions || [];

      // Check for rapid transaction patterns
      const last5Minutes = Date.now() - (5 * 60 * 1000);
      const recentTxCount = recentTransactions.filter(tx => tx > last5Minutes).length;

      if (recentTxCount > 5) {
        this.logSecurityEvent('SUSPICIOUS_RAPID_TRANSACTIONS', userId, {
          recentTxCount,
          timeWindow: '5 minutes'
        });
      }

      // Check for large transaction amounts
      const amount = parseFloat(transaction.amount || 0);
      if (amount > 10000) { // $10k+ transactions
        this.logSecurityEvent('LARGE_TRANSACTION', userId, {
          amount,
          token: transaction.token,
          hash: transaction.hash
        });
      }

      // Check for failed transaction patterns
      if (!transaction.success) {
        const failedTxs = userActions.failedTransactions || [];
        failedTxs.push(Date.now());

        // Keep only last hour of failed transactions
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        userActions.failedTransactions = failedTxs.filter(tx => tx > oneHourAgo);

        if (userActions.failedTransactions.length > 10) {
          this.logSecurityEvent('EXCESSIVE_FAILED_TRANSACTIONS', userId, {
            failedCount: userActions.failedTransactions.length,
            timeWindow: '1 hour'
          });
        }
      }

    } catch (error) {
      this.logger.error('Suspicious activity detection failed:', error);
    }
  }

  /**
   * Validate wallet address
   * @param {string} address - Wallet address
   * @param {string} chain - Blockchain (eth/sol)
   * @returns {boolean} - True if valid
   */
  validateAddress(address, chain = 'eth') {
    try {
      if (chain === 'eth') {
        // Ethereum address validation
        return /^0x[a-fA-F0-9]{40}$/.test(address);
      } else if (chain === 'sol') {
        // Solana address validation (base58, 32-44 characters)
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
      }
      return false;
    } catch (error) {
      this.logger.error('Address validation failed:', error);
      return false;
    }
  }

  /**
   * Validate private key format
   * @param {string} privateKey - Private key
   * @param {string} chain - Blockchain (eth/sol)
   * @returns {boolean} - True if valid format
   */
  validatePrivateKey(privateKey, chain = 'eth') {
    try {
      if (chain === 'eth') {
        // Remove 0x prefix if present
        const key = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        return /^[a-fA-F0-9]{64}$/.test(key);
      } else if (chain === 'sol') {
        // Solana private key validation (base58)
        return /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(privateKey);
      }
      return false;
    } catch (error) {
      this.logger.error('Private key validation failed:', error);
      return false;
    }
  }

  /**
   * Sanitize user input
   * @param {string} input - User input
   * @returns {string} - Sanitized input
   */
  sanitizeInput(input) {
    if (typeof input !== 'string') {
      return '';
    }

    // Remove potentially dangerous characters
    return input
      .replace(/[<>\"'&]/g, '')
      .trim()
      .substring(0, 1000); // Limit length
  }

  /**
   * Check if user is premium
   * @param {object} userData - User data
   * @returns {boolean} - True if premium
   */
  isPremiumUser(userData) {
    try {
      return userData.premium && 
             userData.premium.active && 
             userData.premium.expiresAt > Date.now();
    } catch (error) {
      return false;
    }
  }

  /**
   * Get security report for user
   * @param {string} userId - User ID
   * @returns {object} - Security report
   */
  getSecurityReport(userId) {
    try {
      const userActions = this.userLimits.get(userId) || {};
      const now = Date.now();

      const report = {
        userId,
        generatedAt: now,
        rateLimits: {},
        recentActivity: {
          last24Hours: 0,
          lastHour: 0
        }
      };

      // Calculate current rate limit status
      Object.entries(this.limits).forEach(([action, limit]) => {
        const actions = userActions[action] || [];
        const recentActions = actions.filter(timestamp => now - timestamp < limit.window);

        report.rateLimits[action] = {
          current: recentActions.length,
          limit: limit.max,
          remaining: Math.max(0, limit.max - recentActions.length),
          resetTime: actions.length > 0 ? Math.max(...actions) + limit.window : null
        };
      });

      // Calculate recent activity
      const allActions = Object.values(userActions).flat();
      report.recentActivity.last24Hours = allActions.filter(
        timestamp => now - timestamp < 24 * 60 * 60 * 1000
      ).length;

      report.recentActivity.lastHour = allActions.filter(
        timestamp => now - timestamp < 60 * 60 * 1000
      ).length;

      return report;
    } catch (error) {
      this.logger.error('Failed to generate security report:', error);
      return {
        userId,
        error: 'Failed to generate security report'
      };
    }
  }

  /**
   * Clean up old rate limit data
   */
  cleanupOldData() {
    try {
      const now = Date.now();
      const maxWindow = Math.max(...Object.values(this.limits).map(l => l.window));

      // Clean user limits
      for (const [userId, userActions] of this.userLimits.entries()) {
        let hasActivity = false;

        for (const [action, timestamps] of Object.entries(userActions)) {
          if (Array.isArray(timestamps)) {
            const filtered = timestamps.filter(ts => now - ts < maxWindow);
            if (filtered.length > 0) {
              userActions[action] = filtered;
              hasActivity = true;
            } else {
              delete userActions[action];
            }
          }
        }

        if (!hasActivity) {
          this.userLimits.delete(userId);
        }
      }

      this.logger.info('Rate limit data cleanup completed');
    } catch (error) {
      this.logger.error('Failed to cleanup old data:', error);
    }
  }
}

// Export singleton instance
const securityManager = new SecurityManager();

// Schedule cleanup every hour
setInterval(() => {
  securityManager.cleanupOldData();
}, 60 * 60 * 1000);

module.exports = {
  SecurityManager,
  checkRateLimit: (userId, action, amount) => securityManager.checkRateLimit(userId, action, amount),
  logTransaction: (transaction) => securityManager.logTransaction(transaction),
  logSecurityEvent: (event, userId, details) => securityManager.logSecurityEvent(event, userId, details),
  validateAddress: (address, chain) => securityManager.validateAddress(address, chain),
  validatePrivateKey: (privateKey, chain) => securityManager.validatePrivateKey(privateKey, chain),
  sanitizeInput: (input) => securityManager.sanitizeInput(input),
  isPremiumUser: (userData) => securityManager.isPremiumUser(userData),
  getSecurityReport: (userId) => securityManager.getSecurityReport(userId)
};