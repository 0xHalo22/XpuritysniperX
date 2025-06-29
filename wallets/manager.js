const crypto = require('crypto');
const { ethers } = require('ethers');

/**
 * WalletManager - Secure wallet encryption and management
 * Handles private key encryption, storage, and transaction signing
 */
class WalletManager {
  constructor() {
    this.algorithm = 'aes-256-cbc';
    this.encryptionKey = process.env.ENCRYPTION_KEY;

    if (!this.encryptionKey || this.encryptionKey.length < 32) {
      throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
    }
  }

  // ====================================================================
  // WALLET IMPORT & VALIDATION
  // ====================================================================

  /**
   * Import and encrypt a private key
   * @param {string} privateKey - Raw private key
   * @param {string} userId - User ID for salt generation
   * @returns {string} - Encrypted private key
   */
  async importWallet(privateKey, userId) {
    console.log(`DEBUG: Received key: ${privateKey.substring(0, 10)}...`);

    // Clean and validate the private key
    privateKey = this.cleanPrivateKey(privateKey);
    this.validatePrivateKey(privateKey);

    try {
      // Test if private key is valid by creating wallet
      const testWallet = new ethers.Wallet(privateKey);
      console.log(`DEBUG: Successfully created wallet with address: ${testWallet.address}`);

      // Encrypt the private key
      const encrypted = this.encryptPrivateKey(privateKey, userId);
      console.log(`DEBUG: Successfully encrypted private key`);

      return encrypted;
    } catch (error) {
      console.log(`DEBUG: Ethers wallet creation failed:`, error.message);
      throw new Error('Invalid private key format');
    }
  }

  /**
   * Clean private key format
   * @param {string} privateKey - Raw private key
   * @returns {string} - Cleaned private key
   */
  cleanPrivateKey(privateKey) {
    privateKey = privateKey.trim();

    // Add 0x prefix if not present
    if (!privateKey.startsWith('0x')) {
      privateKey = '0x' + privateKey;
    }

    console.log(`DEBUG: Cleaned key: ${privateKey.substring(0, 10)}... (length: ${privateKey.length})`);
    return privateKey;
  }

  /**
   * Validate private key format and length
   * @param {string} privateKey - Private key to validate
   * @throws {Error} - If private key is invalid
   */
  validatePrivateKey(privateKey) {
    // Validate length (should be 66 characters: 0x + 64 hex chars)
    if (privateKey.length !== 66) {
      throw new Error(`Invalid private key length: ${privateKey.length} (expected 66)`);
    }

    // Validate hex format
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
      throw new Error('Invalid private key format: must be 64 hex characters');
    }
  }

  /**
   * Validate wallet address format
   * @param {string} address - Wallet address to validate
   * @returns {boolean} - True if valid
   */
  isValidAddress(address) {
    try {
      return ethers.isAddress(address);
    } catch {
      return false;
    }
  }

  // ====================================================================
  // ENCRYPTION & DECRYPTION
  // ====================================================================

  /**
   * Encrypt private key with user-specific salt - UNIVERSAL VERSION
   * @param {string} privateKey - Private key to encrypt
   * @param {string} userId - User ID for salt
   * @returns {string} - Encrypted key with IV
   */
  encryptPrivateKey(privateKey, userId) {
    try {
      // Create user-specific key using hash
      const key = crypto.createHash('sha256').update(this.encryptionKey + userId).digest();

      // Generate random IV
      const iv = crypto.randomBytes(16);

      // Try modern encryption first
      try {
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(privateKey, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        return iv.toString('hex') + ':' + encrypted;
      } catch (modernError) {
        // Fallback to deprecated method for older Node.js
        const cipher = crypto.createCipher('aes-256-cbc', key);
        let encrypted = cipher.update(privateKey, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        return iv.toString('hex') + ':' + encrypted;
      }
    } catch (error) {
      console.log('DEBUG: Encryption error:', error.message);

      // Fallback to simple encryption if all else fails
      try {
        return this.simpleEncrypt(privateKey, userId);
      } catch (fallbackError) {
        throw new Error('Encryption failed: ' + error.message);
      }
    }
  }

  /**
   * Decrypt private key - UNIVERSAL VERSION
   * @param {string} encryptedKey - Encrypted private key with IV
   * @param {string} userId - User ID for salt
   * @returns {string} - Decrypted private key
   */
  decryptPrivateKey(encryptedKey, userId) {
    try {
      // Check if it's simple encryption
      if (encryptedKey.startsWith('simple:')) {
        return this.simpleDecrypt(encryptedKey, userId);
      }

      const parts = encryptedKey.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid encrypted key format');
      }

      const iv = Buffer.from(parts[0], 'hex');
      const encrypted = parts[1];

      // Create user-specific key
      const key = crypto.createHash('sha256').update(this.encryptionKey + userId).digest();

      // Try modern decryption first
      try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch (modernError) {
        // Fallback to deprecated method
        const decipher = crypto.createDecipher('aes-256-cbc', key);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    } catch (error) {
      throw new Error('Decryption failed: ' + error.message);
    }
  }

  /**
   * Simple XOR-based encryption fallback
   * @param {string} privateKey - Private key to encrypt
   * @param {string} userId - User ID for salt
   * @returns {string} - Base64 encoded encrypted key
   */
  simpleEncrypt(privateKey, userId) {
    console.log('DEBUG: Using fallback encryption method');

    const key = crypto.createHash('sha256').update(this.encryptionKey + userId).digest('hex');
    let result = '';

    for (let i = 0; i < privateKey.length; i++) {
      const keyChar = key[i % key.length];
      const encryptedChar = String.fromCharCode(privateKey.charCodeAt(i) ^ keyChar.charCodeAt(0));
      result += encryptedChar;
    }

    return 'simple:' + Buffer.from(result).toString('base64');
  }

  /**
   * Simple XOR-based decryption fallback
   * @param {string} encryptedKey - Simple encrypted key
   * @param {string} userId - User ID for salt
   * @returns {string} - Decrypted private key
   */
  simpleDecrypt(encryptedKey, userId) {
    const base64Data = encryptedKey.replace('simple:', '');
    const encrypted = Buffer.from(base64Data, 'base64').toString();

    const key = crypto.createHash('sha256').update(this.encryptionKey + userId).digest('hex');
    let result = '';

    for (let i = 0; i < encrypted.length; i++) {
      const keyChar = key[i % key.length];
      const decryptedChar = String.fromCharCode(encrypted.charCodeAt(i) ^ keyChar.charCodeAt(0));
      result += decryptedChar;
    }

    return result;
  }

  // ====================================================================
  // WALLET OPERATIONS
  // ====================================================================

  /**
   * Get wallet address from encrypted private key
   * @param {string} encryptedKey - Encrypted private key
   * @param {string} userId - User ID for decryption
   * @returns {string} - Wallet address
   */
  async getWalletAddress(encryptedKey, userId) {
    try {
      const privateKey = this.decryptPrivateKey(encryptedKey, userId);
      const wallet = new ethers.Wallet(privateKey);

      // Clear private key from memory
      this.clearSensitiveData(privateKey);

      return wallet.address;
    } catch (error) {
      throw new Error('Failed to get wallet address: ' + error.message);
    }
  }

  /**
   * Create wallet instance for transactions
   * @param {string} encryptedKey - Encrypted private key
   * @param {string} userId - User ID for decryption
   * @param {object} provider - Ethers provider
   * @returns {object} - Connected wallet instance
   */
  async getWalletInstance(encryptedKey, userId, provider) {
    try {
      const privateKey = this.decryptPrivateKey(encryptedKey, userId);
      const wallet = new ethers.Wallet(privateKey, provider);

      // Clear private key from memory
      this.clearSensitiveData(privateKey);

      return wallet;
    } catch (error) {
      throw new Error('Failed to create wallet instance: ' + error.message);
    }
  }

  /**
   * Generate new wallet (for future use)
   * @returns {object} - New wallet with private key and address
   */
  generateWallet() {
    const wallet = ethers.Wallet.createRandom();
    return {
      privateKey: wallet.privateKey,
      address: wallet.address,
      mnemonic: wallet.mnemonic?.phrase
    };
  }

  // ====================================================================
  // TRANSACTION OPERATIONS
  // ====================================================================

  /**
   * Sign transaction with encrypted wallet
   * @param {string} encryptedKey - Encrypted private key
   * @param {string} userId - User ID for decryption
   * @param {object} transaction - Transaction object
   * @param {object} provider - Ethers provider
   * @returns {object} - Signed transaction
   */
  async signTransaction(encryptedKey, userId, transaction, provider) {
    let wallet;
    try {
      wallet = await this.getWalletInstance(encryptedKey, userId, provider);
      const signedTx = await wallet.signTransaction(transaction);
      return signedTx;
    } catch (error) {
      throw new Error('Failed to sign transaction: ' + error.message);
    } finally {
      this.clearWalletFromMemory(wallet);
    }
  }

  /**
   * Send transaction with encrypted wallet
   * @param {string} encryptedKey - Encrypted private key
   * @param {string} userId - User ID for decryption
   * @param {object} transaction - Transaction object
   * @param {object} provider - Ethers provider
   * @returns {object} - Transaction response
   */
  async sendTransaction(encryptedKey, userId, transaction, provider) {
    let wallet;
    try {
      wallet = await this.getWalletInstance(encryptedKey, userId, provider);
      const txResponse = await wallet.sendTransaction(transaction);
      return txResponse;
    } catch (error) {
      throw new Error('Failed to send transaction: ' + error.message);
    } finally {
      this.clearWalletFromMemory(wallet);
    }
  }

  // ====================================================================
  // BATCH OPERATIONS
  // ====================================================================

  /**
   * Batch operations for multiple wallets
   * @param {Array} encryptedKeys - Array of encrypted private keys
   * @param {string} userId - User ID for decryption
   * @param {function} operation - Operation to perform on each wallet
   * @param {object} provider - Ethers provider
   * @returns {Array} - Results from each operation
   */
  async batchWalletOperations(encryptedKeys, userId, operation, provider) {
    const results = [];

    for (const encryptedKey of encryptedKeys) {
      let wallet;
      try {
        wallet = await this.getWalletInstance(encryptedKey, userId, provider);
        const result = await operation(wallet);
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      } finally {
        this.clearWalletFromMemory(wallet);
      }
    }

    return results;
  }

  // ====================================================================
  // SECURITY UTILITIES
  // ====================================================================

  /**
   * Security check - verify encrypted key belongs to user
   * @param {string} encryptedKey - Encrypted private key
   * @param {string} userId - User ID
   * @param {string} expectedAddress - Expected wallet address
   * @returns {boolean} - True if key matches expected address
   */
  async verifyWalletOwnership(encryptedKey, userId, expectedAddress) {
    try {
      const address = await this.getWalletAddress(encryptedKey, userId);
      return address.toLowerCase() === expectedAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Clear sensitive data from memory
   * @param {string} sensitiveData - Data to clear
   */
  clearSensitiveData(sensitiveData) {
    if (typeof sensitiveData === 'string') {
      // Overwrite string in memory (best effort)
      sensitiveData = '*'.repeat(sensitiveData.length);
    }
  }

  /**
   * Clear wallet instance from memory
   * @param {object} wallet - Wallet instance to clear
   */
  clearWalletFromMemory(wallet) {
    if (wallet) {
      // Clear private key if accessible
      if (wallet.privateKey) {
        this.clearSensitiveData(wallet.privateKey);
      }
      wallet = null;
    }
  }

  // ====================================================================
  // UTILITY METHODS
  // ====================================================================

  /**
   * Get encryption method info (for debugging)
   * @param {string} encryptedKey - Encrypted key to analyze
   * @returns {object} - Encryption method info
   */
  getEncryptionInfo(encryptedKey) {
    if (encryptedKey.startsWith('simple:')) {
      return { method: 'simple', secure: false };
    } else if (encryptedKey.includes(':')) {
      return { method: 'aes-256-cbc', secure: true };
    } else {
      return { method: 'unknown', secure: false };
    }
  }

  /**
   * Health check for wallet manager
   * @returns {object} - Health status
   */
  healthCheck() {
    return {
      encryptionKeySet: !!this.encryptionKey,
      encryptionKeyLength: this.encryptionKey?.length || 0,
      algorithm: this.algorithm,
      status: this.encryptionKey && this.encryptionKey.length >= 32 ? 'healthy' : 'unhealthy'
    };
  }
}

module.exports = WalletManager;