/**
 * User Authentication Middleware
 *
 * JWT verification for user sessions, subscription checks, and agent limits.
 */

import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Verify JWT from cookie or Authorization header
 */
export const verifyUserJWT = async (req, res, next) => {
  try {
    // Try cookie first (for SSR/browser), then Authorization header (for API clients)
    let token = req.cookies?.klik_access_token;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!JWT_SECRET) {
      console.error('JWT_SECRET not configured');
      return res.status(500).json({ error: 'Auth service unavailable' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await req.db.collection('User').findOne(
      { _id: new ObjectId(decoded.userId) },
      { projection: { passwordHash: 0 } }
    );

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token', code: 'TOKEN_INVALID' });
    }
    console.error('Auth middleware error:', err);
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
    let token = req.cookies?.klik_access_token;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (token && JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await req.db.collection('User').findOne(
          { _id: new ObjectId(decoded.userId) },
          { projection: { passwordHash: 0 } }
        );
        if (user) {
          req.user = user;
        }
      } catch (e) {
        // Token invalid but that's okay for optional auth
      }
    }

    next();
  } catch (err) {
    // Don't fail on optional auth errors
    next();
  }
};
