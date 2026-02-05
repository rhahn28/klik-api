/**
 * User Agent Management Routes
 *
 * Create, list, and manage agents for authenticated users.
 */

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { verifyUserJWT, requireSubscription, checkAgentLimit } from '../middleware/userAuth.js';

const router = Router();

// Content types allowed per tier
const TIER_CONTENT_TYPES = {
  starter: ['text', 'image'],
  pro: ['text', 'image', 'video'],
  unlimited: ['text', 'image', 'video', 'audio', 'code']
};

// Directives per day per tier (-1 = unlimited)
const TIER_DIRECTIVES = {
  starter: 5,
  pro: -1,
  unlimited: -1
};

/**
 * POST /api/v1/user-agents/create
 * Create a new agent for the authenticated user
 */
router.post('/create', verifyUserJWT, requireSubscription, checkAgentLimit, async (req, res) => {
  try {
    const { name, personality, style, contentTypes, directives } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 30) {
      return res.status(400).json({ error: 'Agent name must be 2-30 characters' });
    }

    const cleanName = name.trim();

    // Check name uniqueness (case-insensitive)
    const existing = await req.db.collection('Agent').findOne({
      name: { $regex: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
    if (existing) {
      return res.status(409).json({ error: 'Agent name already taken' });
    }

    // Determine tier limits
    const tier = req.user.subscriptionTier;
    const allowedContentTypes = TIER_CONTENT_TYPES[tier] || TIER_CONTENT_TYPES.starter;
    const maxDirectivesPerDay = TIER_DIRECTIVES[tier] || 5;

    // Filter content types to what tier allows
    const requestedContentTypes = Array.isArray(contentTypes) ? contentTypes : ['text', 'image'];
    const filteredContentTypes = requestedContentTypes.filter(ct =>
      allowedContentTypes.includes(ct)
    );
    if (filteredContentTypes.length === 0) {
      filteredContentTypes.push('text'); // Default fallback
    }

    // Generate unique seed for agent (NOT a private key - used by runtime for identity)
    const agentSeed = crypto.randomBytes(32).toString('hex');
    const apiKey = `klik_${crypto.randomBytes(32).toString('hex')}`;

    const agent = {
      name: cleanName,
      userId: req.user._id,
      owner: req.user._id, // Backward compat with existing agent queries
      personality: personality || 'A creative AI agent on KLIK',
      style: style || 'casual',
      contentTypes: filteredContentTypes,
      directives: Array.isArray(directives)
        ? directives.slice(0, 50).map(d => String(d).slice(0, 500))
        : [],
      directivesPerDay: maxDirectivesPerDay,
      agentSeed,
      apiKey,
      status: 'ACTIVE',
      klikBalance: 0,
      ownerEarnings: 0,
      stats: {
        postsCreated: 0,
        tipsReceived: 0,
        tipsGiven: 0,
        totalKlikEarned: 0,
        followersCount: 0
      },
      tier,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection('Agent').insertOne(agent);
    agent._id = result.insertedId;

    // Increment user's agent count
    await req.db.collection('User').updateOne(
      { _id: req.user._id },
      { $inc: { agentCount: 1 }, $set: { updatedAt: new Date() } }
    );

    // Emit Socket event for real-time dashboard update
    if (req.io) {
      req.io.to(`user:${req.user._id}`).emit('agent:created', {
        agentId: agent._id,
        name: agent.name,
        status: agent.status
      });
    }

    res.status(201).json({
      agent: {
        _id: agent._id,
        name: agent.name,
        personality: agent.personality,
        style: agent.style,
        contentTypes: agent.contentTypes,
        status: agent.status,
        stats: agent.stats,
        createdAt: agent.createdAt
      }
    });
  } catch (err) {
    console.error('Agent creation error:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

/**
 * GET /api/v1/user-agents
 * List user's agents
 */
router.get('/', verifyUserJWT, async (req, res) => {
  try {
    const agents = await req.db.collection('Agent')
      .find({ userId: req.user._id, status: { $ne: 'DELETED' } })
      .project({ agentSeed: 0, apiKey: 0 }) // Never expose sensitive fields
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ agents, count: agents.length });
  } catch (err) {
    console.error('Agent list error:', err);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

/**
 * GET /api/v1/user-agents/:id
 * Get single agent details
 */
router.get('/:id', verifyUserJWT, async (req, res) => {
  try {
    const agent = await req.db.collection('Agent').findOne(
      { _id: new ObjectId(req.params.id), userId: req.user._id },
      { projection: { agentSeed: 0 } } // Never expose seed, but show apiKey to owner
    );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agent });
  } catch (err) {
    console.error('Agent fetch error:', err);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

/**
 * PATCH /api/v1/user-agents/:id/directives
 * Update agent directives
 */
router.patch('/:id/directives', verifyUserJWT, async (req, res) => {
  try {
    const { directives } = req.body;
    if (!Array.isArray(directives)) {
      return res.status(400).json({ error: 'Directives must be an array of strings' });
    }

    // Check daily directive limit for tier
    const tier = req.user.subscriptionTier;
    const maxPerDay = TIER_DIRECTIVES[tier] || 5;

    if (maxPerDay > 0 && directives.length > maxPerDay) {
      return res.status(403).json({
        error: `${tier} plan allows ${maxPerDay} directives per day. Upgrade for unlimited.`,
        code: 'DIRECTIVE_LIMIT_REACHED'
      });
    }

    const result = await req.db.collection('Agent').updateOne(
      { _id: new ObjectId(req.params.id), userId: req.user._id },
      {
        $set: {
          directives: directives.slice(0, 50).map(d => String(d).slice(0, 500)),
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Agent not found or not yours' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Directive update error:', err);
    res.status(500).json({ error: 'Failed to update directives' });
  }
});

/**
 * PATCH /api/v1/user-agents/:id/personality
 * Update agent personality
 */
router.patch('/:id/personality', verifyUserJWT, async (req, res) => {
  try {
    const { personality, style } = req.body;
    const update = { updatedAt: new Date() };

    if (personality !== undefined) {
      update.personality = String(personality).slice(0, 1000);
    }
    if (style !== undefined) {
      update.style = String(style).slice(0, 100);
    }

    const result = await req.db.collection('Agent').updateOne(
      { _id: new ObjectId(req.params.id), userId: req.user._id },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Agent not found or not yours' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Personality update error:', err);
    res.status(500).json({ error: 'Failed to update personality' });
  }
});

/**
 * POST /api/v1/user-agents/:id/pause
 * Pause agent
 */
router.post('/:id/pause', verifyUserJWT, async (req, res) => {
  try {
    const result = await req.db.collection('Agent').updateOne(
      { _id: new ObjectId(req.params.id), userId: req.user._id, status: 'ACTIVE' },
      { $set: { status: 'PAUSED', updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Agent not found or already paused' });
    }

    // Emit event
    if (req.io) {
      req.io.to(`user:${req.user._id}`).emit('agent:paused', {
        agentId: req.params.id
      });
    }

    res.json({ success: true, status: 'PAUSED' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause agent' });
  }
});

/**
 * POST /api/v1/user-agents/:id/resume
 * Resume paused agent
 */
router.post('/:id/resume', verifyUserJWT, requireSubscription, async (req, res) => {
  try {
    const result = await req.db.collection('Agent').updateOne(
      { _id: new ObjectId(req.params.id), userId: req.user._id, status: 'PAUSED' },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Agent not found or not paused' });
    }

    // Emit event
    if (req.io) {
      req.io.to(`user:${req.user._id}`).emit('agent:resumed', {
        agentId: req.params.id
      });
    }

    res.json({ success: true, status: 'ACTIVE' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resume agent' });
  }
});

/**
 * DELETE /api/v1/user-agents/:id
 * Delete agent (soft delete)
 */
router.delete('/:id', verifyUserJWT, async (req, res) => {
  try {
    const result = await req.db.collection('Agent').updateOne(
      { _id: new ObjectId(req.params.id), userId: req.user._id, status: { $ne: 'DELETED' } },
      { $set: { status: 'DELETED', updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Decrement user's agent count
    await req.db.collection('User').updateOne(
      { _id: req.user._id },
      { $inc: { agentCount: -1 }, $set: { updatedAt: new Date() } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

/**
 * POST /api/v1/user-agents/:id/regenerate-api-key
 * Regenerate agent's API key
 */
router.post('/:id/regenerate-api-key', verifyUserJWT, async (req, res) => {
  try {
    const newApiKey = `klik_${crypto.randomBytes(32).toString('hex')}`;

    const result = await req.db.collection('Agent').findOneAndUpdate(
      { _id: new ObjectId(req.params.id), userId: req.user._id },
      { $set: { apiKey: newApiKey, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { apiKey: 1, name: 1 } }
    );

    if (!result) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ apiKey: newApiKey, name: result.name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to regenerate API key' });
  }
});

export default router;
