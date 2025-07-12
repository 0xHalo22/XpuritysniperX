
const { initialize, migrateFromJSON, getSystemStats } = require('./utils/database');

async function runMigration() {
  try {
    console.log('🔄 Starting migration of existing user data to Replit PostgreSQL...');
    
    // Initialize the database connection
    console.log('📡 Connecting to Replit PostgreSQL Database...');
    await initialize();
    console.log('✅ Database connection established!');
    
    // Run the migration from JSON files
    console.log('🔄 Migrating JSON files to PostgreSQL...');
    await migrateFromJSON();
    console.log('✅ Migration completed successfully!');
    
    // Show final statistics
    console.log('📊 Getting final statistics...');
    const stats = await getSystemStats();
    console.log('📈 MIGRATION SUMMARY:');
    console.log(`   • Total Users: ${stats.totalUsers}`);
    console.log(`   • Active Users: ${stats.activeUsers}`);
    console.log(`   • Total Revenue: ${stats.totalRevenue} ETH`);
    console.log('');
    console.log('🎉 Your bot is now running on Replit PostgreSQL Database!');
    console.log('🚀 Ready for high-volume trading and scalable performance!');
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error('💡 The bot will continue to work with JSON files as fallback');
    process.exit(1);
  }
}

// Add test database connection function
async function testDatabaseConnection() {
  try {
    console.log('🧪 Testing Replit PostgreSQL Database connection...');
    
    await initialize();
    console.log('✅ Database connection test passed!');
    
    const stats = await getSystemStats();
    console.log('📊 Current database state:');
    console.log(`   • Users: ${stats.totalUsers}`);
    console.log(`   • Active: ${stats.activeUsers}`);
    console.log(`   • Revenue: ${stats.totalRevenue} ETH`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Database connection test failed:', error.message);
    process.exit(1);
  }
}

// Check command line arguments
const command = process.argv[2];

if (command === 'test') {
  testDatabaseConnection();
} else {
  runMigration();
}
