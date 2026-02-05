/**
 * Auth API Routes - Privy Integration
 *
 * Privy handles authentication (social login, email, wallets).
 * This API verifies Privy JWTs and syncs user data with MongoDB.
 */

import { Router } from 'express';
import { PrivyClient } from '@privy-io/node';
import { ObjectId } from 'mongodb';
import rateLimit from 'express-rate-limit';

const router = Router();

// Initialize Privy client
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

let privyClient = null;
if (PRIVY_APP_ID && PRIVY_APP_SECRET) {
  privyClient = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
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
 * Verify Privy access token from Authorization header
 */
async function verifyPrivyToken(req, res, next) {
  try {
    if (!privyClient) {
      return res.status(500).json({ error: 'Auth service not configured' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    // Verify token with Privy
    const verifiedClaims = await privyClient.verifyAuthToken(token);

    // Attach Privy user ID to request
    req.privyUserId = verifiedClaims.userId;

    // Fetch user from MongoDB
    const user = await req.db.collection('User').findOne({ privyId: req.privyUserId });
    if (user) {
      req.user = user;
    }

    next();
  } catch (err) {
    console.error('Privy token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Export middleware for use in other routes
export { verifyPrivyToken };

// ===========================================
// ROUTES
// ===========================================

/**
 * POST /api/v1/auth/privy-sync
 * Sync Privy user with MongoDB (create or update)
 * Called on frontend after Privy login
 */
router.post('/privy-sync', syncLimiter, verifyPrivyToken, async (req, res) => {
  try {
    const { privyId, email, name, walletAddress } = req.body;

    // Verify the privyId matches the token
    if (privyId !== req.privyUserId) {
      return res.status(403).json({ error: 'Privy ID mismatch' });
    }

    const now = new Date();

    // Check if user exists
    let user = await req.db.collection('User').findOne({ privyId });

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

      // Update wallet if provided (Privy embedded wallet)
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

      await req.db.collection('User').updateOne(
        { _id: user._id },
        { $set: updates }
      );

      // Fetch updated user
      user = await req.db.collection('User').findOne({ _id: user._id });
    } else {
      // Create new user
      const newUser = {
        privyId,
        email: email || null,
        name: name || null,
        avatarUrl: null,
        walletAddress: walletAddress || null,
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

    res.json({
      user: {
        id: user._id.toString(),
        privyId: user.privyId,
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
    console.error('Privy sync error:', err);
    res.status(500).json({ error: 'Failed to sync user' });
  }
});

/**
 * GET /api/v1/auth/me
 * Get current user info
 */
router.get('/me', verifyPrivyToken, async (req, res) => {
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
        privyId: req.user.privyId,
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
router.patch('/me', verifyPrivyToken, async (req, res) => {
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
 * Note: Privy embedded wallets are auto-linked via privy-sync
 * This is for linking external wallets
 */
router.post('/link-wallet', verifyPrivyToken, async (req, res) => {
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
router.delete('/me', verifyPrivyToken, async (req, res) => {
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
