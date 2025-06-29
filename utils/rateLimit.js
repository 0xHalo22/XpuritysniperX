// ====================================================================
// RATE LIMITING UTILITIES
// Create this file as: utils/rateLimit.js
// ====================================================================

// Simple in-memory rate limiting
const rateLimits = new Map();

/**
 * Rate limit configuration
 */
const RATE_LIMITS = {
  transactions: {
    max: 10,           // 10 transactions
    window: 60 * 60 * 1000  // per hour
  },
  walletImports: {
    max: 3,            // 3 wallet imports
    window: 24 * 60 * 60 * 1000  // per day
  },
  apiCalls: {
    max: 100,          // 100 API calls
    window: 60 * 1000  // per minute
  }
};

/**
 * Check if user has exceeded rate limit
 * @param {string} userId - User ID
 * @param {string} action - Action type (transactions, walletImports, apiCalls)
 * @returns {Promise} - Resolves if allowed, rejects with error if limited
 */
async function checkRateLimit(userId, action) {
  const key = `${userId}:${action}`;
  const config = RATE_LIMITS[action];

  if (!config) {
    throw new Error(`Unknown rate limit action: ${action}`);
  }

  const now = Date.now();
  const userData = rateLimits.get(key) || { count: 0, firstRequest: now };

  // Reset window if expired
  if (now - userData.firstRequest > config.window) {
    userData.count = 0;
    userData.firstRequest = now;
  }

  // Check if limit exceeded
  if (userData.count >= config.max) {
    const resetTime = new Date(userData.firstRequest + config.window);
    const timeLeft = Math.ceil((resetTime - now) / 1000 / 60); // minutes

    throw new Error(`Rate limit exceeded. Try again in ${timeLeft} minutes.`);
  }

  // Update count
  userData.count++;
  rateLimits.set(key, userData);

  console.log(`Rate limit check: ${userId} ${action} - ${userData.count}/${config.max}`);
}

/**
 * Update rate limit (increment counter)
 * @param {string} userId - User ID  
 * @param {string} action - Action type
 */
async function updateRateLimit(userId, action) {
  // This function is called after successful action
  // Currently just for logging, actual increment happens in checkRateLimit
  console.log(`Rate limit updated: ${userId} ${action}`);
}

/**
 * Get current rate limit status for user
 * @param {string} userId - User ID
 * @param {string} action - Action type
 * @returns {object} - Current status
 */
function getRateLimitStatus(userId, action) {
  const key = `${userId}:${action}`;
  const config = RATE_LIMITS[action];
  const userData = rateLimits.get(key) || { count: 0, firstRequest: Date.now() };

  const now = Date.now();
  const windowExpired = now - userData.firstRequest > config.window;

  return {
    count: windowExpired ? 0 : userData.count,
    max: config.max,
    remaining: config.max - (windowExpired ? 0 : userData.count),
    resetTime: new Date(userData.firstRequest + config.window),
    windowExpired
  };
}

/**
 * Reset rate limits for a user (admin function)
 * @param {string} userId - User ID
 * @param {string} action - Action type (optional, resets all if not provided)
 */
function resetRateLimit(userId, action = null) {
  if (action) {
    const key = `${userId}:${action}`;
    rateLimits.delete(key);
    console.log(`Rate limit reset: ${userId} ${action}`);
  } else {
    // Reset all rate limits for user
    for (const key of rateLimits.keys()) {
      if (key.startsWith(`${userId}:`)) {
        rateLimits.delete(key);
      }
    }
    console.log(`All rate limits reset for user: ${userId}`);
  }
}

/**
 * Clean up expired rate limit entries (run periodically)
 */
function cleanupExpiredRateLimits() {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, userData] of rateLimits.entries()) {
    const action = key.split(':')[1];
    const config = RATE_LIMITS[action];

    if (config && now - userData.firstRequest > config.window) {
      rateLimits.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired rate limit entries`);
  }
}

// Clean up expired entries every 10 minutes
setInterval(cleanupExpiredRateLimits, 10 * 60 * 1000);

module.exports = {
  checkRateLimit,
  updateRateLimit,
  getRateLimitStatus,
  resetRateLimit,
  cleanupExpiredRateLimits,
  RATE_LIMITS
};