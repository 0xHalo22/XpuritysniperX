const fs = require('fs').promises;
const path = require('path');

class Storage {
  constructor() {
    this.dbPath = path.join(__dirname, '..', 'db');
    this.usersFile = path.join(this.dbPath, 'users.json');
    this.transactionsFile = path.join(this.dbPath, 'transactions.json');

    // Ensure db directory exists
    this.initializeDatabase();
  }

  /**
   * Initialize database directory and files
   */
  async initializeDatabase() {
    try {
      // Create db directory if it doesn't exist
      await fs.mkdir(this.dbPath, { recursive: true });

      // Initialize users file if it doesn't exist
      try {
        await fs.access(this.usersFile);
      } catch {
        await fs.writeFile(this.usersFile, JSON.stringify({}));
      }

      // Initialize transactions file if it doesn't exist
      try {
        await fs.access(this.transactionsFile);
      } catch {
        await fs.writeFile(this.transactionsFile, JSON.stringify([]));
      }
    } catch (error) {
      console.error('Failed to initialize database:', error);
    }
  }

  /**
   * Load user data
   * @param {string} userId - User ID
   * @returns {object} - User data
   */
  async loadUserData(userId) {
    try {
      const data = await fs.readFile(this.usersFile, 'utf8');
      const users = JSON.parse(data);

      return users[userId] || {
        userId,
        wallets: [],
        activeWallet: 0,
        transactions: [],
        mirrorTargets: [],
        settings: {
          slippage: 3,
          gasMultiplier: 1.2,
          snipeStrategy: 'both',
          maxSnipeAmount: '0.1'
        },
        premium: {
          active: false,
          expiresAt: null
        },
        stats: {
          totalTrades: 0,
          totalVolume: 0,
          totalFees: 0,
          winRate: 0
        },
        createdAt: Date.now(),
        lastActive: Date.now()
      };
    } catch (error) {
      console.error('Failed to load user data:', error);
      // Return default user data on error
      return {
        userId,
        wallets: [],
        activeWallet: 0,
        transactions: [],
        mirrorTargets: [],
        settings: {
          slippage: 3,
          gasMultiplier: 1.2,
          snipeStrategy: 'both',
          maxSnipeAmount: '0.1'
        },
        premium: {
          active: false,
          expiresAt: null
        },
        stats: {
          totalTrades: 0,
          totalVolume: 0,
          totalFees: 0,
          winRate: 0
        },
        createdAt: Date.now(),
        lastActive: Date.now()
      };
    }
  }

  /**
   * Save user data
   * @param {string} userId - User ID
   * @param {object} userData - User data to save
   */
  async saveUserData(userId, userData) {
    try {
      const data = await fs.readFile(this.usersFile, 'utf8');
      const users = JSON.parse(data);

      // Update last active timestamp
      userData.lastActive = Date.now();

      users[userId] = userData;

      await fs.writeFile(this.usersFile, JSON.stringify(users, null, 2));
    } catch (error) {
      console.error('Failed to save user data:', error);
      throw error;
    }
  }

  /**
   * Get all users (for admin/analytics)
   * @returns {object} - All user data
   */
  async getAllUsers() {
    try {
      const data = await fs.readFile(this.usersFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Failed to get all users:', error);
      return {};
    }
  }

  /**
   * Log transaction
   * @param {object} transaction - Transaction data
   */
  async logTransaction(transaction) {
    try {
      const data = await fs.readFile(this.transactionsFile, 'utf8');
      const transactions = JSON.parse(data);

      const txRecord = {
        ...transaction,
        timestamp: Date.now(),
        id: this.generateTransactionId()
      };

      transactions.push(txRecord);

      // Keep only last 10,000 transactions to prevent file from growing too large
      if (transactions.length > 10000) {
        transactions.splice(0, transactions.length - 10000);
      }

      await fs.writeFile(this.transactionsFile, JSON.stringify(transactions, null, 2));

      // Also add to user's personal transaction history
      if (transaction.userId) {
        const userData = await this.loadUserData(transaction.userId);
        userData.transactions.push(txRecord);

        // Update user stats
        userData.stats.totalTrades++;
        userData.stats.totalVolume += parseFloat(transaction.amount || 0);
        userData.stats.totalFees += parseFloat(transaction.fee || 0);

        await this.saveUserData(transaction.userId, userData);
      }

      return txRecord;
    } catch (error) {
      console.error('Failed to log transaction:', error);
      throw error;
    }
  }

  /**
   * Get user transaction history
   * @param {string} userId - User ID
   * @param {number} limit - Number of transactions to return
   * @returns {Array} - User transactions
   */
  async getUserTransactions(userId, limit = 50) {
    try {
      const userData = await this.loadUserData(userId);
      return userData.transactions
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    } catch (error) {
      console.error('Failed to get user transactions:', error);
      return [];
    }
  }

  /**
   * Generate unique transaction ID
   * @returns {string} - Transaction ID
   */
  generateTransactionId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  /**
   * Update user settings
   * @param {string} userId - User ID
   * @param {object} newSettings - Settings to update
   */
  async updateUserSettings(userId, newSettings) {
    try {
      const userData = await this.loadUserData(userId);
      userData.settings = { ...userData.settings, ...newSettings };
      await this.saveUserData(userId, userData);
      return userData.settings;
    } catch (error) {
      console.error('Failed to update user settings:', error);
      throw error;
    }
  }

  /**
   * Add mirror target for user
   * @param {string} userId - User ID
   * @param {object} mirrorTarget - Mirror target data
   */
  async addMirrorTarget(userId, mirrorTarget) {
    try {
      const userData = await this.loadUserData(userId);

      // Check if target already exists
      const exists = userData.mirrorTargets.some(target => 
        target.address.toLowerCase() === mirrorTarget.address.toLowerCase()
      );

      if (exists) {
        throw new Error('Mirror target already exists');
      }

      // Check mirror target limit
      if (userData.mirrorTargets.length >= 5) {
        throw new Error('Maximum 5 mirror targets allowed');
      }

      userData.mirrorTargets.push({
        ...mirrorTarget,
        id: this.generateTransactionId(),
        addedAt: Date.now(),
        active: true
      });

      await this.saveUserData(userId, userData);
      return userData.mirrorTargets;
    } catch (error) {
      console.error('Failed to add mirror target:', error);
      throw error;
    }
  }

  /**
   * Remove mirror target
   * @param {string} userId - User ID
   * @param {string} targetId - Target ID to remove
   */
  async removeMirrorTarget(userId, targetId) {
    try {
      const userData = await this.loadUserData(userId);
      userData.mirrorTargets = userData.mirrorTargets.filter(target => target.id !== targetId);
      await this.saveUserData(userId, userData);
      return userData.mirrorTargets;
    } catch (error) {
      console.error('Failed to remove mirror target:', error);
      throw error;
    }
  }

  /**
   * Export user data as CSV
   * @param {string} userId - User ID
   * @returns {string} - CSV data
   */
  async exportUserDataCSV(userId) {
    try {
      const transactions = await this.getUserTransactions(userId, 1000);

      const csvHeader = 'Date,Type,Token,Amount,Price,Fee,Gas,Hash,Status\n';
      const csvRows = transactions.map(tx => {
        const date = new Date(tx.timestamp).toISOString();
        return `${date},${tx.type || 'unknown'},${tx.token || 'ETH'},${tx.amount || 0},${tx.price || 0},${tx.fee || 0},${tx.gas || 0},${tx.hash || ''},${tx.status || 'completed'}`;
      }).join('\n');

      return csvHeader + csvRows;
    } catch (error) {
      console.error('Failed to export user data:', error);
      throw error;
    }
  }

  /**
   * Get bot statistics
   * @returns {object} - Bot statistics
   */
  async getBotStats() {
    try {
      const users = await this.getAllUsers();
      const userIds = Object.keys(users);

      const stats = {
        totalUsers: userIds.length,
        activeUsers: userIds.filter(id => users[id].lastActive > Date.now() - 24 * 60 * 60 * 1000).length,
        totalWallets: userIds.reduce((sum, id) => sum + (users[id].wallets?.length || 0), 0),
        totalTransactions: userIds.reduce((sum, id) => sum + (users[id].stats?.totalTrades || 0), 0),
        totalVolume: userIds.reduce((sum, id) => sum + (users[id].stats?.totalVolume || 0), 0),
        totalFees: userIds.reduce((sum, id) => sum + (users[id].stats?.totalFees || 0), 0)
      };

      return stats;
    } catch (error) {
      console.error('Failed to get bot stats:', error);
      return {
        totalUsers: 0,
        activeUsers: 0,
        totalWallets: 0,
        totalTransactions: 0,
        totalVolume: 0,
        totalFees: 0
      };
    }
  }

  /**
   * Backup database
   * @returns {string} - Backup file path
   */
  async backupDatabase() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(this.dbPath, 'backups');
      await fs.mkdir(backupDir, { recursive: true });

      const backupFile = path.join(backupDir, `backup-${timestamp}.json`);
      const users = await this.getAllUsers();

      await fs.writeFile(backupFile, JSON.stringify(users, null, 2));
      return backupFile;
    } catch (error) {
      console.error('Failed to backup database:', error);
      throw error;
    }
  }
}

// Export both class and convenience functions
const storage = new Storage();

module.exports = {
  Storage,
  loadUserData: (userId) => storage.loadUserData(userId),
  saveUserData: (userId, data) => storage.saveUserData(userId, data),
  logTransaction: (transaction) => storage.logTransaction(transaction),
  getUserTransactions: (userId, limit) => storage.getUserTransactions(userId, limit),
  updateUserSettings: (userId, settings) => storage.updateUserSettings(userId, settings),
  addMirrorTarget: (userId, target) => storage.addMirrorTarget(userId, target),
  removeMirrorTarget: (userId, targetId) => storage.removeMirrorTarget(userId, targetId),
  exportUserDataCSV: (userId) => storage.exportUserDataCSV(userId),
  getBotStats: () => storage.getBotStats(),
  backupDatabase: () => storage.backupDatabase()
};