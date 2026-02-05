/**
 * User Authentication Middleware - Privy Integration
 *
 * Privy JWT verification for user sessions, subscription checks, and agent limits.
 */

import { PrivyClient } from '@privy-io/node';

// Initialize Privy client
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

let privyClient = null;
if (PRIVY_APP_ID && PRIVY_APP_SECRET) {
  privyClient = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
}

/**
 * Verify Privy JWT from Authorization header
 */
export const verifyUserJWT = async (req, res, next) => {
  try {
    if (!privyClient) {
      console.error('Privy client not configured (PRIVY_APP_ID and PRIVY_APP_SECRET required)');
      return res.status(500).json({ error: 'Auth service unavailable' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.substring(7);

    // Verify token with Privy
    const verifiedClaims = await privyClient.verifyAuthToken(token);

    // Attach Privy user ID to request
    req.privyUserId = verifiedClaims.userId;

    // Fetch user from MongoDB by privyId
    const user = await req.db.collection('User').findOne({ privyId: req.privyUserId });

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
    if (!privyClient) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);

    try {
      const verifiedClaims = await privyClient.verifyAuthToken(token);
      req.privyUserId = verifiedClaims.userId;

      const user = await req.db.collection('User').findOne({ privyId: req.privyUserId });
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
