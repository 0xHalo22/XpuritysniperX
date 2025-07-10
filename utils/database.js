// ====================================================================
// PHASE 5: REPLIT DATABASE LAYER
// Simple key-value database perfect for bot data
// ====================================================================

const Database = require('@replit/database');

class ReplitDatabaseManager {
  constructor() {
    this.db = new Database();
    this.initialized = false;
  }

  /**
   * Initialize Replit Database connection
   */
  async initialize() {
    try {
      console.log('🔍 Initializing Replit Database...');

      // Test connection
      await this.db.get('test');

      this.initialized = true;
      console.log('✅ Replit Database connected successfully');

    } catch (error) {
      console.log('❌ Replit Database initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Get user data
   */
  async getUser(userId) {
    if (!this.initialized) {
      throw new Error('Database not initialized');
    }

    try {
      const userData = await this.db.get(`user:${userId}`);

      if (!userData) {
        // Return default user structure
        return {
          userId: userId.toString(),
          ethWallets: [],
          solWallets: [],
          activeEthWallet: 0,
          activeSolWallet: 0,
          transactions: [],
          settings: {
            slippage: 3,
            gasMultiplier: 1.2,
            snipeStrategy: 'new_pairs'
          },
          mirrorTargets: [],
          premium: {
            active: false,
            expiresAt: 0
          },
          createdAt: Date.now(),
          lastActive: Date.now(),
          snipeConfig: {
            active: false,
            amount: 0.1,
            slippage: 10,
            strategy: 'first_liquidity',
            maxGasPrice: 100,
            minLiquidity: 1000,
            maxPerHour: 5,
            targetTokens: []
          }
        };
      }

      return JSON.parse(userData);

    } catch (error) {
      console.log(`Error getting user ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * Save user data
   */
  async saveUser(userId, userData) {
    if (!this.initialized) {
      throw new Error('Database not initialized');
    }

    try {
      userData.lastActive = Date.now();
      userData.updatedAt = Date.now();

      await this.db.set(`user:${userId}`, JSON.stringify(userData));
      console.log(`✅ User ${userId} saved to Replit Database`);

    } catch (error) {
      console.log(`Error saving user ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * Add transaction
   */
  async addTransaction(userId, transaction) {
    try {
      // Store transaction with timestamp as key for easy retrieval
      const txKey = `tx:${userId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      await this.db.set(txKey, JSON.stringify(transaction));

      console.log(`✅ Transaction recorded for user ${userId}`);
      return { id: txKey };

    } catch (error) {
      console.log(`Error adding transaction for user ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get user transactions
   */
  async getUserTransactions(userId, limit = 50) {
    try {
      const txPrefix = `tx:${userId}:`;
      const keys = await this.db.list(txPrefix);

      // Get the most recent transactions
      const recentKeys = keys.slice(-limit);
      const transactions = [];

      for (const key of recentKeys) {
        try {
          const txData = await this.db.get(key);
          if (txData) {
            transactions.push(JSON.parse(txData));
          }
        } catch (parseError) {
          console.log(`Error parsing transaction ${key}:`, parseError.message);
        }
      }

      return transactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    } catch (error) {
      console.log(`Error getting transactions for user ${userId}:`, error.message);
      return [];
    }
  }

  /**
   * Add revenue record
   */
  async addRevenue(userId, revenue) {
    try {
      const revenueKey = `revenue:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      const revenueRecord = {
        userId: parseInt(userId),
        amount: revenue.amount,
        currency: revenue.currency,
        transactionId: revenue.transactionId,
        feeType: revenue.feeType,
        timestamp: Date.now()
      };

      await this.db.set(revenueKey, JSON.stringify(revenueRecord));

    } catch (error) {
      console.log(`Error adding revenue:`, error.message);
    }
  }

  /**
   * Get system statistics
   */
  async getSystemStats() {
    try {
      // Get all user keys
      const userKeys = await this.db.list('user:');
      const totalUsers = userKeys.length;

      // Count active users (last 24 hours)
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      let activeUsers = 0;

      for (const key of userKeys.slice(-100)) { // Check last 100 users for performance
        try {
          const userData = await this.db.get(key);
          if (userData) {
            const user = JSON.parse(userData);
            if (user.lastActive > oneDayAgo) {
              activeUsers++;
            }
          }
        } catch (error) {
          continue;
        }
      }

      // Get revenue data
      const revenueKeys = await this.db.list('revenue:');
      let totalRevenue = 0;

      for (const key of revenueKeys.slice(-100)) { // Check recent revenue
        try {
          const revenueData = await this.db.get(key);
          if (revenueData) {
            const revenue = JSON.parse(revenueData);
            if (revenue.currency === 'ETH') {
              totalRevenue += parseFloat(revenue.amount || 0);
            }
          }
        } catch (error) {
          continue;
        }
      }

      return {
        totalUsers,
        activeUsers,
        totalRevenue,
        uptime: Date.now()
      };

    } catch (error) {
      console.log('Error getting system stats:', error.message);
      return {
        totalUsers: 0,
        activeUsers: 0,
        totalRevenue: 0,
        uptime: Date.now()
      };
    }
  }

  /**
   * Migration helper - migrate from JSON files
   */
  async migrateFromJSON() {
    try {
      console.log('🔄 Starting migration from JSON files to Replit Database...');

      const fs = require('fs').promises;
      const path = require('path');
      const usersDir = path.join(__dirname, '..', 'db', 'users');

      let migratedCount = 0;

      try {
        const userFiles = await fs.readdir(usersDir);

        for (const file of userFiles) {
          if (!file.endsWith('.json')) continue;

          try {
            const userId = file.replace('.json', '');
            const userData = JSON.parse(await fs.readFile(path.join(usersDir, file), 'utf8'));

            // Save to Replit Database
            await this.saveUser(userId, userData);

            // Migrate transactions
            if (userData.transactions && userData.transactions.length > 0) {
              for (const tx of userData.transactions) {
                await this.addTransaction(userId, tx);
              }
            }

            migratedCount++;
            console.log(`✅ Migrated user ${userId} to Replit Database`);

          } catch (userError) {
            console.log(`⚠️ Failed to migrate user from ${file}:`, userError.message);
          }
        }

        console.log(`✅ Migration complete: ${migratedCount} users migrated to Replit Database`);

      } catch (dirError) {
        console.log('No existing users directory found, starting fresh');
      }

    } catch (error) {
      console.log('Migration error:', error.message);
    }
  }
}

// Export singleton instance
const databaseManager = new ReplitDatabaseManager();

module.exports = {
  getUser: (userId) => databaseManager.getUser(userId),
  saveUser: (userId, userData) => databaseManager.saveUser(userId, userData),
  addTransaction: (userId, transaction) => databaseManager.addTransaction(userId, transaction),
  getUserTransactions: (userId, limit) => databaseManager.getUserTransactions(userId, limit),
  addRevenue: (userId, revenue) => databaseManager.addRevenue(userId, revenue),
  getSystemStats: () => databaseManager.getSystemStats(),
  migrateFromJSON: () => databaseManager.migrateFromJSON(),
  initialize: () => databaseManager.initialize()
};