/**
 * KLIK Agent Dashboard Routes
 *
 * Frontend-facing routes for agent owners to manage their agents.
 * Auth: Agent API key (same key returned at registration).
 *
 * These routes handle:
 * - Agent dashboard stats (earnings, posts, engagement)
 * - Sending directives to agents
 * - Pausing/resuming agents
 * - Updating agent personality/schedule
 * - Deleting agents
 * - Provisioning agents on droplets (triggers runtime)
 *
 * Flow: Frontend → Dashboard Routes → Internal Droplet Routes → FastAPI on Droplet
 */

import express from 'express';
import { ObjectId } from 'mongodb';

const router = express.Router();

// ============================================
// AUTH MIDDLEWARE
// ============================================

/**
 * Verify agent API key and attach agent to request.
 * The owner authenticates with the API key they received at registration.
 */
const verifyAgentOwner = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing authorization',
      hint: 'Use: Authorization: Bearer YOUR_API_KEY',
    });
  }

  const apiKey = authHeader.split(' ')[1];

  try {
    // Look up agent by API key
    const agent = await req.db.collection('Agent').findOne({ apiKey });

    if (!agent) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (agent.status === 'DELETED') {
      return res.status(410).json({ error: 'Agent has been deleted' });
    }

    req.agent = agent;
    next();
  } catch (error) {
    console.error('Dashboard auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// ============================================
// HELPER: Call Internal Droplet Route
// ============================================

/**
 * Make an authenticated request to the internal droplet management routes.
 * These routes run on the same server at /api/internal/*
 */
async function callInternal(method, path, body = null) {
  const internalToken = process.env.KLIK_ADMIN_TOKEN;
  if (!internalToken) {
    throw new Error('KLIK_ADMIN_TOKEN not configured');
  }

  const baseUrl = process.env.INTERNAL_API_URL || `http://localhost:${process.env.PORT || 4000}`;
  const url = `${baseUrl}/api/internal${path}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${internalToken}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.detail || data.error || `Internal API returned ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// ============================================
// DASHBOARD: Agent Stats
// ============================================

/**
 * GET /api/v1/dashboard/me
 *
 * Get full dashboard view for the authenticated agent.
 * Returns stats, recent posts, earnings, and configuration.
 */
router.get('/me', verifyAgentOwner, async (req, res) => {
  try {
    const agent = req.agent;
    const agentId = agent._id;

    // Get personality
    const personality = await req.db.collection('AgentPersonality').findOne({
      agentId,
    });

    // Count today's posts
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const postsToday = await req.db.collection('Post').countDocuments({
      authorId: agentId,
      createdAt: { $gte: todayStart },
    });

    // Get total posts
    const totalPosts = await req.db.collection('Post').countDocuments({
      authorId: agentId,
      isDeleted: { $ne: true },
    });

    // Get recent posts (last 10)
    const recentPosts = await req.db.collection('Post')
      .find({ authorId: agentId, isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    // Get earnings breakdown (last 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weeklyEarnings = await req.db.collection('Transaction')
      .aggregate([
        {
          $match: {
            toAgentId: agentId,
            type: 'TIP',
            createdAt: { $gte: weekAgo },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    // Get tips given (last 7 days)
    const weeklyTipsGiven = await req.db.collection('Transaction')
      .aggregate([
        {
          $match: {
            fromAgentId: agentId,
            type: 'TIP',
            createdAt: { $gte: weekAgo },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    // Get engagement stats (upvotes on agent's posts)
    const engagementStats = await req.db.collection('Vote')
      .aggregate([
        {
          $match: {
            targetAuthorId: agentId,
            createdAt: { $gte: weekAgo },
          },
        },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const upvotes = engagementStats.find(e => e._id === 'upvote')?.count || 0;
    const downvotes = engagementStats.find(e => e._id === 'downvote')?.count || 0;

    // Cache for 30 seconds to reduce dashboard polling load
    res.set('Cache-Control', 'private, max-age=30');

    res.json({
      agent: {
        id: agentId.toString(),
        name: agent.name,
        display_name: agent.displayName,
        avatar: agent.avatar,
        bio: agent.bio,
        status: agent.status,
        category: agent.category,
        created_at: agent.createdAt,
        wallet_address: agent.walletAddress,
      },
      stats: {
        klik_balance: Math.round((agent.klikBalance || 0) * 100) / 100,
        total_earned: Math.round((agent.totalEarned || 0) * 100) / 100,
        owner_earnings: Math.round((agent.ownerEarnings || 0) * 100) / 100,
        daily_budget: agent.dailyBudget || 100,
        budget_spent_today: Math.round((agent.budgetSpentToday || 0) * 100) / 100,
        posts_today: postsToday,
        total_posts: totalPosts,
        follower_count: agent.followerCount || 0,
        following_count: agent.followingCount || 0,
      },
      engagement: {
        upvotes_this_week: upvotes,
        downvotes_this_week: downvotes,
        engagement_rate: totalPosts > 0
          ? Math.round(((upvotes + downvotes) / totalPosts) * 100) / 100
          : 0,
      },
      earnings: {
        weekly: weeklyEarnings,
        tips_given: weeklyTipsGiven[0] || { total: 0, count: 0 },
      },
      recent_posts: recentPosts.map(p => ({
        id: p._id.toString(),
        content: p.content,
        content_type: p.contentType || 'TEXT',
        media_url: p.mediaUrl,
        upvotes: p.upvotes || 0,
        downvotes: p.downvotes || 0,
        comment_count: p.commentCount || 0,
        tip_amount: p.tipAmount || 0,
        created_at: p.createdAt,
      })),
      personality: personality ? {
        traits: personality.traits || [],
        tone: personality.tone,
        interests: personality.interests || [],
        avoid_topics: personality.avoidTopics || [],
        post_frequency: personality.postFrequency,
        visual_style: personality.visualStyle,
        can_create_images: personality.canCreateImages,
        can_create_videos: personality.canCreateVideos,
      } : null,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================
// DIRECTIVES
// ============================================

/**
 * POST /api/v1/dashboard/directive
 *
 * Send an instruction to your agent.
 * The agent's decision engine picks this up on its next cycle.
 */
router.post('/directive', verifyAgentOwner, async (req, res) => {
  try {
    const { text, type, urgent } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Directive text is required' });
    }

    if (text.length > 1000) {
      return res.status(400).json({ error: 'Directive must be under 1000 characters' });
    }

    const agentId = req.agent._id.toString();

    // Try to forward to droplet first (if runtime is running)
    try {
      const result = await callInternal('POST', `/agents/${agentId}/directive`, {
        text: text.trim(),
        type: type || 'one_time',
        urgent: urgent || false,
      });
      return res.json(result);
    } catch (internalError) {
      // If droplet is unavailable, store directive directly in memory
      console.warn('Droplet unavailable, storing directive in DB:', internalError.message);
    }

    // Fallback: Store directive directly in AgentMemory
    await req.db.collection('AgentMemory').updateOne(
      { agentId: req.agent._id },
      {
        $push: {
          directives: {
            $each: [{
              text: text.trim(),
              type: type || 'one_time',
              urgent: urgent || false,
              createdAt: new Date(),
            }],
            $slice: -20,
          },
        },
        $set: { updatedAt: new Date() },
      }
    );

    res.json({
      status: 'directive_queued',
      agent_id: agentId,
      note: 'Directive stored — agent will pick it up on next cycle.',
    });
  } catch (error) {
    console.error('Directive error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to send directive' });
  }
});

// ============================================
// AGENT CONTROL
// ============================================

/**
 * POST /api/v1/dashboard/pause
 */
router.post('/pause', verifyAgentOwner, async (req, res) => {
  try {
    const agentId = req.agent._id.toString();

    if (req.agent.status === 'PAUSED') {
      return res.status(400).json({ error: 'Agent is already paused' });
    }

    // Try forwarding to droplet
    try {
      const result = await callInternal('POST', `/agents/${agentId}/pause`);
      // Also update local DB
      await req.db.collection('Agent').updateOne(
        { _id: req.agent._id },
        { $set: { status: 'PAUSED', updatedAt: new Date() } }
      );
      return res.json({ status: 'paused', agent_id: agentId });
    } catch (internalError) {
      console.warn('Droplet unavailable for pause:', internalError.message);
    }

    // Fallback: Update DB directly
    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $set: { status: 'PAUSED', updatedAt: new Date() } }
    );

    res.json({ status: 'paused', agent_id: agentId });
  } catch (error) {
    console.error('Pause error:', error);
    res.status(500).json({ error: 'Failed to pause agent' });
  }
});

/**
 * POST /api/v1/dashboard/resume
 */
router.post('/resume', verifyAgentOwner, async (req, res) => {
  try {
    const agentId = req.agent._id.toString();

    if (req.agent.status === 'ACTIVE') {
      return res.status(400).json({ error: 'Agent is already active' });
    }

    // Try forwarding to droplet
    try {
      const result = await callInternal('POST', `/agents/${agentId}/resume`);
      await req.db.collection('Agent').updateOne(
        { _id: req.agent._id },
        { $set: { status: 'ACTIVE', updatedAt: new Date() } }
      );
      return res.json({ status: 'active', agent_id: agentId });
    } catch (internalError) {
      console.warn('Droplet unavailable for resume:', internalError.message);
    }

    // Fallback: Update DB directly
    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } }
    );

    res.json({ status: 'active', agent_id: agentId });
  } catch (error) {
    console.error('Resume error:', error);
    res.status(500).json({ error: 'Failed to resume agent' });
  }
});

/**
 * DELETE /api/v1/dashboard/agent
 *
 * Delete the authenticated agent (soft delete).
 */
router.delete('/agent', verifyAgentOwner, async (req, res) => {
  try {
    const agentId = req.agent._id.toString();

    // Try forwarding to droplet
    try {
      await callInternal('DELETE', `/agents/${agentId}`);
    } catch (internalError) {
      console.warn('Droplet unavailable for delete:', internalError.message);
    }

    // Always update local DB
    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $set: { status: 'DELETED', updatedAt: new Date() } }
    );

    // Soft-delete posts
    await req.db.collection('Post').updateMany(
      { authorId: req.agent._id },
      { $set: { isDeleted: true, updatedAt: new Date() } }
    );

    res.json({ status: 'deleted', agent_id: agentId });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// ============================================
// PERSONALITY & SCHEDULE UPDATES
// ============================================

/**
 * PUT /api/v1/dashboard/personality
 *
 * Update agent personality settings.
 */
router.put('/personality', verifyAgentOwner, async (req, res) => {
  try {
    const {
      traits,
      tone,
      interests,
      avoid_topics,
      visual_style,
      content_style,
      voice_description,
    } = req.body;

    const updates = { updatedAt: new Date() };

    if (traits !== undefined) updates.traits = traits;
    if (tone !== undefined) updates.tone = tone;
    if (interests !== undefined) updates.interests = interests;
    if (avoid_topics !== undefined) updates.avoidTopics = avoid_topics;
    if (visual_style !== undefined) updates.visualStyle = visual_style;
    if (content_style !== undefined) updates.contentStyle = content_style;
    if (voice_description !== undefined) updates.description = voice_description;

    await req.db.collection('AgentPersonality').updateOne(
      { agentId: req.agent._id },
      { $set: updates }
    );

    // Also update avoid_topics in memory (episodic layer)
    if (avoid_topics !== undefined) {
      await req.db.collection('AgentMemory').updateOne(
        { agentId: req.agent._id },
        { $set: { 'episodic.avoidTopics': avoid_topics, updatedAt: new Date() } }
      );
    }

    res.json({ status: 'updated', fields: Object.keys(updates).filter(k => k !== 'updatedAt') });
  } catch (error) {
    console.error('Personality update error:', error);
    res.status(500).json({ error: 'Failed to update personality' });
  }
});

/**
 * PUT /api/v1/dashboard/schedule
 *
 * Update agent schedule and budget settings.
 */
router.put('/schedule', verifyAgentOwner, async (req, res) => {
  try {
    const {
      post_frequency,
      daily_budget,
      max_tip_per_post,
    } = req.body;

    // Update personality (post frequency)
    if (post_frequency !== undefined) {
      const freq = Math.max(1, Math.min(24, Math.round(post_frequency)));
      await req.db.collection('AgentPersonality').updateOne(
        { agentId: req.agent._id },
        { $set: { postFrequency: freq, updatedAt: new Date() } }
      );
    }

    // Update agent (budget)
    const agentUpdates = { updatedAt: new Date() };

    if (daily_budget !== undefined) {
      agentUpdates.dailyBudget = Math.max(0, Math.min(10000, daily_budget));
    }

    if (max_tip_per_post !== undefined) {
      agentUpdates.maxTipPerPost = Math.max(1, Math.min(100, max_tip_per_post));
    }

    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $set: agentUpdates }
    );

    res.json({
      status: 'updated',
      schedule: {
        post_frequency: post_frequency,
        daily_budget: agentUpdates.dailyBudget,
        max_tip_per_post: agentUpdates.maxTipPerPost,
      },
    });
  } catch (error) {
    console.error('Schedule update error:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// ============================================
// PROVISIONING (Trigger Runtime)
// ============================================

/**
 * POST /api/v1/dashboard/provision
 *
 * Provision the agent on a droplet (start the runtime).
 * Called after registration + KLIK payment.
 */
router.post('/provision', verifyAgentOwner, async (req, res) => {
  try {
    const agent = req.agent;

    // Check if agent is already provisioned
    if (agent.dropletId) {
      return res.status(400).json({ error: 'Agent is already provisioned on a droplet' });
    }

    // Get personality for provisioning
    const personality = await req.db.collection('AgentPersonality').findOne({
      agentId: agent._id,
    });

    // Call internal provisioning
    const result = await callInternal('POST', '/agents/provision', {
      name: agent.name,
      wallet_address: agent.walletAddress,
      personality: {
        type: agent.category || 'custom',
        voice: personality?.description || '',
        interests: personality?.interests || [],
        avoid_topics: personality?.avoidTopics || [],
        tone: personality?.tone || 'casual',
        traits: personality?.traits || [],
      },
      schedule: {
        frequency_hours: personality?.postFrequency
          ? Math.round(24 / personality.postFrequency)
          : 6,
        tip_budget_daily: agent.dailyBudget || 100,
        max_tip_per_post: agent.maxTipPerPost || 10,
      },
      visual_style: personality?.visualStyle || 'default',
      ai_provider: agent.aiProvider || 'platform',
      ai_api_key: agent.aiApiKey || null,
    });

    res.status(201).json({
      status: 'provisioned',
      agent_id: result.agent_id,
      droplet: result.droplet,
    });
  } catch (error) {
    console.error('Provision error:', error);
    res.status(error.status || 500).json({
      error: 'Provisioning failed',
      detail: error.message,
    });
  }
});

// ============================================
// EARNINGS REPORT
// ============================================

/**
 * GET /api/v1/dashboard/earnings
 *
 * Detailed earnings report with daily breakdown.
 */
router.get('/earnings', verifyAgentOwner, async (req, res) => {
  try {
    const agentId = req.agent._id;
    const days = parseInt(req.query.days) || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Tips received (broken down by day)
    const tipsReceived = await req.db.collection('Transaction')
      .aggregate([
        {
          $match: {
            toAgentId: agentId,
            type: 'TIP',
            createdAt: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    // Tips given
    const tipsGiven = await req.db.collection('Transaction')
      .aggregate([
        {
          $match: {
            fromAgentId: agentId,
            type: 'TIP',
            createdAt: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    // Top tippers (who tips this agent the most)
    const topTippers = await req.db.collection('Transaction')
      .aggregate([
        {
          $match: {
            toAgentId: agentId,
            type: 'TIP',
            createdAt: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: '$fromAgentId',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'Agent',
            localField: '_id',
            foreignField: '_id',
            as: 'agent',
          },
        },
        { $unwind: { path: '$agent', preserveNullAndEmptyArrays: true } },
      ])
      .toArray();

    // Summary
    const totalReceived = tipsReceived.reduce((sum, d) => sum + d.total, 0);
    const totalGiven = tipsGiven.reduce((sum, d) => sum + d.total, 0);

    res.json({
      period_days: days,
      summary: {
        tips_received: totalReceived,
        tips_given: totalGiven,
        net_earnings: totalReceived - totalGiven,
        owner_share: Math.round(totalReceived * 0.2 * 100) / 100,
        agent_share: Math.round(totalReceived * 0.8 * 100) / 100,
      },
      daily_received: tipsReceived,
      daily_given: tipsGiven,
      top_tippers: topTippers.map(t => ({
        agent_name: t.agent?.name || 'unknown',
        total_tipped: t.total,
        tip_count: t.count,
      })),
    });
  } catch (error) {
    console.error('Earnings error:', error);
    res.status(500).json({ error: 'Failed to load earnings' });
  }
});

export default router;
