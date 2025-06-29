const crypto = require('crypto');
const { ethers } = require('ethers');

class WalletManager {
  constructor() {
    this.algorithm = 'aes-256-cbc';
    this.encryptionKey = process.env.ENCRYPTION_KEY;

    if (!this.encryptionKey || this.encryptionKey.length < 32) {
      throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
    }
  }

  /**
   * Import and encrypt a private key
   * @param {string} privateKey - Raw private key
   * @param {string} userId - User ID for salt generation
   * @returns {string} - Encrypted private key
   */
  async importWallet(privateKey, userId) {
    console.log(`DEBUG: Received key: ${privateKey.substring(0, 10)}...`);

    // Clean the private key
    privateKey = privateKey.trim();

    // Add 0x prefix if not present
    if (!privateKey.startsWith('0x')) {
      privateKey = '0x' + privateKey;
    }

    console.log(`DEBUG: Cleaned key: ${privateKey.substring(0, 10)}... (length: ${privateKey.length})`);

    // Validate length (should be 66 characters: 0x + 64 hex chars)
    if (privateKey.length !== 66) {
      throw new Error(`Invalid private key length: ${privateKey.length} (expected 66)`);
    }

    // Validate hex format
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
      throw new Error('Invalid private key format: must be 64 hex characters');
    }

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
   * Encrypt private key with user-specific salt
   * @param {string} privateKey - Private key to encrypt
   * @param {string} userId - User ID for salt
   * @returns {string} - Encrypted key with IV
   */
  encryptPrivateKey(privateKey, userId) {
    try {
      // Create user-specific salt
      const salt = crypto.createHash('sha256').update(userId + this.encryptionKey).digest();

      // Generate random IV
      const iv = crypto.randomBytes(16);

      // Create cipher
      const cipher = crypto.createCipher(this.algorithm, salt);

      // Encrypt
      let encrypted = cipher.update(privateKey, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Combine IV and encrypted data
      return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
      throw new Error('Encryption failed: ' + error.message);
    }
  }

  /**
   * Decrypt private key
   * @param {string} encryptedKey - Encrypted private key with IV
   * @param {string} userId - User ID for salt
   * @returns {string} - Decrypted private key
   */
  decryptPrivateKey(encryptedKey, userId) {
    try {
      const parts = encryptedKey.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid encrypted key format');
      }

      const iv = Buffer.from(parts[0], 'hex');
      const encrypted = parts[1];

      // Create user-specific salt
      const salt = crypto.createHash('sha256').update(userId + this.encryptionKey).digest();

      // Create decipher
      const decipher = crypto.createDecipher(this.algorithm, salt);

      // Decrypt
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error('Decryption failed: ' + error.message);
    }
  }

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
      privateKey.replace(/./g, '0');

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

  /**
   * Validate wallet address format
   * @param {string} address - Wallet address to validate
   * @returns {boolean} - True if valid
   */
  isValidAddress(address) {
    try {
      return ethers.utils.isAddress(address);
    } catch {
      return false;
    }
  }

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
      // Clear wallet from memory
      if (wallet) {
        wallet = null;
      }
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
      // Clear wallet from memory
      if (wallet) {
        wallet = null;
      }
    }
  }

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
      try {
        const wallet = await this.getWalletInstance(encryptedKey, userId, provider);
        const result = await operation(wallet);
        results.push({ success: true, result });

        // Clear wallet from memory
        wallet = null;
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }

    return results;
  }

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
}

module.exports = WalletManager;