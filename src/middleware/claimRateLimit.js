/**
 * Claim Rate Limiting Middleware
 *
 * Layered rate limiting for OpenClaw claim endpoints.
 * Uses express-rate-limit for per-IP limits and Redis for
 * cross-instance abuse detection (per-wallet failed attempts,
 * hourly IP attempt caps).
 */

import rateLimit from 'express-rate-limit';

/**
 * Rate limit for /check endpoint.
 * 60 requests per minute per IP — generous for eligibility lookups.
 */
export const claimCheckRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many eligibility checks. Please wait a moment.',
    code: 'RATE_LIMIT_CHECK',
    retryAfter: 60,
  },
});

/**
 * Rate limit for /nonce endpoint.
 * 10 requests per minute per IP, 5-minute block on exceed.
 */
export const claimNonceRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many nonce requests. Please wait 5 minutes.',
    code: 'RATE_LIMIT_NONCE',
    retryAfter: 300,
  },
});

/**
 * Rate limit for /verify endpoint.
 * 5 requests per minute per IP, 15-minute block on exceed.
 */
export const claimVerifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many claim attempts. Please wait 15 minutes.',
    code: 'RATE_LIMIT_VERIFY',
    retryAfter: 900,
  },
});

/**
 * Rate limit for /opt-out endpoint.
 * 3 requests per minute per IP, 30-minute block on exceed.
 */
export const claimOptOutRateLimit = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many opt-out attempts. Please wait 30 minutes.',
    code: 'RATE_LIMIT_OPT_OUT',
    retryAfter: 1800,
  },
});

/**
 * Redis-backed abuse detection middleware.
 *
 * Two checks:
 * 1. IP attempt count: Block after 100 claim-related requests per hour.
 * 2. Per-wallet failed claims: Block wallet after 5 failures per hour.
 *
 * Falls through gracefully if Redis is unavailable (rate limiting
 * still handled by express-rate-limit above).
 */
export async function detectClaimAbuse(req, res, next) {
  const redis = req.redis;
  if (!redis || !redis.isReady) {
    return next();
  }

  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const wallet = req.body?.wallet || req.query?.wallet || null;

    // --- Check 1: IP hourly attempt cap (100/hour) ---
    const ipKey = `claim:abuse:ip:${ip}`;
    const ipCount = await redis.incr(ipKey);

    if (ipCount === 1) {
      await redis.expire(ipKey, 3600);
    }

    if (ipCount > 100) {
      console.warn(`Claim abuse: IP ${ip} exceeded 100 attempts/hour (count: ${ipCount})`);
      return res.status(429).json({
        error: 'Too many claim attempts from this IP. Please try again in an hour.',
        code: 'ABUSE_IP_BLOCKED',
        retryAfter: 3600,
      });
    }

    // --- Check 2: Per-wallet failed claim attempts (5 failures/hour) ---
    if (wallet) {
      const walletFailKey = `claim:abuse:wallet:${wallet}`;
      const walletFailCount = await redis.get(walletFailKey);

      if (walletFailCount && parseInt(walletFailCount, 10) >= 5) {
        console.warn(`Claim abuse: Wallet ${wallet} exceeded 5 failed attempts/hour`);
        return res.status(429).json({
          error: 'Too many failed claim attempts for this wallet. Please try again in an hour.',
          code: 'ABUSE_WALLET_BLOCKED',
          retryAfter: 3600,
        });
      }
    }

    next();
  } catch (err) {
    // Redis error should not block the request
    console.error('Claim abuse detection error:', err.message);
    next();
  }
}

/**
 * Record a failed claim attempt for a wallet address.
 * Called from the verify route when signature verification fails.
 *
 * @param {object} redis - Redis client instance
 * @param {string} wallet - The wallet address that failed
 */
export async function recordFailedClaimAttempt(redis, wallet) {
  if (!redis || !redis.isReady || !wallet) {
    return;
  }

  try {
    const key = `claim:abuse:wallet:${wallet}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 3600);
    }
  } catch (err) {
    console.error('Failed to record claim attempt:', err.message);
  }
}
