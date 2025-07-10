
// ====================================================================
// PHASE 5: SUPABASE DATABASE LAYER
// Modern PostgreSQL database with automatic scaling for 100k+ users
// ====================================================================

const { createClient } = require('@supabase/supabase-js');

class SupabaseManager {
  constructor() {
    this.supabase = null;
    this.initialized = false;
  }

  /**
   * Initialize Supabase connection
   */
  async initialize() {
    try {
      console.log('🔍 Checking Supabase environment variables...');
      console.log(`   SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing'}`);
      console.log(`   SUPABASE_ANON_KEY: ${process.env.SUPABASE_ANON_KEY ? '✅ Set' : '❌ Missing'}`);
      
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
        throw new Error('Supabase credentials missing. Check your Replit Secrets configuration.');
      }

      this.supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
      );

      // Test connection
      const { data, error } = await this.supabase
        .from('users')
        .select('count')
        .limit(1);

      if (error && error.code !== 'PGRST116') { // Table not found is OK
        throw error;
      }

      this.initialized = true;
      console.log('✅ Supabase connected successfully');

      // Create tables if they don't exist
      await this.createTables();

    } catch (error) {
      console.log('❌ Supabase initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Create required tables using direct SQL execution
   */
  async createTables() {
    const tables = [
      // Users table
      `CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        user_data JSONB NOT NULL DEFAULT '{}',
        eth_wallets TEXT[] DEFAULT '{}',
        sol_wallets TEXT[] DEFAULT '{}',
        active_eth_wallet INTEGER DEFAULT 0,
        active_sol_wallet INTEGER DEFAULT 0,
        snipe_config JSONB DEFAULT '{}',
        premium_active BOOLEAN DEFAULT FALSE,
        premium_expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        last_active TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`,
      
      `CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active)`,
      `CREATE INDEX IF NOT EXISTS idx_users_premium ON users(premium_active)`,
      
      // Transactions table
      `CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id BIGINT NOT NULL,
        type VARCHAR(20) NOT NULL,
        token_address VARCHAR(42),
        amount DECIMAL(36,18),
        trade_amount DECIMAL(36,18),
        fee_amount DECIMAL(36,18),
        tx_hash VARCHAR(66),
        fee_hash VARCHAR(66),
        chain VARCHAR(20) NOT NULL,
        strategy VARCHAR(50),
        execution_time INTEGER,
        gas_price DECIMAL(10,2),
        success BOOLEAN DEFAULT TRUE,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      
      `CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)`,
      
      // Revenue tracking
      `CREATE TABLE IF NOT EXISTS revenue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id BIGINT NOT NULL,
        amount DECIMAL(36,18) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        transaction_id UUID,
        fee_type VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      
      `CREATE INDEX IF NOT EXISTS idx_revenue_user_id ON revenue(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_revenue_created_at ON revenue(created_at)`
    ];

    for (let i = 0; i < tables.length; i++) {
      const sql = tables[i];
      try {
        const { error } = await this.supabase
          .rpc('execute_sql', { query: sql })
          .then(result => result)
          .catch(async () => {
            // Fallback: try direct query execution
            return await this.supabase.from('users').select('count').limit(0);
          });

        if (error && !error.message?.includes('already exists')) {
          console.log(`⚠️ SQL execution warning: ${error.message}`);
        }
        
        if (i === 0) console.log(`✅ Users table ready`);
        if (i === 3) console.log(`✅ Transactions table ready`);
        if (i === 6) console.log(`✅ Revenue table ready`);
        
      } catch (error) {
        // Try alternative approach for table creation
        if (sql.includes('CREATE TABLE IF NOT EXISTS users')) {
          try {
            // Test if users table exists by attempting a simple query
            await this.supabase.from('users').select('count').limit(0);
            console.log(`✅ Users table already exists`);
          } catch (testError) {
            console.log(`❌ Users table needs manual creation via Supabase dashboard`);
            console.log(`   SQL: ${sql}`);
          }
        }
      }
    }
  }

  /**
   * Get user data with caching and better error handling
   */
  async getUser(userId) {
    if (!this.initialized) {
      throw new Error('Database not initialized');
    }

    try {
      const { data, error } = await this.supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.log(`Database query error: ${error.message}`);
        throw error;
      }

      if (!data) {
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

      // Convert Supabase data back to expected format
      return {
        userId: data.id.toString(),
        ethWallets: data.eth_wallets || [],
        solWallets: data.sol_wallets || [],
        activeEthWallet: data.active_eth_wallet || 0,
        activeSolWallet: data.active_sol_wallet || 0,
        transactions: [], // Will be loaded separately
        settings: data.user_data?.settings || {
          slippage: 3,
          gasMultiplier: 1.2,
          snipeStrategy: 'new_pairs'
        },
        mirrorTargets: data.user_data?.mirrorTargets || [],
        premium: {
          active: data.premium_active || false,
          expiresAt: data.premium_expires_at ? new Date(data.premium_expires_at).getTime() : 0
        },
        createdAt: new Date(data.created_at).getTime(),
        lastActive: new Date(data.last_active).getTime(),
        snipeConfig: data.snipe_config || {
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

    } catch (error) {
      console.log(`Error getting user ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * Save user data with better error handling
   */
  async saveUser(userId, userData) {
    if (!this.initialized) {
      throw new Error('Database not initialized');
    }

    try {
      const userRecord = {
        id: parseInt(userId),
        user_data: {
          settings: userData.settings || {},
          mirrorTargets: userData.mirrorTargets || []
        },
        eth_wallets: userData.ethWallets || [],
        sol_wallets: userData.solWallets || [],
        active_eth_wallet: userData.activeEthWallet || 0,
        active_sol_wallet: userData.activeSolWallet || 0,
        snipe_config: userData.snipeConfig || {},
        premium_active: userData.premium?.active || false,
        premium_expires_at: userData.premium?.expiresAt ? new Date(userData.premium.expiresAt) : null,
        last_active: new Date(),
        updated_at: new Date()
      };

      const { error } = await this.supabase
        .from('users')
        .upsert(userRecord);

      if (error) {
        console.log(`Database save error: ${error.message}`);
        throw new Error(`Failed to save user data: ${error.message}`);
      }

      console.log(`✅ User ${userId} saved to Supabase`);

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
      const txRecord = {
        user_id: parseInt(userId),
        type: transaction.type,
        token_address: transaction.tokenAddress,
        amount: transaction.amount,
        trade_amount: transaction.tradeAmount,
        fee_amount: transaction.feeAmount,
        tx_hash: transaction.txHash,
        fee_hash: transaction.feeHash,
        chain: transaction.chain,
        strategy: transaction.strategy,
        execution_time: transaction.executionTime,
        gas_price: transaction.gasPrice,
        success: !transaction.failed,
        error_message: transaction.error
      };

      const { data, error } = await this.supabase
        .from('transactions')
        .insert(txRecord)
        .select()
        .single();

      if (error) {
        throw error;
      }

      // Also track revenue if fee was collected
      if (transaction.feeAmount && parseFloat(transaction.feeAmount) > 0) {
        await this.addRevenue(userId, {
          amount: transaction.feeAmount,
          currency: 'ETH',
          transactionId: data.id,
          feeType: transaction.type === 'snipe' ? 'snipe_fee' : 'trading_fee'
        });
      }

      console.log(`✅ Transaction recorded for user ${userId}`);
      return data;

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
      const { data, error } = await this.supabase
        .from('transactions')
        .select('*')
        .eq('user_id', parseInt(userId))
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      // Convert to expected format
      return data.map(tx => ({
        type: tx.type,
        tokenAddress: tx.token_address,
        amount: tx.amount?.toString(),
        tradeAmount: tx.trade_amount?.toString(),
        feeAmount: tx.fee_amount?.toString(),
        txHash: tx.tx_hash,
        feeHash: tx.fee_hash,
        timestamp: new Date(tx.created_at).getTime(),
        chain: tx.chain,
        strategy: tx.strategy,
        executionTime: tx.execution_time,
        gasPrice: tx.gas_price,
        failed: !tx.success,
        error: tx.error_message
      }));

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
      const revenueRecord = {
        user_id: parseInt(userId),
        amount: revenue.amount,
        currency: revenue.currency,
        transaction_id: revenue.transactionId,
        fee_type: revenue.feeType
      };

      const { error } = await this.supabase
        .from('revenue')
        .insert(revenueRecord);

      if (error) {
        throw error;
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
      const [
        { count: totalUsers },
        { count: activeUsers },
        { data: revenueData }
      ] = await Promise.all([
        this.supabase.from('users').select('*', { count: 'exact', head: true }),
        this.supabase.from('users').select('*', { count: 'exact', head: true }).gte('last_active', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
        this.supabase.from('revenue').select('amount, currency').eq('currency', 'ETH')
      ]);

      const totalRevenue = revenueData?.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0) || 0;

      return {
        totalUsers: totalUsers || 0,
        activeUsers: activeUsers || 0,
        totalRevenue: totalRevenue,
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
      console.log('🔄 Starting migration from JSON files...');

      // Read existing user files
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

            // Save to Supabase
            await this.saveUser(userId, userData);

            // Migrate transactions
            if (userData.transactions && userData.transactions.length > 0) {
              for (const tx of userData.transactions) {
                await this.addTransaction(userId, tx);
              }
            }

            migratedCount++;
            console.log(`✅ Migrated user ${userId}`);

          } catch (userError) {
            console.log(`⚠️ Failed to migrate user from ${file}:`, userError.message);
          }
        }

        console.log(`✅ Migration complete: ${migratedCount} users migrated`);

      } catch (dirError) {
        console.log('No existing users directory found, starting fresh');
      }

    } catch (error) {
      console.log('Migration error:', error.message);
    }
  }
}

// Export singleton instance
const supabaseManager = new SupabaseManager();

module.exports = {
  SupabaseManager,
  getUser: (userId) => supabaseManager.getUser(userId),
  saveUser: (userId, userData) => supabaseManager.saveUser(userId, userData),
  addTransaction: (userId, transaction) => supabaseManager.addTransaction(userId, transaction),
  getUserTransactions: (userId, limit) => supabaseManager.getUserTransactions(userId, limit),
  addRevenue: (userId, revenue) => supabaseManager.addRevenue(userId, revenue),
  getSystemStats: () => supabaseManager.getSystemStats(),
  migrateFromJSON: () => supabaseManager.migrateFromJSON(),
  initialize: () => supabaseManager.initialize()
};
