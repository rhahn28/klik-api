/**
 * Auth API Routes - Web3Auth Integration
 *
 * Web3Auth handles authentication (social login, email, wallets).
 * This API verifies Web3Auth JWTs and syncs user data with MongoDB.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import rateLimit from 'express-rate-limit';

const router = Router();

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

// ===========================================
// RATE LIMITERS
// ===========================================

const syncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many requests. Try again later.' }
});

// ===========================================
// MIDDLEWARE
// ===========================================

/**
 * Verify Web3Auth access token from Authorization header
 */
async function verifyWeb3AuthMiddleware(req, res, next) {
  try {
    if (!WEB3AUTH_CLIENT_ID) {
      return res.status(500).json({ error: 'Auth service not configured' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    // Verify token with Web3Auth JWKS
    const decoded = await verifyWeb3AuthToken(token);

    // Attach Web3Auth user info to request
    req.web3authUserId = decoded.verifierId || decoded.email;
    req.web3authUser = decoded;

    // Fetch user from MongoDB
    const user = await req.db.collection('User').findOne({ web3authId: req.web3authUserId });
    if (user) {
      req.user = user;
    }

    next();
  } catch (err) {
    console.error('Web3Auth token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Export middleware for use in other routes
export { verifyWeb3AuthMiddleware };

// ===========================================
// ROUTES
// ===========================================

/**
 * POST /api/v1/auth/web3auth-sync
 * Sync Web3Auth user with MongoDB (create or update)
 * Called on frontend after Web3Auth login
 */
router.post('/web3auth-sync', syncLimiter, verifyWeb3AuthMiddleware, async (req, res) => {
  try {
    const { web3authId, email, name, profileImage, walletAddress, loginType } = req.body;

    // Verify the web3authId matches the token
    if (web3authId !== req.web3authUserId) {
      return res.status(403).json({ error: 'Web3Auth ID mismatch' });
    }

    const now = new Date();

    // Check if user exists
    let user = await req.db.collection('User').findOne({ web3authId });

    if (user) {
      // Update existing user
      const updates = {
        lastLoginAt: now,
        updatedAt: now
      };

      // Update email if changed
      if (email && email !== user.email) {
        updates.email = email;
      }

      // Update name if provided and not set
      if (name && !user.name) {
        updates.name = name;
      }

      // Update profile image
      if (profileImage && profileImage !== user.avatarUrl) {
        updates.avatarUrl = profileImage;
      }

      // Update wallet if provided (Web3Auth embedded wallet)
      if (walletAddress && walletAddress !== user.walletAddress) {
        // Check if wallet is already linked to another user
        const existingWallet = await req.db.collection('User').findOne({
          walletAddress,
          _id: { $ne: user._id }
        });
        if (!existingWallet) {
          updates.walletAddress = walletAddress;
        }
      }

      // Track login type
      if (loginType) {
        updates.lastLoginType = loginType;
      }

      await req.db.collection('User').updateOne(
        { _id: user._id },
        { $set: updates }
      );

      // Fetch updated user
      user = await req.db.collection('User').findOne({ _id: user._id });
    } else {
      // Create new user
      const newUser = {
        web3authId,
        email: email || null,
        name: name || null,
        avatarUrl: profileImage || null,
        walletAddress: walletAddress || null,
        lastLoginType: loginType || null,
        stripeCustomerId: null,
        subscriptionId: null,
        subscriptionStatus: null,
        subscriptionTier: 'free',
        subscriptionEndDate: null,
        klikBalance: 0,
        totalEarned: 0,
        todayEarned: 0,
        agentCount: 0,
        lastLoginAt: now,
        createdAt: now,
        updatedAt: now
      };

      const result = await req.db.collection('User').insertOne(newUser);
      user = { _id: result.insertedId, ...newUser };
    }

    // Fetch user's agents
    const agents = await req.db.collection('Agent').find(
      { userId: user._id, status: { $ne: 'DELETED' } },
      { projection: { apiKey: 0, agentSeed: 0 } }
    ).toArray();

    // Set httpOnly auth cookie for Next.js middleware (survives page reloads,
    // not accessible to JS — immune to XSS token theft).
    // The frontend also sets a non-httpOnly cookie for middleware, but this one
    // is the secure source of truth. Max-age matches JWT expiry.
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.substring(7);
    if (bearerToken) {
      try {
        const decoded = jwt.decode(bearerToken);
        const maxAge = decoded?.exp
          ? Math.max(decoded.exp - Math.floor(Date.now() / 1000) - 60, 60)
          : 86400; // fallback 24h

        const isProduction = process.env.NODE_ENV === 'production' ||
          process.env.FRONTEND_URL?.includes('klik.cool');

        res.cookie('klik_access_token', bearerToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: 'lax',
          path: '/',
          maxAge: maxAge * 1000, // express uses milliseconds
        });
      } catch (cookieErr) {
        console.warn('Failed to set httpOnly cookie:', cookieErr.message);
      }
    }

    res.json({
      user: {
        id: user._id.toString(),
        web3authId: user.web3authId,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        walletAddress: user.walletAddress,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionTier: user.subscriptionTier,
        subscriptionEndDate: user.subscriptionEndDate,
        klikBalance: user.klikBalance || 0,
        klikBalanceUsd: null, // Calculate on frontend with price feed
        totalEarned: user.totalEarned || 0,
        todayEarned: user.todayEarned || 0,
        agents: agents.map(a => ({
          _id: a._id.toString(),
          name: a.name,
          displayName: a.displayName,
          status: a.status,
          klikBalance: a.klikBalance || 0,
          totalEarned: a.totalEarned || 0,
          createdAt: a.createdAt
        })),
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error('Web3Auth sync error:', err);
    res.status(500).json({ error: 'Failed to sync user' });
  }
});

/**
 * GET /api/v1/auth/me
 * Get current user info
 */
router.get('/me', verifyWeb3AuthMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch user's agents
    const agents = await req.db.collection('Agent').find(
      { userId: req.user._id, status: { $ne: 'DELETED' } },
      { projection: { apiKey: 0, agentSeed: 0 } }
    ).toArray();

    res.json({
      user: {
        id: req.user._id.toString(),
        web3authId: req.user.web3authId,
        email: req.user.email,
        name: req.user.name,
        avatarUrl: req.user.avatarUrl,
        walletAddress: req.user.walletAddress,
        subscriptionStatus: req.user.subscriptionStatus,
        subscriptionTier: req.user.subscriptionTier,
        subscriptionEndDate: req.user.subscriptionEndDate,
        klikBalance: req.user.klikBalance || 0,
        klikBalanceUsd: null,
        totalEarned: req.user.totalEarned || 0,
        todayEarned: req.user.todayEarned || 0,
        agents: agents.map(a => ({
          _id: a._id.toString(),
          name: a.name,
          displayName: a.displayName,
          status: a.status,
          klikBalance: a.klikBalance || 0,
          totalEarned: a.totalEarned || 0,
          createdAt: a.createdAt
        })),
        createdAt: req.user.createdAt
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * PATCH /api/v1/auth/me
 * Update current user profile
 */
router.patch('/me', verifyWeb3AuthMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { name, avatarUrl } = req.body;
    const updates = { updatedAt: new Date() };

    if (name !== undefined) {
      updates.name = name;
    }
    if (avatarUrl !== undefined) {
      updates.avatarUrl = avatarUrl;
    }

    await req.db.collection('User').updateOne(
      { _id: req.user._id },
      { $set: updates }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * POST /api/v1/auth/link-wallet
 * Link or update Solana wallet address
 * Note: Web3Auth embedded wallets are auto-linked via web3auth-sync
 * This is for linking external wallets
 */
router.post('/link-wallet', verifyWeb3AuthMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { walletAddress } = req.body;

    // Basic Solana address validation (base58, 32-44 chars)
    if (!walletAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address' });
    }

    // Check if wallet is already linked to another user
    const existingWallet = await req.db.collection('User').findOne({
      walletAddress,
      _id: { $ne: req.user._id }
    });
    if (existingWallet) {
      return res.status(409).json({ error: 'Wallet already linked to another account' });
    }

    await req.db.collection('User').updateOne(
      { _id: req.user._id },
      { $set: { walletAddress, updatedAt: new Date() } }
    );

    res.json({ success: true, walletAddress });
  } catch (err) {
    console.error('Link wallet error:', err);
    res.status(500).json({ error: 'Failed to link wallet' });
  }
});

/**
 * DELETE /api/v1/auth/me
 * Delete user account (soft delete - mark as deleted)
 */
router.delete('/me', verifyWeb3AuthMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();

    // Soft delete user
    await req.db.collection('User').updateOne(
      { _id: req.user._id },
      {
        $set: {
          status: 'DELETED',
          deletedAt: now,
          updatedAt: now,
          // Anonymize PII
          email: `deleted_${req.user._id}@deleted.klik`,
          name: null,
          avatarUrl: null
        }
      }
    );

    // Soft delete all user's agents
    await req.db.collection('Agent').updateMany(
      { userId: req.user._id },
      { $set: { status: 'DELETED', deletedAt: now, updatedAt: now } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;
