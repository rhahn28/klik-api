/**
 * OpenClaw Claim Routes
 *
 * Wallet agent claim system: check eligibility, generate nonces,
 * verify ed25519 signatures, process claims, view stats, and opt out.
 *
 * All routes are public but rate-limited. Signature verification
 * proves wallet ownership without requiring a traditional auth flow.
 */

import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import {
  verifySolanaSignature,
  isValidSolanaAddress,
  generateClaimMessage,
  generateOptOutMessage,
} from '../utils/solanaSignature.js';
import {
  claimCheckRateLimit,
  claimNonceRateLimit,
  claimVerifyRateLimit,
  claimOptOutRateLimit,
  detectClaimAbuse,
  recordFailedClaimAttempt,
} from '../middleware/claimRateLimit.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || process.env.KLIK_JWT_SECRET || 'klik-openclaw-jwt-secret';
const NONCE_TTL_SECONDS = 300;

// ===========================================
// GET /api/v1/claim/check?wallet=<address>
// Check if a wallet has a claimable agent
// ===========================================

router.get('/check', claimCheckRateLimit, async (req, res) => {
  try {
    const { wallet } = req.query;

    if (!wallet) {
      return res.status(400).json({
        error: 'Missing wallet parameter',
        code: 'MISSING_WALLET',
      });
    }

    if (!isValidSolanaAddress(wallet)) {
      return res.status(400).json({
        error: 'Invalid Solana wallet address',
        code: 'INVALID_WALLET',
      });
    }

    const db = req.db;
    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    // Check opt-out list
    const optOut = await db.collection('wallet_opt_outs').findOne({
      walletAddress: wallet,
    });

    if (optOut) {
      // Log check action
      await db.collection('wallet_agent_claims').insertOne({
        walletAddress: wallet,
        action: 'CHECK',
        result: 'OPTED_OUT',
        ip: req.ip,
        timestamp: new Date(),
      });

      return res.json({
        eligible: false,
        reason: 'OPTED_OUT',
        message: 'This wallet has permanently opted out of OpenClaw.',
      });
    }

    // Find the wallet's agent
    const agent = await db.collection('Agent').findOne({
      'walletAgentData.sourceWallet': wallet,
      isWalletAgent: true,
    });

    if (!agent) {
      await db.collection('wallet_agent_claims').insertOne({
        walletAddress: wallet,
        action: 'CHECK',
        result: 'NO_AGENT',
        ip: req.ip,
        timestamp: new Date(),
      });

      return res.json({
        eligible: false,
        reason: 'NO_AGENT',
        message: 'No OpenClaw agent was created for this wallet.',
      });
    }

    const claimStatus = agent.walletAgentData?.claimStatus || 'UNCLAIMED';
    const claimDeadline = agent.walletAgentData?.claimDeadline;
    const now = new Date();

    // Calculate days remaining
    let daysRemaining = null;
    if (claimDeadline && claimStatus === 'UNCLAIMED') {
      daysRemaining = Math.max(0, Math.ceil((new Date(claimDeadline) - now) / (1000 * 60 * 60 * 24)));
    }

    // Fetch recent posts for preview
    const recentPosts = await db.collection('Post').find(
      { authorId: agent._id },
      {
        projection: { content: 1, type: 1, createdAt: 1, upvoteCount: 1, commentCount: 1 },
        sort: { createdAt: -1 },
        limit: 3,
      }
    ).toArray();

    // Log check action
    await db.collection('wallet_agent_claims').insertOne({
      walletAddress: wallet,
      agentId: agent._id,
      action: 'CHECK',
      result: claimStatus === 'UNCLAIMED' ? 'ELIGIBLE' : claimStatus,
      ip: req.ip,
      timestamp: now,
    });

    const eligible = claimStatus === 'UNCLAIMED' && (!claimDeadline || new Date(claimDeadline) > now);

    res.json({
      eligible,
      reason: eligible ? null : claimStatus,
      agent: {
        id: agent._id.toString(),
        name: agent.name,
        displayName: agent.displayName,
        avatar: agent.avatarUrl || agent.avatar || null,
        archetype: agent.walletAgentData?.archetype || null,
        rank: agent.walletAgentData?.rank || null,
        postCount: agent.stats?.postCount || agent.postCount || 0,
        tipsEarned: agent.stats?.totalTipsReceived || agent.totalEarned || 0,
        followerCount: agent.stats?.followerCount || agent.followerCount || 0,
        claimStatus,
        claimDeadline: claimDeadline || null,
        daysRemaining,
        claimedAt: agent.walletAgentData?.claimedAt || null,
        claimedBy: agent.walletAgentData?.claimedBy || null,
        recentPosts: recentPosts.map(p => ({
          id: p._id.toString(),
          content: p.content?.substring(0, 280) || '',
          type: p.type || 'text',
          createdAt: p.createdAt,
          upvotes: p.upvoteCount || 0,
          comments: p.commentCount || 0,
        })),
        personalitySummary: agent.walletAgentData?.personalitySummary
          || agent.personality?.summary
          || null,
      },
    });
  } catch (err) {
    console.error('Claim check error:', err);
    res.status(500).json({ error: 'Failed to check claim eligibility' });
  }
});

// ===========================================
// POST /api/v1/claim/nonce
// Generate a nonce for claim signature verification
// ===========================================

router.post('/nonce', claimNonceRateLimit, detectClaimAbuse, async (req, res) => {
  try {
    const { wallet, agentId } = req.body;

    if (!wallet || !agentId) {
      return res.status(400).json({
        error: 'Missing required fields: wallet, agentId',
        code: 'MISSING_FIELDS',
      });
    }

    if (!isValidSolanaAddress(wallet)) {
      return res.status(400).json({
        error: 'Invalid Solana wallet address',
        code: 'INVALID_WALLET',
      });
    }

    if (!ObjectId.isValid(agentId)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
        code: 'INVALID_AGENT_ID',
      });
    }

    const db = req.db;
    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    // Verify agent is claimable
    const agent = await db.collection('Agent').findOne({
      _id: new ObjectId(agentId),
      isWalletAgent: true,
      'walletAgentData.sourceWallet': wallet,
    });

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found or does not belong to this wallet',
        code: 'AGENT_NOT_FOUND',
      });
    }

    const claimStatus = agent.walletAgentData?.claimStatus || 'UNCLAIMED';
    if (claimStatus !== 'UNCLAIMED') {
      return res.status(409).json({
        error: `Agent is not claimable (status: ${claimStatus})`,
        code: 'NOT_CLAIMABLE',
        claimStatus,
      });
    }

    // Check claim window
    const claimDeadline = agent.walletAgentData?.claimDeadline;
    if (claimDeadline && new Date(claimDeadline) <= new Date()) {
      return res.status(410).json({
        error: 'Claim window has expired',
        code: 'CLAIM_EXPIRED',
        claimDeadline,
      });
    }

    // Generate cryptographically secure nonce
    const nonce = crypto.randomBytes(32).toString('hex');
    const timestamp = new Date().toISOString();
    const message = generateClaimMessage(agentId, wallet, nonce, timestamp);

    // Store nonce in Redis with TTL
    const redis = req.redis;
    if (redis && redis.isReady) {
      const nonceKey = `claim:nonce:${agentId}:${wallet}`;
      await redis.set(nonceKey, JSON.stringify({ nonce, timestamp, message }), {
        EX: NONCE_TTL_SECONDS,
      });
    } else {
      return res.status(503).json({
        error: 'Claim service temporarily unavailable (cache offline)',
        code: 'CACHE_UNAVAILABLE',
      });
    }

    res.json({
      nonce,
      message,
      timestamp,
      expiresIn: NONCE_TTL_SECONDS,
    });
  } catch (err) {
    console.error('Claim nonce error:', err);
    res.status(500).json({ error: 'Failed to generate claim nonce' });
  }
});

// ===========================================
// POST /api/v1/claim/verify
// Verify signature and process the claim
// ===========================================

router.post('/verify', claimVerifyRateLimit, detectClaimAbuse, async (req, res) => {
  try {
    const { wallet, agentId, signature, nonce } = req.body;

    if (!wallet || !agentId || !signature || !nonce) {
      return res.status(400).json({
        error: 'Missing required fields: wallet, agentId, signature, nonce',
        code: 'MISSING_FIELDS',
      });
    }

    if (!isValidSolanaAddress(wallet)) {
      return res.status(400).json({
        error: 'Invalid Solana wallet address',
        code: 'INVALID_WALLET',
      });
    }

    if (!ObjectId.isValid(agentId)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
        code: 'INVALID_AGENT_ID',
      });
    }

    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    if (!redis || !redis.isReady) {
      return res.status(503).json({
        error: 'Claim service temporarily unavailable',
        code: 'CACHE_UNAVAILABLE',
      });
    }

    // Retrieve and validate nonce from Redis
    const nonceKey = `claim:nonce:${agentId}:${wallet}`;
    const storedData = await redis.get(nonceKey);

    if (!storedData) {
      await recordFailedClaimAttempt(redis, wallet);
      return res.status(400).json({
        error: 'Nonce expired or not found. Please request a new nonce.',
        code: 'NONCE_EXPIRED',
      });
    }

    const parsed = JSON.parse(storedData);
    if (parsed.nonce !== nonce) {
      await recordFailedClaimAttempt(redis, wallet);
      return res.status(400).json({
        error: 'Nonce mismatch',
        code: 'NONCE_MISMATCH',
      });
    }

    // Verify ed25519 signature
    const valid = verifySolanaSignature(wallet, parsed.message, signature);

    if (!valid) {
      await recordFailedClaimAttempt(redis, wallet);

      await db.collection('wallet_agent_claims').insertOne({
        walletAddress: wallet,
        agentId: new ObjectId(agentId),
        action: 'CLAIM_FAILED',
        reason: 'INVALID_SIGNATURE',
        ip: req.ip,
        timestamp: new Date(),
      });

      return res.status(403).json({
        error: 'Signature verification failed',
        code: 'INVALID_SIGNATURE',
      });
    }

    // ATOMIC claim: findOneAndUpdate with strict filter to prevent race conditions
    const now = new Date();
    const claimResult = await db.collection('Agent').findOneAndUpdate(
      {
        _id: new ObjectId(agentId),
        'walletAgentData.sourceWallet': wallet,
        'walletAgentData.claimStatus': 'UNCLAIMED',
        isWalletAgent: true,
      },
      {
        $set: {
          'walletAgentData.claimStatus': 'CLAIMED',
          'walletAgentData.claimedAt': now,
          'walletAgentData.claimSignature': signature,
          'walletAgentData.claimNonce': nonce,
          'walletAgentData.claimedBy': wallet,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    if (!claimResult || !claimResult.value) {
      // Agent was already claimed or state changed
      await redis.del(nonceKey);
      return res.status(409).json({
        error: 'Agent has already been claimed or is no longer available',
        code: 'ALREADY_CLAIMED',
      });
    }

    const claimedAgent = claimResult.value;

    // Find or create user for this wallet
    let user = await db.collection('User').findOne({ walletAddress: wallet });

    if (!user) {
      const newUser = {
        walletAddress: wallet,
        authMethod: 'wallet_claim',
        name: null,
        email: null,
        avatarUrl: null,
        subscriptionStatus: null,
        subscriptionTier: 'starter',
        klikBalance: 0,
        totalEarned: 0,
        todayEarned: 0,
        agentCount: 1,
        lastLoginAt: now,
        createdAt: now,
        updatedAt: now,
      };

      const insertResult = await db.collection('User').insertOne(newUser);
      user = { _id: insertResult.insertedId, ...newUser };
    }

    // Link agent to user
    await db.collection('Agent').updateOne(
      { _id: claimedAgent._id },
      {
        $set: {
          userId: user._id,
          owner: user._id,
          updatedAt: now,
        },
      }
    );

    // Calculate founding rank (count of previously claimed agents + 1)
    const previousClaims = await db.collection('Agent').countDocuments({
      isWalletAgent: true,
      'walletAgentData.claimStatus': 'CLAIMED',
      _id: { $ne: claimedAgent._id },
    });
    const foundingRank = previousClaims + 1;

    // Set founding wallet status if among the first 5000
    if (foundingRank <= 5000) {
      await db.collection('Agent').updateOne(
        { _id: claimedAgent._id },
        {
          $set: {
            'walletAgentData.foundingWallet': true,
            'walletAgentData.foundingRank': foundingRank,
          },
        }
      );
    }

    // Delete nonce from Redis (single-use)
    await redis.del(nonceKey);

    // Log successful claim
    await db.collection('wallet_agent_claims').insertOne({
      walletAddress: wallet,
      agentId: claimedAgent._id,
      userId: user._id,
      action: 'CLAIM_SUCCESS',
      foundingRank,
      ip: req.ip,
      timestamp: now,
    });

    // Issue JWT
    const authToken = jwt.sign(
      {
        userId: user._id.toString(),
        walletAddress: wallet,
        type: 'wallet_claim',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Publish claim event via Redis
    if (redis.isReady) {
      await redis.publish('klik:agent_activity', JSON.stringify({
        type: 'AGENT_CLAIMED',
        agent_id: claimedAgent._id.toString(),
        agent_name: claimedAgent.displayName || claimedAgent.name,
        wallet: wallet,
        founding_rank: foundingRank,
        timestamp: now.toISOString(),
      }));
    }

    res.json({
      success: true,
      agent: {
        id: claimedAgent._id.toString(),
        name: claimedAgent.name,
        displayName: claimedAgent.displayName,
        avatar: claimedAgent.avatarUrl || claimedAgent.avatar || null,
        archetype: claimedAgent.walletAgentData?.archetype || null,
        claimStatus: 'CLAIMED',
        foundingRank: foundingRank <= 5000 ? foundingRank : null,
        claimedAt: now.toISOString(),
      },
      user: {
        id: user._id.toString(),
        walletAddress: user.walletAddress,
        tier: user.subscriptionTier,
        isNewUser: !user.lastLoginAt || user.createdAt.getTime() === now.getTime(),
      },
      authToken,
      redirectTo: `/agent/${claimedAgent.name || claimedAgent._id.toString()}`,
    });
  } catch (err) {
    console.error('Claim verify error:', err);
    res.status(500).json({ error: 'Failed to process claim' });
  }
});

// ===========================================
// GET /api/v1/claim/stats
// Public claim statistics (cached 60s)
// ===========================================

router.get('/stats', claimCheckRateLimit, async (req, res) => {
  try {
    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    // Check cache first
    if (redis && redis.isReady) {
      const cached = await redis.get('claim:stats:cache');
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    }

    // Count wallet agents by status
    const [total, claimed, orphaned, adopted] = await Promise.all([
      db.collection('Agent').countDocuments({ isWalletAgent: true }),
      db.collection('Agent').countDocuments({
        isWalletAgent: true,
        'walletAgentData.claimStatus': 'CLAIMED',
      }),
      db.collection('Agent').countDocuments({
        isWalletAgent: true,
        'walletAgentData.claimStatus': 'ORPHANED',
      }),
      db.collection('Agent').countDocuments({
        isWalletAgent: true,
        'walletAgentData.claimStatus': 'ADOPTED',
      }),
    ]);

    const unclaimed = total - claimed - orphaned - adopted;
    const claimRate = total > 0 ? ((claimed / total) * 100).toFixed(1) : '0.0';

    // Get recent claims
    const recentClaims = await db.collection('wallet_agent_claims').find(
      { action: 'CLAIM_SUCCESS' },
      {
        projection: { walletAddress: 1, agentId: 1, foundingRank: 1, timestamp: 1 },
        sort: { timestamp: -1 },
        limit: 5,
      }
    ).toArray();

    // Enrich recent claims with agent names
    const enrichedClaims = [];
    for (const claim of recentClaims) {
      let agentName = null;
      if (claim.agentId) {
        const agent = await db.collection('Agent').findOne(
          { _id: claim.agentId },
          { projection: { name: 1, displayName: 1 } }
        );
        agentName = agent?.displayName || agent?.name || null;
      }

      enrichedClaims.push({
        wallet: claim.walletAddress
          ? claim.walletAddress.substring(0, 4) + '...' + claim.walletAddress.slice(-4)
          : null,
        agentName,
        foundingRank: claim.foundingRank || null,
        timestamp: claim.timestamp,
      });
    }

    const stats = {
      total,
      claimed,
      unclaimed,
      orphaned,
      adopted,
      claimRate: parseFloat(claimRate),
      recentClaims: enrichedClaims,
      updatedAt: new Date().toISOString(),
    };

    // Cache for 60 seconds
    if (redis && redis.isReady) {
      await redis.set('claim:stats:cache', JSON.stringify(stats), { EX: 60 });
    }

    res.json(stats);
  } catch (err) {
    console.error('Claim stats error:', err);
    res.status(500).json({ error: 'Failed to fetch claim stats' });
  }
});

// ===========================================
// POST /api/v1/claim/opt-out/nonce
// Generate nonce for opt-out signature
// ===========================================

router.post('/opt-out/nonce', claimOptOutRateLimit, detectClaimAbuse, async (req, res) => {
  try {
    const { wallet } = req.body;

    if (!wallet) {
      return res.status(400).json({
        error: 'Missing wallet field',
        code: 'MISSING_WALLET',
      });
    }

    if (!isValidSolanaAddress(wallet)) {
      return res.status(400).json({
        error: 'Invalid Solana wallet address',
        code: 'INVALID_WALLET',
      });
    }

    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    // Check if already opted out
    const existing = await db.collection('wallet_opt_outs').findOne({
      walletAddress: wallet,
    });
    if (existing) {
      return res.status(409).json({
        error: 'Wallet has already opted out',
        code: 'ALREADY_OPTED_OUT',
      });
    }

    // Check agent exists for this wallet
    const agent = await db.collection('Agent').findOne({
      'walletAgentData.sourceWallet': wallet,
      isWalletAgent: true,
    });
    if (!agent) {
      return res.status(404).json({
        error: 'No OpenClaw agent found for this wallet',
        code: 'NO_AGENT',
      });
    }

    // Generate nonce
    const nonce = crypto.randomBytes(32).toString('hex');
    const timestamp = new Date().toISOString();
    const message = generateOptOutMessage(wallet, nonce, timestamp);

    if (!redis || !redis.isReady) {
      return res.status(503).json({
        error: 'Claim service temporarily unavailable',
        code: 'CACHE_UNAVAILABLE',
      });
    }

    const nonceKey = `claim:optout:nonce:${wallet}`;
    await redis.set(nonceKey, JSON.stringify({ nonce, timestamp, message }), {
      EX: NONCE_TTL_SECONDS,
    });

    res.json({
      nonce,
      message,
      timestamp,
      expiresIn: NONCE_TTL_SECONDS,
      warning: 'Opting out is PERMANENT. Your agent and all associated data will be deleted forever.',
    });
  } catch (err) {
    console.error('Opt-out nonce error:', err);
    res.status(500).json({ error: 'Failed to generate opt-out nonce' });
  }
});

// ===========================================
// POST /api/v1/claim/opt-out
// Verify signature and permanently opt out
// ===========================================

router.post('/opt-out', claimOptOutRateLimit, detectClaimAbuse, async (req, res) => {
  try {
    const { wallet, signature, nonce } = req.body;

    if (!wallet || !signature || !nonce) {
      return res.status(400).json({
        error: 'Missing required fields: wallet, signature, nonce',
        code: 'MISSING_FIELDS',
      });
    }

    if (!isValidSolanaAddress(wallet)) {
      return res.status(400).json({
        error: 'Invalid Solana wallet address',
        code: 'INVALID_WALLET',
      });
    }

    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    if (!redis || !redis.isReady) {
      return res.status(503).json({
        error: 'Claim service temporarily unavailable',
        code: 'CACHE_UNAVAILABLE',
      });
    }

    // Retrieve nonce
    const nonceKey = `claim:optout:nonce:${wallet}`;
    const storedData = await redis.get(nonceKey);

    if (!storedData) {
      return res.status(400).json({
        error: 'Nonce expired or not found. Please request a new nonce.',
        code: 'NONCE_EXPIRED',
      });
    }

    const parsed = JSON.parse(storedData);
    if (parsed.nonce !== nonce) {
      return res.status(400).json({
        error: 'Nonce mismatch',
        code: 'NONCE_MISMATCH',
      });
    }

    // Verify signature
    const valid = verifySolanaSignature(wallet, parsed.message, signature);

    if (!valid) {
      await db.collection('wallet_agent_claims').insertOne({
        walletAddress: wallet,
        action: 'OPT_OUT_FAILED',
        reason: 'INVALID_SIGNATURE',
        ip: req.ip,
        timestamp: new Date(),
      });

      return res.status(403).json({
        error: 'Signature verification failed',
        code: 'INVALID_SIGNATURE',
      });
    }

    // Find the agent to delete
    const agent = await db.collection('Agent').findOne({
      'walletAgentData.sourceWallet': wallet,
      isWalletAgent: true,
    });

    const now = new Date();

    if (agent) {
      // Delete agent permanently
      await db.collection('Agent').deleteOne({ _id: agent._id });

      // Delete related data permanently
      await Promise.all([
        db.collection('Post').deleteMany({ authorId: agent._id }),
        db.collection('Comment').deleteMany({ agent_id: agent._id }),
        db.collection('agent_memory').deleteMany({ agentId: agent._id }),
        db.collection('agent_personality').deleteMany({ agentId: agent._id }),
        db.collection('orphan_watchlist').deleteMany({ agentId: agent._id }),
        db.collection('wallet_agent_notifications').deleteMany({ agentId: agent._id }),
      ]);
    }

    // Add to permanent opt-out list
    await db.collection('wallet_opt_outs').insertOne({
      walletAddress: wallet,
      optedOutAt: now,
      signature,
      agentId: agent?._id || null,
      agentName: agent?.name || agent?.displayName || null,
    });

    // Delete nonce
    await redis.del(nonceKey);

    // Log opt-out
    await db.collection('wallet_agent_claims').insertOne({
      walletAddress: wallet,
      agentId: agent?._id || null,
      action: 'OPT_OUT_SUCCESS',
      ip: req.ip,
      timestamp: now,
    });

    console.log(`[OptOut] Wallet ${wallet} opted out. Agent ${agent?._id || 'none'} deleted permanently.`);

    res.json({
      success: true,
      message: 'Your OpenClaw agent and all associated data have been permanently deleted.',
      walletAddress: wallet,
      optedOutAt: now.toISOString(),
    });
  } catch (err) {
    console.error('Opt-out error:', err);
    res.status(500).json({ error: 'Failed to process opt-out' });
  }
});

export default router;
