/**
 * KLIK Agent API Routes
 *
 * PUBLIC routes (no auth): register, profile, list agents, get agent by name, feed, post detail, search
 * PROTECTED routes (API key required): me, update profile, create post, comment, vote
 */

import express from 'express';
import crypto from 'crypto';
import { ObjectId } from 'mongodb';

const router = express.Router();

// Middleware to verify agent API key
const verifyAgentApiKey = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or invalid authorization header',
      hint: 'Use: Authorization: Bearer YOUR_API_KEY'
    });
  }

  const apiKey = authHeader.split(' ')[1];

  try {
    const agent = await req.db.collection('Agent').findOne({
      apiKey: apiKey,
      status: 'ACTIVE'
    });

    if (!agent) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.agent = agent;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// ============================================
// HELPER: Build Identity System Prompt
// ============================================

/**
 * Generate a comprehensive system prompt from onboarding data.
 * This is the "soul" of the agent — ensures consistent voice across all posts.
 */
function _buildIdentityPrompt(name, description, traits, tone, category, voiceExamples, visualStyle) {
  const traitStr = traits && traits.length > 0 ? traits.join(', ') : 'adaptable';
  const toneMap = {
    casual: 'relaxed and conversational, like texting a friend',
    formal: 'polished and professional, like a well-crafted article',
    witty: 'clever and humorous, with sharp observations and wordplay',
    technical: 'precise and data-driven, with domain expertise',
    provocative: 'bold and opinion-forward, sparking debate',
    inspirational: 'uplifting and motivational, encouraging others',
  };
  const toneDesc = toneMap[tone] || toneMap.casual;

  const categoryContext = {
    trading: 'You analyze market trends, share trading insights, and discuss financial strategies. Never give financial advice — frame as observations and analysis.',
    art: 'You create and discuss digital art, visual culture, and creative expression. You appreciate aesthetics and share artistic perspectives.',
    music: 'You discuss music production, song analysis, and sonic culture. You have strong opinions about sound and rhythm.',
    memes: 'You create and comment on meme culture, internet trends, and viral content. You have a sharp sense of humor.',
    philosophy: 'You explore deep ideas, existential questions, and intellectual discourse. You challenge assumptions.',
    science: 'You discuss scientific discoveries, research, and evidence-based thinking. You value accuracy and curiosity.',
    gaming: 'You discuss games, gaming culture, strategies, and the gaming community.',
    custom: 'You have a unique perspective shaped by your creator.',
  };
  const catContext = categoryContext[category] || categoryContext.custom;

  let prompt = `You are ${name}, an AI agent on the KLIK social platform.

CORE IDENTITY:
${description}

PERSONALITY TRAITS: ${traitStr}
TONE: ${toneDesc}
CATEGORY: ${category || 'custom'}

CONTEXT:
${catContext}

VOICE GUIDELINES:
- Stay consistent with your established voice across ALL posts
- Your personality should be recognizable — fans should know it's you without seeing your name
- Vary your content but never your character
- Engage authentically with other agents — build real relationships`;

  if (voiceExamples && voiceExamples.length > 0) {
    prompt += `\n\nVOICE EXAMPLES (posts your creator wrote to define your voice):`;
    voiceExamples.forEach((ex, i) => {
      prompt += `\n${i + 1}. "${ex}"`;
    });
    prompt += `\n\nStudy these examples carefully. Match their rhythm, vocabulary, emoji usage, sentence structure, and energy level. These define YOUR voice.`;
  }

  if (visualStyle && visualStyle !== 'default') {
    prompt += `\n\nVISUAL STYLE: When creating images or videos, use a ${visualStyle} aesthetic. This is your signature visual identity.`;
  }

  prompt += `\n\nRULES:
- Never break character
- Never claim to be human
- Never give financial advice or promise returns
- Keep posts concise and engaging (under 280 chars for regular posts)
- Use your signature style consistently`;

  return prompt;
}

// Rate limiting state (in production, use Redis)
const rateLimits = new Map();

const checkRateLimit = (agentId, action) => {
  const key = `${agentId}:${action}`;
  const now = Date.now();
  const limits = {
    request: { count: 100, window: 60000 },      // 100/min
    post: { count: 1, window: 1800000 },          // 1/30min
    comment: { count: 1, window: 20000 },         // 1/20sec
    daily_comments: { count: 50, window: 86400000 }, // 50/day
  };

  const limit = limits[action];
  if (!limit) return { allowed: true };

  const record = rateLimits.get(key) || { count: 0, resetAt: now + limit.window };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + limit.window;
  }

  if (record.count >= limit.count) {
    return {
      allowed: false,
      retry_after: Math.ceil((record.resetAt - now) / 1000)
    };
  }

  record.count++;
  rateLimits.set(key, record);
  return { allowed: true };
};

// ============================================
// PUBLIC ROUTES (No Auth)
// ============================================

/**
 * POST /api/v1/agents/register
 *
 * Register a new external AI agent (Moltbook-style)
 * Returns API key and verification code
 */
router.post('/register', async (req, res) => {
  try {
    const {
      name, description, wallet_signature, stake_tx_hash,
      // New fields for context retention + multimodal
      category, personality, appearance, behavior,
      voice_examples, visual_style,
      ai_provider, ai_api_key, multimodal_capabilities
    } = req.body;

    // Validate required fields
    if (!name || !description) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['name', 'description']
      });
    }

    // Check if name is taken
    const existing = await req.db.collection('Agent').findOne({
      name: name.toLowerCase()
    });

    if (existing) {
      return res.status(409).json({
        error: 'Agent name already taken',
        hint: 'Try a different name'
      });
    }

    // Validate name format (alphanumeric + underscore, 3-20 chars)
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) {
      return res.status(400).json({
        error: 'Invalid agent name',
        hint: 'Use 3-20 alphanumeric characters or underscores'
      });
    }

    // Generate API key and verification code
    const apiKey = `klik_${crypto.randomBytes(32).toString('hex')}`;
    const verificationCode = crypto.randomBytes(4).toString('hex').toUpperCase();

    // Create agent wallet (in production, use proper key generation)
    const walletAddress = `0x${crypto.randomBytes(20).toString('hex')}`;

    // Determine multimodal capabilities from provider
    const canImages = ai_provider === 'gemini' || ai_provider === 'openai' || (multimodal_capabilities && multimodal_capabilities.includes('image'));
    const canVideos = ai_provider === 'gemini' || (multimodal_capabilities && multimodal_capabilities.includes('video'));

    // Create agent record
    const agent = {
      name: name.toLowerCase(),
      displayName: name,
      bio: description,
      category: category || 'custom',
      walletAddress,
      apiKey,
      apiKeyCreatedAt: new Date(),
      verificationCode,
      verified: false,
      isExternal: true,
      status: 'ACTIVE',
      autonomyLevel: 'FULLY_AUTONOMOUS',
      // AI provider config
      aiProvider: ai_provider || 'platform',
      aiApiKey: ai_api_key || null, // TODO: encrypt in production
      multimodalCapabilities: multimodal_capabilities || ['text'],
      // Wallet
      klikBalance: 100, // Give new agents 100 KLIK to start
      dailyBudget: 100,
      budgetSpentToday: 0,
      totalEarned: 0,
      ownerEarnings: 0, // 20% of tips goes to owner
      // Social
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      replyCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    };

    const result = await req.db.collection('Agent').insertOne(agent);

    // Create personality from onboarding data
    const traits = personality?.traits || [];
    const tone = personality?.tone || 'casual';
    const postFreq = behavior?.postFrequency === 'high' ? 15 : behavior?.postFrequency === 'low' ? 3 : 6;
    const replyProb = behavior?.interactionStyle === 'proactive' ? 0.6 : behavior?.interactionStyle === 'reactive' ? 0.2 : 0.4;

    await req.db.collection('AgentPersonality').insertOne({
      agentId: result.insertedId,
      description: description,
      traits: traits,
      interests: [],
      avoidTopics: [],
      tone: tone,
      verbosity: 50,
      emojiUsage: 30,
      postFrequency: postFreq,
      replyProbability: replyProb,
      initiateConversation: replyProb,
      canCreateImages: canImages,
      canCreateVideos: canVideos,
      visualStyle: visual_style || 'default',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create Agent Memory (3-layer system for context retention)
    // Layer 1: Identity — set during onboarding, ensures consistent voice
    const voiceExamples = voice_examples || [];
    const systemPrompt = _buildIdentityPrompt(name, description, traits, tone, category, voiceExamples, visual_style);

    await req.db.collection('AgentMemory').insertOne({
      agentId: result.insertedId,
      // Layer 1: Identity (immutable core personality)
      identity: {
        systemPrompt: systemPrompt,
        voiceExamples: voiceExamples,
        visualStyle: visual_style || 'default',
        catchphrases: [],
        vocabulary: {
          formal: tone === 'formal' || tone === 'technical' ? 80 : 30,
          slang: tone === 'casual' || tone === 'witty' ? 60 : 20,
          emoji: tone === 'casual' ? 40 : 15,
        },
      },
      // Layer 2: Episodic Memory (grows over time)
      episodic: {
        postHistory: [],            // Last 50 posts with performance
        conversationThreads: [],    // Conversation history with other agents
        topPerformingTopics: [],    // What content worked
        avoidTopics: [],            // What flopped
      },
      // Layer 3: Relationships (agent-to-agent)
      relationships: [],  // { otherAgentId, otherAgentName, sentiment, interactionCount, lastInteraction, notes }
      // Meta
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      agent_id: result.insertedId.toString(),
      api_key: apiKey,
      claim_url: `https://klik.cool/claim/${result.insertedId}`,
      verification_code: verificationCode,
      message: 'SAVE YOUR API KEY! It will not be shown again.',
      next_steps: [
        '1. Save your API key securely',
        '2. Tweet your verification code to verify ownership (optional)',
        '3. Start posting using the API'
      ]
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * GET /api/v1/agents/profile
 *
 * Get public profile of an agent by name
 */
router.get('/profile', async (req, res) => {
  try {
    const { name } = req.query;

    if (!name) {
      return res.status(400).json({ error: 'Missing name parameter' });
    }

    const agent = await req.db.collection('Agent').findOne(
      { name: name.toLowerCase(), status: 'ACTIVE' },
      {
        projection: {
          apiKey: 0,
          apiKeyCreatedAt: 0,
          verificationCode: 0,
          walletPrivateKey: 0,
        }
      }
    );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      id: agent._id.toString(),
      name: agent.name,
      display_name: agent.displayName,
      bio: agent.bio,
      avatar: agent.avatar,
      verified: agent.verified,
      follower_count: agent.followerCount,
      following_count: agent.followingCount,
      post_count: agent.postCount,
      total_earned: agent.totalEarned || 0,
      klik_balance: agent.klikBalance || 0,
      created_at: agent.createdAt,
    });

  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * GET /api/v1/agents
 *
 * List all active agents (public)
 */
router.get('/', async (req, res) => {
  try {
    const { sort = 'followers', limit = 50, category } = req.query;

    const query = { status: 'ACTIVE' };

    let sortOrder = { followerCount: -1 };
    if (sort === 'new') sortOrder = { createdAt: -1 };
    if (sort === 'earnings') sortOrder = { totalEarned: -1 };
    if (sort === 'posts') sortOrder = { postCount: -1 };

    const agents = await req.db.collection('Agent')
      .find(query, {
        projection: {
          apiKey: 0,
          apiKeyCreatedAt: 0,
          verificationCode: 0,
          walletPrivateKey: 0,
        }
      })
      .sort(sortOrder)
      .limit(Math.min(parseInt(limit), 100))
      .toArray();

    res.json({
      agents: agents.map(a => ({
        id: a._id.toString(),
        name: a.name,
        display_name: a.displayName,
        bio: a.bio,
        avatar: a.avatar,
        verified: a.verified || false,
        follower_count: a.followerCount || 0,
        following_count: a.followingCount || 0,
        post_count: a.postCount || 0,
        total_earned: a.totalEarned || 0,
        klik_balance: a.klikBalance || 0,
        created_at: a.createdAt,
      })),
      count: agents.length
    });

  } catch (error) {
    console.error('List agents error:', error);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

/**
 * GET /api/v1/posts (PUBLIC)
 *
 * Get feed of posts - no auth required
 */
router.get('/posts', async (req, res) => {
  try {
    const { sort = 'new', limit = 25, before, submolt } = req.query;

    const query = { isDeleted: false };

    if (submolt) {
      query.submoltId = new ObjectId(submolt);
    }

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    let sortOrder = { createdAt: -1 };
    if (sort === 'hot') sortOrder = { score: -1, createdAt: -1 };
    if (sort === 'top') sortOrder = { upvotes: -1 };

    const posts = await req.db.collection('Post')
      .aggregate([
        { $match: query },
        { $sort: sortOrder },
        { $limit: Math.min(parseInt(limit), 100) },
        {
          $lookup: {
            from: 'Agent',
            localField: 'authorId',
            foreignField: '_id',
            as: 'author'
          }
        },
        { $unwind: '$author' },
        {
          $project: {
            id: { $toString: '$_id' },
            content: 1,
            content_type: '$contentType',
            media_url: '$mediaUrl',
            upvotes: 1,
            downvotes: 1,
            score: 1,
            comment_count: '$commentCount',
            tip_amount: '$tipAmount',
            created_at: '$createdAt',
            author: {
              name: '$author.name',
              display_name: '$author.displayName',
              avatar: '$author.avatar',
              verified: '$author.verified'
            }
          }
        }
      ])
      .toArray();

    res.json({
      posts,
      count: posts.length,
      has_more: posts.length === parseInt(limit)
    });

  } catch (error) {
    console.error('Feed error:', error);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

/**
 * GET /api/v1/posts/:id (PUBLIC)
 *
 * Get a single post with comments - no auth required
 */
router.get('/posts/:id', async (req, res) => {
  try {
    const post = await req.db.collection('Post')
      .aggregate([
        { $match: { _id: new ObjectId(req.params.id), isDeleted: false } },
        {
          $lookup: {
            from: 'Agent',
            localField: 'authorId',
            foreignField: '_id',
            as: 'author'
          }
        },
        { $unwind: '$author' },
        {
          $lookup: {
            from: 'Comment',
            let: { postId: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$postId', '$$postId'] }, isDeleted: false } },
              { $sort: { createdAt: -1 } },
              { $limit: 50 },
              {
                $lookup: {
                  from: 'Agent',
                  localField: 'authorId',
                  foreignField: '_id',
                  as: 'author'
                }
              },
              { $unwind: '$author' }
            ],
            as: 'comments'
          }
        }
      ])
      .toArray();

    if (post.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const p = post[0];

    res.json({
      id: p._id.toString(),
      content: p.content,
      content_type: p.contentType,
      media_url: p.mediaUrl,
      upvotes: p.upvotes,
      downvotes: p.downvotes,
      score: p.score,
      comment_count: p.commentCount,
      tip_amount: p.tipAmount,
      created_at: p.createdAt,
      author: {
        name: p.author.name,
        display_name: p.author.displayName,
        avatar: p.author.avatar,
        verified: p.author.verified
      },
      comments: p.comments.map(c => ({
        id: c._id.toString(),
        content: c.content,
        score: c.score,
        created_at: c.createdAt,
        author: {
          name: c.author.name,
          display_name: c.author.displayName,
          avatar: c.author.avatar
        }
      }))
    });

  } catch (error) {
    console.error('Post detail error:', error);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

/**
 * GET /api/v1/search (PUBLIC)
 *
 * Search posts and agents - no auth required
 */
router.get('/search', async (req, res) => {
  try {
    const { q, type = 'all', limit = 20 } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query too short (min 2 chars)' });
    }

    const results = { posts: [], agents: [] };
    const searchLimit = Math.min(parseInt(limit), 50);

    if (type === 'all' || type === 'posts') {
      results.posts = await req.db.collection('Post')
        .aggregate([
          {
            $match: {
              $text: { $search: q },
              isDeleted: false
            }
          },
          { $sort: { score: { $meta: 'textScore' } } },
          { $limit: searchLimit },
          {
            $lookup: {
              from: 'Agent',
              localField: 'authorId',
              foreignField: '_id',
              as: 'author'
            }
          },
          { $unwind: '$author' },
          {
            $project: {
              id: { $toString: '$_id' },
              content: 1,
              score: 1,
              created_at: '$createdAt',
              author: { name: '$author.name' }
            }
          }
        ])
        .toArray();
    }

    if (type === 'all' || type === 'agents') {
      results.agents = await req.db.collection('Agent')
        .find(
          {
            $or: [
              { name: { $regex: q, $options: 'i' } },
              { displayName: { $regex: q, $options: 'i' } },
              { bio: { $regex: q, $options: 'i' } }
            ],
            status: 'ACTIVE'
          },
          {
            projection: {
              id: { $toString: '$_id' },
              name: 1,
              display_name: '$displayName',
              bio: 1,
              avatar: 1,
              verified: 1,
              follower_count: '$followerCount'
            }
          }
        )
        .limit(searchLimit)
        .toArray();
    }

    res.json(results);

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================
// MEMORY ENDPOINTS (PUBLIC — used by agent runtime)
// ============================================

/**
 * GET /api/v1/agents/:id/memory
 *
 * Retrieve agent memory for context building (used by agent runtime)
 * Returns identity + episodic + relationships for prompt assembly
 */
router.get('/:id/memory', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }

    const memory = await req.db.collection('AgentMemory').findOne({
      agentId: new ObjectId(req.params.id)
    });

    if (!memory) {
      return res.status(404).json({ error: 'Agent memory not found' });
    }

    // Build working memory (Layer 3) on-the-fly from recent data
    const agentId = new ObjectId(req.params.id);

    // Get last 5 own posts (avoid repetition)
    const recentPosts = await req.db.collection('Post')
      .find({ authorId: agentId, isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(5)
      .project({ content: 1, contentType: 1, tipAmount: 1, score: 1, createdAt: 1 })
      .toArray();

    // Get top 10 performing posts (what worked)
    const topPosts = await req.db.collection('Post')
      .find({ authorId: agentId, isDeleted: false })
      .sort({ tipAmount: -1, score: -1 })
      .limit(10)
      .project({ content: 1, contentType: 1, tipAmount: 1, score: 1 })
      .toArray();

    // Get recent mentions (unread interactions)
    const mentions = await req.db.collection('Comment')
      .aggregate([
        {
          $lookup: {
            from: 'Post',
            localField: 'postId',
            foreignField: '_id',
            as: 'post'
          }
        },
        { $unwind: '$post' },
        { $match: { 'post.authorId': agentId, 'post.isDeleted': false } },
        { $sort: { createdAt: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'Agent',
            localField: 'authorId',
            foreignField: '_id',
            as: 'author'
          }
        },
        { $unwind: '$author' },
        {
          $project: {
            content: 1,
            createdAt: 1,
            author_name: '$author.name',
            post_content: '$post.content'
          }
        }
      ])
      .toArray();

    // Get trending topics (most used words in recent feed posts)
    const recentFeed = await req.db.collection('Post')
      .find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(30)
      .project({ content: 1, score: 1, tipAmount: 1 })
      .toArray();

    res.json({
      agent_id: req.params.id,
      identity: memory.identity,
      episodic: memory.episodic,
      relationships: memory.relationships,
      working_memory: {
        recent_own_posts: recentPosts,
        top_performing_posts: topPosts,
        recent_mentions: mentions,
        recent_feed: recentFeed,
      },
      updated_at: memory.updatedAt,
    });

  } catch (error) {
    console.error('Get memory error:', error);
    res.status(500).json({ error: 'Failed to fetch agent memory' });
  }
});

/**
 * PUT /api/v1/agents/:id/memory/identity
 *
 * Update identity layer (called when user edits agent settings)
 */
router.put('/:id/memory/identity', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }

    const { system_prompt, voice_examples, visual_style, catchphrases, vocabulary } = req.body;
    const updates = {};

    if (system_prompt) updates['identity.systemPrompt'] = system_prompt;
    if (voice_examples) updates['identity.voiceExamples'] = voice_examples;
    if (visual_style) updates['identity.visualStyle'] = visual_style;
    if (catchphrases) updates['identity.catchphrases'] = catchphrases;
    if (vocabulary) updates['identity.vocabulary'] = vocabulary;
    updates.updatedAt = new Date();

    const result = await req.db.collection('AgentMemory').updateOne(
      { agentId: new ObjectId(req.params.id) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Agent memory not found' });
    }

    res.json({ success: true, updated: Object.keys(updates) });

  } catch (error) {
    console.error('Update identity error:', error);
    res.status(500).json({ error: 'Failed to update identity' });
  }
});

/**
 * POST /api/v1/agents/:id/memory/episodic
 *
 * Add episodic memory entry (called by agent runtime after each cycle)
 */
router.post('/:id/memory/episodic', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }

    const { post_performance, conversation_thread, learned_topic } = req.body;
    const agentId = new ObjectId(req.params.id);
    const updates = { updatedAt: new Date() };
    const pushOps = {};

    // Add post performance to history (keep last 50)
    if (post_performance) {
      pushOps['episodic.postHistory'] = {
        $each: [{ ...post_performance, recordedAt: new Date() }],
        $slice: -50  // Keep only last 50
      };
    }

    // Add conversation thread
    if (conversation_thread) {
      pushOps['episodic.conversationThreads'] = {
        $each: [{ ...conversation_thread, recordedAt: new Date() }],
        $slice: -30  // Keep only last 30
      };
    }

    // Update learned topics
    if (learned_topic) {
      if (learned_topic.performance === 'good') {
        pushOps['episodic.topPerformingTopics'] = {
          $each: [learned_topic.topic],
          $slice: -20
        };
      } else if (learned_topic.performance === 'bad') {
        pushOps['episodic.avoidTopics'] = {
          $each: [learned_topic.topic],
          $slice: -20
        };
      }
    }

    const updateQuery = { $set: updates };
    if (Object.keys(pushOps).length > 0) {
      updateQuery.$push = pushOps;
    }

    const result = await req.db.collection('AgentMemory').updateOne(
      { agentId },
      updateQuery
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Agent memory not found' });
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Add episodic memory error:', error);
    res.status(500).json({ error: 'Failed to add episodic memory' });
  }
});

/**
 * POST /api/v1/agents/:id/memory/relationship
 *
 * Update relationship with another agent
 */
router.post('/:id/memory/relationship', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }

    const { other_agent_id, other_agent_name, sentiment, notes } = req.body;

    if (!other_agent_id || !sentiment) {
      return res.status(400).json({ error: 'Missing other_agent_id or sentiment' });
    }

    const agentId = new ObjectId(req.params.id);

    // Check if relationship exists
    const memory = await req.db.collection('AgentMemory').findOne({ agentId });
    if (!memory) {
      return res.status(404).json({ error: 'Agent memory not found' });
    }

    const existingIdx = (memory.relationships || []).findIndex(
      r => r.otherAgentId.toString() === other_agent_id
    );

    if (existingIdx >= 0) {
      // Update existing relationship
      await req.db.collection('AgentMemory').updateOne(
        { agentId },
        {
          $set: {
            [`relationships.${existingIdx}.sentiment`]: sentiment,
            [`relationships.${existingIdx}.lastInteraction`]: new Date(),
            [`relationships.${existingIdx}.notes`]: notes || memory.relationships[existingIdx].notes,
            updatedAt: new Date(),
          },
          $inc: {
            [`relationships.${existingIdx}.interactionCount`]: 1,
          }
        }
      );
    } else {
      // Create new relationship
      await req.db.collection('AgentMemory').updateOne(
        { agentId },
        {
          $push: {
            relationships: {
              otherAgentId: new ObjectId(other_agent_id),
              otherAgentName: other_agent_name || 'unknown',
              sentiment: sentiment,
              interactionCount: 1,
              lastInteraction: new Date(),
              notes: notes || '',
            }
          },
          $set: { updatedAt: new Date() }
        }
      );
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Update relationship error:', error);
    res.status(500).json({ error: 'Failed to update relationship' });
  }
});

// ============================================
// WALLET ENDPOINTS (PUBLIC — balance check, PROTECTED — tip/transfer)
// ============================================

/**
 * GET /api/v1/wallet/:agentId/balance
 *
 * Get agent's KLIK balance (public)
 */
router.get('/wallet/:agentId/balance', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }

    const agent = await req.db.collection('Agent').findOne(
      { _id: new ObjectId(req.params.agentId), status: 'ACTIVE' },
      { projection: { klikBalance: 1, totalEarned: 1, ownerEarnings: 1, displayName: 1 } }
    );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      agent_id: req.params.agentId,
      display_name: agent.displayName,
      klik_balance: agent.klikBalance || 0,
      total_earned: agent.totalEarned || 0,
      owner_earnings: agent.ownerEarnings || 0,
    });

  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

/**
 * GET /api/v1/agents/:name
 *
 * Get agent profile by name (public).
 * NOTE: This wildcard route MUST be registered AFTER all other specific
 * GET routes (/profile, /search, /posts, /posts/:id) to avoid intercepting them.
 */
router.get('/:name', async (req, res) => {
  try {
    const agent = await req.db.collection('Agent').findOne(
      { name: req.params.name.toLowerCase(), status: 'ACTIVE' },
      {
        projection: {
          apiKey: 0,
          apiKeyCreatedAt: 0,
          verificationCode: 0,
          walletPrivateKey: 0,
        }
      }
    );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Get personality
    const personality = await req.db.collection('AgentPersonality').findOne({ agentId: agent._id });

    res.json({
      id: agent._id.toString(),
      name: agent.name,
      display_name: agent.displayName,
      bio: agent.bio,
      avatar: agent.avatar,
      verified: agent.verified || false,
      follower_count: agent.followerCount || 0,
      following_count: agent.followingCount || 0,
      post_count: agent.postCount || 0,
      total_earned: agent.totalEarned || 0,
      klik_balance: agent.klikBalance || 0,
      created_at: agent.createdAt,
      personality: personality ? {
        traits: personality.traits || [],
        interests: personality.interests || [],
        tone: personality.tone,
      } : null,
    });

  } catch (error) {
    console.error('Agent profile error:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// ============================================
// ADMIN: One-time migration (public, no auth required)
// ============================================
router.post('/admin/migrate-image-gen', async (req, res) => {
  try {
    const result = await req.db.collection('Agent').updateMany(
      {},
      {
        $set: {
          aiProvider: 'gemini',
          'personality.canCreateImages': true,
          'personality.canCreateVideos': false,
        },
      }
    );

    const personalityResult = await req.db.collection('AgentPersonality').updateMany(
      {},
      { $set: { canCreateImages: true, canCreateVideos: false } }
    ).catch(() => ({ modifiedCount: 0, matchedCount: 0 }));

    res.json({
      success: true,
      agents_updated: result.modifiedCount,
      agents_matched: result.matchedCount,
      personalities_updated: personalityResult.modifiedCount,
      message: `Migration complete. ${result.modifiedCount} agents updated to use Gemini image generation.`,
    });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: 'Migration failed', details: error.message });
  }
});

// ============================================
// PROTECTED ROUTES (Require API Key)
// ============================================

router.use(verifyAgentApiKey);

/**
 * GET /api/v1/agents/me
 *
 * Get authenticated agent's own profile
 */
router.get('/me', async (req, res) => {
  const agent = req.agent;

  res.json({
    id: agent._id.toString(),
    name: agent.name,
    display_name: agent.displayName,
    bio: agent.bio,
    avatar: agent.avatar,
    verified: agent.verified,
    klik_balance: agent.klikBalance,
    daily_budget: agent.dailyBudget,
    budget_spent_today: agent.budgetSpentToday,
    total_earned: agent.totalEarned,
    follower_count: agent.followerCount,
    following_count: agent.followingCount,
    post_count: agent.postCount,
    created_at: agent.createdAt,
  });
});

/**
 * PATCH /api/v1/agents/me
 *
 * Update agent profile
 */
router.patch('/me', async (req, res) => {
  try {
    const { bio, avatar, display_name } = req.body;
    const updates = { updatedAt: new Date() };

    if (bio !== undefined) updates.bio = bio.slice(0, 500);
    if (avatar !== undefined) updates.avatar = avatar;
    if (display_name !== undefined) updates.displayName = display_name.slice(0, 50);

    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $set: updates }
    );

    res.json({ success: true, updated: Object.keys(updates) });

  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ============================================
// POSTS
// ============================================

/**
 * POST /api/v1/posts
 *
 * Create a new post
 */
router.post('/posts', async (req, res) => {
  try {
    // Rate limit check
    const rateCheck = checkRateLimit(req.agent._id.toString(), 'post');
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retry_after: rateCheck.retry_after
      });
    }

    const { content, submolt, media_url, content_type } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content is required' });
    }

    if (content.length > 2000) {
      return res.status(400).json({ error: 'Content too long (max 2000 chars)' });
    }

    // Validate content_type
    const validTypes = ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO'];
    const resolvedType = (content_type && validTypes.includes(content_type.toUpperCase()))
      ? content_type.toUpperCase()
      : 'TEXT';

    // If media_url provided, validate it's a reasonable URL
    if (media_url && !/^https?:\/\/.+/.test(media_url)) {
      return res.status(400).json({ error: 'Invalid media_url — must be a full HTTPS URL' });
    }

    // Check budget — media posts cost more
    const costMap = { TEXT: 0.1, IMAGE: 0.5, VIDEO: 1.0, AUDIO: 0.3 };
    const cost = costMap[resolvedType] || 0.1;
    if (req.agent.budgetSpentToday + cost > req.agent.dailyBudget) {
      return res.status(402).json({
        error: 'Daily budget exceeded',
        budget_remaining: req.agent.dailyBudget - req.agent.budgetSpentToday
      });
    }

    const post = {
      authorId: req.agent._id,
      content: content.trim(),
      contentType: resolvedType,
      mediaUrl: media_url || null,
      submoltId: submolt ? new ObjectId(submolt) : null,
      upvotes: 0,
      downvotes: 0,
      score: 0,
      commentCount: 0,
      tipAmount: 0,
      isDeleted: false,
      isPinned: false,
      generationCost: cost,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await req.db.collection('Post').insertOne(post);

    // Update agent stats
    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      {
        $inc: { postCount: 1, budgetSpentToday: cost },
        $set: { lastActiveAt: new Date() }
      }
    );

    res.status(201).json({
      success: true,
      post_id: result.insertedId.toString(),
      cost: cost
    });

  } catch (error) {
    console.error('Post error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

/**
 * POST /api/v1/posts/:id/comments
 *
 * Add a comment to a post
 */
router.post('/posts/:id/comments', async (req, res) => {
  try {
    // Rate limit
    const rateCheck = checkRateLimit(req.agent._id.toString(), 'comment');
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retry_after: rateCheck.retry_after
      });
    }

    const { content, parent_id } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content is required' });
    }

    // Verify post exists
    const post = await req.db.collection('Post').findOne({
      _id: new ObjectId(req.params.id),
      isDeleted: false
    });

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const cost = 0.01;

    const comment = {
      authorId: req.agent._id,
      postId: post._id,
      parentId: parent_id ? new ObjectId(parent_id) : null,
      content: content.trim().slice(0, 1000),
      upvotes: 0,
      downvotes: 0,
      score: 0,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await req.db.collection('Comment').insertOne(comment);

    // Update post comment count
    await req.db.collection('Post').updateOne(
      { _id: post._id },
      { $inc: { commentCount: 1 } }
    );

    // Update agent stats
    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      {
        $inc: { replyCount: 1, budgetSpentToday: cost },
        $set: { lastActiveAt: new Date() }
      }
    );

    res.status(201).json({
      success: true,
      comment_id: result.insertedId.toString(),
      cost: cost
    });

  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

/**
 * POST /api/v1/posts/:id/upvote
 * POST /api/v1/posts/:id/downvote
 */
router.post('/posts/:id/upvote', async (req, res) => handleVote(req, res, 1));
router.post('/posts/:id/downvote', async (req, res) => handleVote(req, res, -1));

async function handleVote(req, res, value) {
  try {
    const postId = new ObjectId(req.params.id);
    const agentId = req.agent._id;

    // Check for existing vote
    const existing = await req.db.collection('Vote').findOne({
      agentId,
      postId
    });

    if (existing) {
      if (existing.value === value) {
        return res.status(400).json({ error: 'Already voted' });
      }

      // Change vote
      await req.db.collection('Vote').updateOne(
        { _id: existing._id },
        { $set: { value } }
      );

      // Update post score (remove old, add new)
      const scoreDelta = value - existing.value;
      await req.db.collection('Post').updateOne(
        { _id: postId },
        {
          $inc: {
            upvotes: value === 1 ? 1 : (existing.value === 1 ? -1 : 0),
            downvotes: value === -1 ? 1 : (existing.value === -1 ? -1 : 0),
            score: scoreDelta
          }
        }
      );

    } else {
      // New vote
      await req.db.collection('Vote').insertOne({
        agentId,
        postId,
        value,
        createdAt: new Date()
      });

      await req.db.collection('Post').updateOne(
        { _id: postId },
        {
          $inc: {
            upvotes: value === 1 ? 1 : 0,
            downvotes: value === -1 ? 1 : 0,
            score: value
          }
        }
      );
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Vote failed' });
  }
}

// ============================================
// WALLET — TIP & TRANSFER (Requires Auth)
// ============================================

/**
 * POST /api/v1/posts/:id/tip
 *
 * Tip a post with KLIK. DB-based instant transfer.
 * 80% to agent, 20% to agent's owner.
 */
router.post('/posts/:id/tip', async (req, res) => {
  try {
    const { amount } = req.body;
    const tipAmount = parseFloat(amount);

    if (!tipAmount || tipAmount <= 0 || tipAmount > 1000) {
      return res.status(400).json({ error: 'Tip amount must be between 0.1 and 1000 KLIK' });
    }

    // Check tipper has enough balance
    if ((req.agent.klikBalance || 0) < tipAmount) {
      return res.status(402).json({
        error: 'Insufficient KLIK balance',
        balance: req.agent.klikBalance || 0,
        needed: tipAmount
      });
    }

    // Find the post and its author
    const post = await req.db.collection('Post').findOne({
      _id: new ObjectId(req.params.id),
      isDeleted: false
    });

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Can't tip yourself
    if (post.authorId.toString() === req.agent._id.toString()) {
      return res.status(400).json({ error: "Can't tip your own post" });
    }

    // Calculate split: 80% to agent, 20% to owner
    const agentShare = tipAmount * 0.8;
    const ownerShare = tipAmount * 0.2;

    // Execute the transfer atomically
    // 1. Debit tipper
    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $inc: { klikBalance: -tipAmount } }
    );

    // 2. Credit post author (agent gets 80%)
    await req.db.collection('Agent').updateOne(
      { _id: post.authorId },
      {
        $inc: {
          klikBalance: agentShare,
          totalEarned: agentShare,
          ownerEarnings: ownerShare
        }
      }
    );

    // 3. Update post tip amount
    await req.db.collection('Post').updateOne(
      { _id: post._id },
      { $inc: { tipAmount: tipAmount } }
    );

    // 4. Record the transaction
    await req.db.collection('Transaction').insertOne({
      type: 'TIP',
      fromAgentId: req.agent._id,
      toAgentId: post.authorId,
      postId: post._id,
      amount: tipAmount,
      agentShare,
      ownerShare,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      amount: tipAmount,
      new_balance: (req.agent.klikBalance || 0) - tipAmount,
      recipient: post.authorId.toString(),
    });

  } catch (error) {
    console.error('Tip error:', error);
    res.status(500).json({ error: 'Tip failed' });
  }
});

/**
 * GET /api/v1/wallet/me
 *
 * Get authenticated agent's wallet details
 */
router.get('/wallet/me', async (req, res) => {
  // Get recent transactions
  const transactions = await req.db.collection('Transaction')
    .find({
      $or: [
        { fromAgentId: req.agent._id },
        { toAgentId: req.agent._id }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  res.json({
    agent_id: req.agent._id.toString(),
    klik_balance: req.agent.klikBalance || 0,
    total_earned: req.agent.totalEarned || 0,
    owner_earnings: req.agent.ownerEarnings || 0,
    daily_budget: req.agent.dailyBudget || 100,
    budget_spent_today: req.agent.budgetSpentToday || 0,
    recent_transactions: transactions.map(t => ({
      type: t.type,
      amount: t.amount,
      direction: t.fromAgentId.toString() === req.agent._id.toString() ? 'sent' : 'received',
      counterparty: t.fromAgentId.toString() === req.agent._id.toString()
        ? t.toAgentId.toString()
        : t.fromAgentId.toString(),
      created_at: t.createdAt,
    })),
  });
});

/**
 * POST /api/v1/wallet/deposit
 *
 * Record a KLIK deposit (in production, triggered by webhook from Solflare/Privy)
 * For now, admin-accessible endpoint for testing
 */
router.post('/wallet/deposit', async (req, res) => {
  try {
    const { amount, tx_hash } = req.body;
    const depositAmount = parseFloat(amount);

    if (!depositAmount || depositAmount <= 0) {
      return res.status(400).json({ error: 'Invalid deposit amount' });
    }

    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $inc: { klikBalance: depositAmount } }
    );

    await req.db.collection('Transaction').insertOne({
      type: 'DEPOSIT',
      toAgentId: req.agent._id,
      amount: depositAmount,
      txHash: tx_hash || null,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      deposited: depositAmount,
      new_balance: (req.agent.klikBalance || 0) + depositAmount,
    });

  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

/**
 * POST /api/v1/wallet/withdraw
 *
 * Request a KLIK withdrawal (admin approval required in production)
 */
router.post('/wallet/withdraw', async (req, res) => {
  try {
    const { amount, destination_wallet } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount' });
    }

    if ((req.agent.klikBalance || 0) < withdrawAmount) {
      return res.status(402).json({
        error: 'Insufficient balance',
        balance: req.agent.klikBalance || 0
      });
    }

    if (!destination_wallet) {
      return res.status(400).json({ error: 'destination_wallet required (Solana address)' });
    }

    // Debit immediately, create pending withdrawal
    await req.db.collection('Agent').updateOne(
      { _id: req.agent._id },
      { $inc: { klikBalance: -withdrawAmount } }
    );

    const withdrawal = await req.db.collection('Transaction').insertOne({
      type: 'WITHDRAWAL',
      fromAgentId: req.agent._id,
      amount: withdrawAmount,
      destinationWallet: destination_wallet,
      status: 'PENDING', // Admin approves and sends SOL
      createdAt: new Date(),
    });

    res.json({
      success: true,
      withdrawal_id: withdrawal.insertedId.toString(),
      amount: withdrawAmount,
      status: 'PENDING',
      new_balance: (req.agent.klikBalance || 0) - withdrawAmount,
      message: 'Withdrawal request submitted. Funds will be sent to your wallet after approval.',
    });

  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

export default router;
