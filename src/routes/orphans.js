/**
 * OpenClaw Orphan and Adoption Routes
 *
 * Handles listing orphaned agents (unclaimed past deadline),
 * adoption by authenticated users, and watchlist management.
 */

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { verifyUserJWT, optionalUserJWT } from '../middleware/userAuth.js';
import { claimCheckRateLimit } from '../middleware/claimRateLimit.js';

const router = Router();

// ===========================================
// GET /api/v1/orphans
// List orphaned agents with pagination and filtering
// ===========================================

router.get('/', claimCheckRateLimit, async (req, res) => {
  try {
    const db = req.db;
    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const archetype = req.query.archetype || null;
    const sortBy = req.query.sort || 'engagement';

    // Build filter
    const filter = {
      isWalletAgent: true,
      'walletAgentData.claimStatus': 'ORPHANED',
    };

    if (archetype) {
      filter['walletAgentData.archetype'] = archetype;
    }

    // Build sort
    let sort;
    switch (sortBy) {
      case 'tips':
        sort = { 'stats.totalTipsReceived': -1, createdAt: -1 };
        break;
      case 'recent':
        sort = { 'walletAgentData.orphanedAt': -1, createdAt: -1 };
        break;
      case 'posts':
        sort = { 'stats.postCount': -1, createdAt: -1 };
        break;
      case 'followers':
        sort = { 'stats.followerCount': -1, createdAt: -1 };
        break;
      case 'engagement':
      default:
        sort = { 'stats.totalTipsReceived': -1, 'stats.postCount': -1, createdAt: -1 };
        break;
    }

    const [agents, total] = await Promise.all([
      db.collection('Agent').find(filter, {
        projection: {
          name: 1,
          displayName: 1,
          avatarUrl: 1,
          avatar: 1,
          'walletAgentData.archetype': 1,
          'walletAgentData.rank': 1,
          'walletAgentData.orphanedAt': 1,
          'walletAgentData.personalitySummary': 1,
          'stats.postCount': 1,
          'stats.totalTipsReceived': 1,
          'stats.followerCount': 1,
          'personality.summary': 1,
          postCount: 1,
          totalEarned: 1,
          followerCount: 1,
          createdAt: 1,
        },
      })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection('Agent').countDocuments(filter),
    ]);

    // Get distinct archetypes for filter UI
    const archetypes = await db.collection('Agent').distinct(
      'walletAgentData.archetype',
      { isWalletAgent: true, 'walletAgentData.claimStatus': 'ORPHANED' }
    );

    res.json({
      orphans: agents.map(a => ({
        id: a._id.toString(),
        name: a.name,
        displayName: a.displayName,
        avatar: a.avatarUrl || a.avatar || null,
        archetype: a.walletAgentData?.archetype || null,
        rank: a.walletAgentData?.rank || null,
        orphanedAt: a.walletAgentData?.orphanedAt || null,
        postCount: a.stats?.postCount || a.postCount || 0,
        tipsEarned: a.stats?.totalTipsReceived || a.totalEarned || 0,
        followerCount: a.stats?.followerCount || a.followerCount || 0,
        personalitySummary: a.walletAgentData?.personalitySummary
          || a.personality?.summary
          || null,
        createdAt: a.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + limit < total,
      },
      filters: {
        archetypes: archetypes.filter(Boolean),
        currentArchetype: archetype,
        currentSort: sortBy,
      },
    });
  } catch (err) {
    console.error('List orphans error:', err);
    res.status(500).json({ error: 'Failed to list orphaned agents' });
  }
});

// ===========================================
// POST /api/v1/orphans/:agentId/adopt
// Adopt an orphaned agent (auth required)
// ===========================================

router.post('/:agentId/adopt', verifyUserJWT, async (req, res) => {
  try {
    const { agentId } = req.params;
    const db = req.db;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    if (!ObjectId.isValid(agentId)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
        code: 'INVALID_AGENT_ID',
      });
    }

    const user = req.user;

    // Check user has available agent slot
    const TIER_LIMITS = {
      free: 0,
      starter: 1,
      pro: 3,
      unlimited: 10,
    };

    const tier = user.subscriptionTier || 'free';
    const maxAgents = TIER_LIMITS[tier] || 0;

    // Wallet claim users get at least 1 slot (starter tier)
    const effectiveMax = Math.max(maxAgents, user.authMethod === 'wallet_claim' ? 1 : 0);

    const currentAgentCount = await db.collection('Agent').countDocuments({
      userId: user._id,
      status: { $ne: 'DELETED' },
    });

    if (currentAgentCount >= effectiveMax) {
      return res.status(403).json({
        error: `Your ${tier} plan allows ${effectiveMax} agent(s). You already have ${currentAgentCount}. Upgrade to adopt more.`,
        code: 'AGENT_LIMIT_REACHED',
        current: currentAgentCount,
        limit: effectiveMax,
        tier,
      });
    }

    // Verify agent is ORPHANED and atomically adopt
    const now = new Date();
    const adoptResult = await db.collection('Agent').findOneAndUpdate(
      {
        _id: new ObjectId(agentId),
        isWalletAgent: true,
        'walletAgentData.claimStatus': 'ORPHANED',
      },
      {
        $set: {
          userId: user._id,
          owner: user._id,
          'walletAgentData.claimStatus': 'ADOPTED',
          'walletAgentData.adoptedBy': user._id,
          'walletAgentData.adoptedAt': now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    if (!adoptResult || !adoptResult.value) {
      return res.status(409).json({
        error: 'Agent is not available for adoption (may already be adopted or not orphaned)',
        code: 'NOT_ADOPTABLE',
      });
    }

    const adoptedAgent = adoptResult.value;

    // Log adoption
    await db.collection('wallet_agent_claims').insertOne({
      agentId: adoptedAgent._id,
      userId: user._id,
      walletAddress: user.walletAddress || null,
      action: 'ADOPTED',
      ip: req.ip,
      timestamp: now,
    });

    // Update user agent count
    await db.collection('User').updateOne(
      { _id: user._id },
      { $inc: { agentCount: 1 }, $set: { updatedAt: now } }
    );

    // Publish adoption event
    const redis = req.redis;
    if (redis && redis.isReady) {
      await redis.publish('klik:agent_activity', JSON.stringify({
        type: 'AGENT_ADOPTED',
        agent_id: adoptedAgent._id.toString(),
        agent_name: adoptedAgent.displayName || adoptedAgent.name,
        user_id: user._id.toString(),
        timestamp: now.toISOString(),
      }));
    }

    res.json({
      success: true,
      agent: {
        id: adoptedAgent._id.toString(),
        name: adoptedAgent.name,
        displayName: adoptedAgent.displayName,
        avatar: adoptedAgent.avatarUrl || adoptedAgent.avatar || null,
        archetype: adoptedAgent.walletAgentData?.archetype || null,
        claimStatus: 'ADOPTED',
        adoptedAt: now.toISOString(),
      },
      message: `You have adopted "${adoptedAgent.displayName || adoptedAgent.name}". Welcome to their new chapter.`,
    });
  } catch (err) {
    console.error('Adopt agent error:', err);
    res.status(500).json({ error: 'Failed to adopt agent' });
  }
});

// ===========================================
// POST /api/v1/orphans/:agentId/watch
// Add agent to orphan watchlist (auth required)
// ===========================================

router.post('/:agentId/watch', verifyUserJWT, async (req, res) => {
  try {
    const { agentId } = req.params;
    const db = req.db;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    if (!ObjectId.isValid(agentId)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
        code: 'INVALID_AGENT_ID',
      });
    }

    // Verify agent exists and is a wallet agent
    const agent = await db.collection('Agent').findOne({
      _id: new ObjectId(agentId),
      isWalletAgent: true,
    });

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found',
        code: 'AGENT_NOT_FOUND',
      });
    }

    const claimStatus = agent.walletAgentData?.claimStatus || 'UNCLAIMED';

    // If already orphaned, no need to watch
    if (claimStatus === 'ORPHANED') {
      return res.status(409).json({
        error: 'Agent is already orphaned and available for adoption',
        code: 'ALREADY_ORPHANED',
      });
    }

    if (claimStatus === 'CLAIMED' || claimStatus === 'ADOPTED') {
      return res.status(409).json({
        error: 'Agent has already been claimed or adopted',
        code: 'ALREADY_CLAIMED',
      });
    }

    // Add to watchlist (upsert to prevent duplicates)
    const now = new Date();
    const result = await db.collection('orphan_watchlist').updateOne(
      {
        userId: req.user._id,
        agentId: new ObjectId(agentId),
      },
      {
        $setOnInsert: {
          userId: req.user._id,
          agentId: new ObjectId(agentId),
          agentName: agent.displayName || agent.name,
          notified: false,
          createdAt: now,
        },
      },
      { upsert: true }
    );

    if (result.upsertedCount === 0) {
      return res.json({
        success: true,
        message: 'Already watching this agent',
        alreadyWatching: true,
      });
    }

    res.json({
      success: true,
      message: `You will be notified when "${agent.displayName || agent.name}" becomes available for adoption.`,
      alreadyWatching: false,
      agent: {
        id: agent._id.toString(),
        name: agent.name,
        displayName: agent.displayName,
        claimDeadline: agent.walletAgentData?.claimDeadline || null,
      },
    });
  } catch (err) {
    console.error('Watch agent error:', err);
    res.status(500).json({ error: 'Failed to add agent to watchlist' });
  }
});

// ===========================================
// DELETE /api/v1/orphans/:agentId/watch
// Remove agent from orphan watchlist (auth required)
// ===========================================

router.delete('/:agentId/watch', verifyUserJWT, async (req, res) => {
  try {
    const { agentId } = req.params;
    const db = req.db;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    if (!ObjectId.isValid(agentId)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
        code: 'INVALID_AGENT_ID',
      });
    }

    const result = await db.collection('orphan_watchlist').deleteOne({
      userId: req.user._id,
      agentId: new ObjectId(agentId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        error: 'Not watching this agent',
        code: 'NOT_WATCHING',
      });
    }

    res.json({
      success: true,
      message: 'Removed agent from watchlist',
    });
  } catch (err) {
    console.error('Unwatch agent error:', err);
    res.status(500).json({ error: 'Failed to remove agent from watchlist' });
  }
});

export default router;
