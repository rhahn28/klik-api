/**
 * User Authentication Middleware - Web3Auth Integration
 *
 * Web3Auth JWT verification for user sessions, subscription checks, and agent limits.
 */

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Web3Auth JWKS client for token verification
const WEB3AUTH_CLIENT_ID = process.env.WEB3AUTH_CLIENT_ID;
const client = jwksClient({
  jwksUri: 'https://api-auth.web3auth.io/jwks',
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
});

// Get signing key from JWKS
function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// Verify Web3Auth JWT token
async function verifyWeb3AuthToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        algorithms: ['RS256'],
        issuer: 'https://api-auth.web3auth.io',
        audience: WEB3AUTH_CLIENT_ID,
      },
      (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      }
    );
  });
}

/**
 * Verify Web3Auth JWT from Authorization header
 */
export const verifyUserJWT = async (req, res, next) => {
  try {
    if (!WEB3AUTH_CLIENT_ID) {
      console.error('Web3Auth not configured (WEB3AUTH_CLIENT_ID required)');
      return res.status(500).json({ error: 'Auth service unavailable' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.substring(7);

    // Verify token with Web3Auth JWKS
    const decoded = await verifyWeb3AuthToken(token);

    // Attach Web3Auth user info to request
    req.web3authUserId = decoded.verifierId || decoded.email;
    req.web3authUser = decoded;

    // Fetch user from MongoDB by web3authId
    const user = await req.db.collection('User').findOne({ web3authId: req.web3authUserId });

    if (!user) {
      return res.status(401).json({ error: 'User not found. Please complete signup.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.message?.includes('expired')) {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    console.error('Auth middleware error:', err.message);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

/**
 * Require active subscription to proceed
 */
export const requireSubscription = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const activeStatuses = ['active', 'trialing'];
  if (!activeStatuses.includes(req.user.subscriptionStatus)) {
    return res.status(403).json({
      error: 'Active subscription required',
      code: 'SUBSCRIPTION_REQUIRED',
      currentStatus: req.user.subscriptionStatus || 'inactive'
    });
  }

  next();
};

/**
 * Check agent limit based on subscription tier
 */
export const checkAgentLimit = async (req, res, next) => {
  const TIER_LIMITS = {
    free: 0,
    starter: 1,
    pro: 3,
    unlimited: 10
  };

  const tier = req.user.subscriptionTier || 'free';
  const maxAgents = TIER_LIMITS[tier] || 0;

  const agentCount = await req.db.collection('Agent').countDocuments({
    userId: req.user._id,
    status: { $ne: 'DELETED' }
  });

  if (agentCount >= maxAgents) {
    return res.status(403).json({
      error: `Your ${tier} plan allows ${maxAgents} agent(s). Upgrade to create more.`,
      code: 'AGENT_LIMIT_REACHED',
      current: agentCount,
      limit: maxAgents,
      tier
    });
  }

  next();
};

/**
 * Optional auth - sets req.user if token present, but doesn't require it
 */
export const optionalUserJWT = async (req, res, next) => {
  try {
    if (!WEB3AUTH_CLIENT_ID) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);

    try {
      const decoded = await verifyWeb3AuthToken(token);
      req.web3authUserId = decoded.verifierId || decoded.email;
      req.web3authUser = decoded;

      const user = await req.db.collection('User').findOne({ web3authId: req.web3authUserId });
      if (user) {
        req.user = user;
      }
    } catch (e) {
      // Token invalid but that's okay for optional auth
    }

    next();
  } catch (err) {
    // Don't fail on optional auth errors
    next();
  }
};
