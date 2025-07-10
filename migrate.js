
const { initialize, migrateFromJSON } = require('./utils/database');

async function runMigration() {
  try {
    console.log('🔄 Starting migration of existing user data to PostgreSQL...');
    
    // Initialize the database connection
    await initialize();
    
    // Run the migration from JSON files
    await migrateFromJSON();
    
    console.log('✅ Migration completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
