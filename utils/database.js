
// ====================================================================
// PHASE 5: REPLIT POSTGRESQL DATABASE LAYER
// Production-ready PostgreSQL database for scalable bot data
// ====================================================================

const { Pool } = require('pg');

class ReplitDatabaseManager {
  constructor() {
    this.pool = null;
    this.initialized = false;
  }

  /**
   * Initialize Replit PostgreSQL connection
   */
  async initialize() {
    try {
      console.log('🔍 Initializing Replit PostgreSQL Database...');

      // Get database URL from environment
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('DATABASE_URL environment variable not found');
      }

      // Use connection pooling for better performance
      const poolUrl = databaseUrl.replace('.us-east-2', '-pooler.us-east-2');
      
      this.pool = new Pool({
        connectionString: poolUrl,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });

      // Test connection
      const client = await this.pool.connect();
      
      // Create tables if they don't exist
      await this.createTables(client);
      
      client.release();

      this.initialized = true;
      console.log('✅ Replit PostgreSQL Database connected successfully');

    } catch (error) {
      console.log('❌ Replit PostgreSQL initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Create database tables
   */
  async createTables(client) {
    try {
      // Users table
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          user_id VARCHAR(255) PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Transactions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS transactions (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          data JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
      `);

      // Revenue table
      await client.query(`
        CREATE TABLE IF NOT EXISTS revenue (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255),
          amount DECIMAL(18, 8) NOT NULL,
          currency VARCHAR(10) NOT NULL,
          transaction_id VARCHAR(255),
          fee_type VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for better performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);
        CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
        CREATE INDEX IF NOT EXISTS idx_revenue_created_at ON revenue(created_at);
      `);

      console.log('✅ Database tables created/verified successfully');

    } catch (error) {
      console.log('❌ Error creating tables:', error.message);
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
      const client = await this.pool.connect();
      
      try {
        const result = await client.query('SELECT data FROM users WHERE user_id = $1', [userId]);

        if (result.rows.length === 0) {
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

        return result.rows[0].data;

      } finally {
        client.release();
      }

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

      const client = await this.pool.connect();
      
      try {
        await client.query(`
          INSERT INTO users (user_id, data, last_active) 
          VALUES ($1, $2, NOW()) 
          ON CONFLICT (user_id) 
          DO UPDATE SET 
            data = $2, 
            updated_at = NOW(), 
            last_active = NOW()
        `, [userId, userData]);

        console.log(`✅ User ${userId} saved to PostgreSQL Database`);

      } finally {
        client.release();
      }

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
      const client = await this.pool.connect();
      
      try {
        const result = await client.query(
          'INSERT INTO transactions (user_id, data) VALUES ($1, $2) RETURNING id',
          [userId, transaction]
        );

        console.log(`✅ Transaction recorded for user ${userId}`);
        return { id: result.rows[0].id };

      } finally {
        client.release();
      }

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
      const client = await this.pool.connect();
      
      try {
        const result = await client.query(
          'SELECT data FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
          [userId, limit]
        );

        return result.rows.map(row => row.data);

      } finally {
        client.release();
      }

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
      const client = await this.pool.connect();
      
      try {
        await client.query(
          'INSERT INTO revenue (user_id, amount, currency, transaction_id, fee_type) VALUES ($1, $2, $3, $4, $5)',
          [userId, revenue.amount, revenue.currency, revenue.transactionId, revenue.feeType]
        );

      } finally {
        client.release();
      }

    } catch (error) {
      console.log(`Error adding revenue:`, error.message);
    }
  }

  /**
   * Get system statistics
   */
  async getSystemStats() {
    try {
      const client = await this.pool.connect();
      
      try {
        // Get total users
        const userResult = await client.query('SELECT COUNT(*) as total FROM users');
        const totalUsers = parseInt(userResult.rows[0].total);

        // Get active users (last 24 hours)
        const activeResult = await client.query(
          'SELECT COUNT(*) as active FROM users WHERE last_active > NOW() - INTERVAL \'24 hours\''
        );
        const activeUsers = parseInt(activeResult.rows[0].active);

        // Get total revenue
        const revenueResult = await client.query(
          'SELECT SUM(amount) as total FROM revenue WHERE currency = \'ETH\''
        );
        const totalRevenue = parseFloat(revenueResult.rows[0].total || 0);

        return {
          totalUsers,
          activeUsers,
          totalRevenue,
          uptime: Date.now()
        };

      } finally {
        client.release();
      }

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
      console.log('🔄 Starting migration from JSON files to PostgreSQL Database...');

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

            // Save to PostgreSQL Database
            await this.saveUser(userId, userData);

            // Migrate transactions
            if (userData.transactions && userData.transactions.length > 0) {
              for (const tx of userData.transactions) {
                await this.addTransaction(userId, tx);
              }
            }

            migratedCount++;
            console.log(`✅ Migrated user ${userId} to PostgreSQL Database`);

          } catch (userError) {
            console.log(`⚠️ Failed to migrate user from ${file}:`, userError.message);
          }
        }

        console.log(`✅ Migration complete: ${migratedCount} users migrated to PostgreSQL Database`);

      } catch (dirError) {
        console.log('No existing users directory found, starting fresh');
      }

    } catch (error) {
      console.log('Migration error:', error.message);
    }
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      console.log('✅ PostgreSQL connection pool closed');
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
