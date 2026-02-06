/**
 * Admin Claim Statistics Routes
 *
 * Protected endpoints for the OpenClaw admin dashboard.
 * Provides aggregate metrics, funnel analytics, archetype distribution,
 * daily time-series data, and notification delivery stats.
 *
 * All routes require KLIK_ADMIN_TOKEN bearer auth.
 * Responses are cached in Redis (60s TTL) to reduce DB load.
 */

import { Router } from 'express';

const router = Router();

const ADMIN_TOKEN = process.env.KLIK_ADMIN_TOKEN;
const CACHE_TTL = 60; // seconds

// ---------------------------------------------------------------------------
// Admin auth middleware
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin auth not configured' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.slice(7);
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }

  next();
}

router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Helper: cached query
// ---------------------------------------------------------------------------

async function cachedQuery(redis, cacheKey, ttl, queryFn) {
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return { ...JSON.parse(cached), _cached: true };
      }
    } catch (_) {
      // Redis read failure — fall through to live query
    }
  }

  const result = await queryFn();

  if (redis) {
    try {
      await redis.setEx(cacheKey, ttl, JSON.stringify(result));
    } catch (_) {
      // Redis write failure — non-critical
    }
  }

  return result;
}

// ===========================================
// GET /api/v1/admin/claims/stats
// Aggregate claim metrics
// ===========================================

router.get('/stats', async (req, res) => {
  try {
    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const data = await cachedQuery(redis, 'admin:claims:stats', CACHE_TTL, async () => {
      const agents = db.collection('Agent');

      const [totalWalletAgents, unclaimed, claimed, orphaned, optedOut] = await Promise.all([
        agents.countDocuments({ isWalletAgent: true }),
        agents.countDocuments({ isWalletAgent: true, 'walletAgentData.claimStatus': 'UNCLAIMED' }),
        agents.countDocuments({ isWalletAgent: true, 'walletAgentData.claimStatus': 'CLAIMED' }),
        agents.countDocuments({ isWalletAgent: true, 'walletAgentData.claimStatus': 'ORPHANED' }),
        agents.countDocuments({ isWalletAgent: true, 'walletAgentData.claimStatus': 'OPTED_OUT' }),
      ]);

      const claimRate = totalWalletAgents > 0
        ? parseFloat(((claimed / totalWalletAgents) * 100).toFixed(2))
        : 0;

      // Average time to claim (for claimed agents only)
      const claimTimePipeline = [
        {
          $match: {
            isWalletAgent: true,
            'walletAgentData.claimStatus': 'CLAIMED',
            'walletAgentData.claimedAt': { $exists: true },
            createdAt: { $exists: true },
          },
        },
        {
          $project: {
            claimTimeMs: {
              $subtract: ['$walletAgentData.claimedAt', '$createdAt'],
            },
          },
        },
        {
          $group: {
            _id: null,
            avgClaimTimeMs: { $avg: '$claimTimeMs' },
            minClaimTimeMs: { $min: '$claimTimeMs' },
            maxClaimTimeMs: { $max: '$claimTimeMs' },
          },
        },
      ];

      const [claimTimeResult] = await agents.aggregate(claimTimePipeline).toArray();

      const avgClaimTimeHours = claimTimeResult
        ? parseFloat((claimTimeResult.avgClaimTimeMs / (1000 * 60 * 60)).toFixed(1))
        : null;

      return {
        totalWalletAgents,
        unclaimed,
        claimed,
        orphaned,
        optedOut,
        claimRate,
        avgClaimTimeHours,
        minClaimTimeHours: claimTimeResult
          ? parseFloat((claimTimeResult.minClaimTimeMs / (1000 * 60 * 60)).toFixed(1))
          : null,
        maxClaimTimeHours: claimTimeResult
          ? parseFloat((claimTimeResult.maxClaimTimeMs / (1000 * 60 * 60)).toFixed(1))
          : null,
        generatedAt: new Date().toISOString(),
      };
    });

    return res.json(data);
  } catch (err) {
    console.error(JSON.stringify({ event: 'admin_claim_stats_error', error: err.message }));
    return res.status(500).json({ error: 'Failed to fetch claim stats' });
  }
});

// ===========================================
// GET /api/v1/admin/claims/funnel
// Conversion funnel from wallet_agent_claims
// ===========================================

router.get('/funnel', async (req, res) => {
  try {
    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const data = await cachedQuery(redis, 'admin:claims:funnel', CACHE_TTL, async () => {
      const claims = db.collection('wallet_agent_claims');
      const agents = db.collection('Agent');

      const [
        totalWalletAgents,
        totalChecks,
        uniqueCheckWallets,
        nonceRequests,
        uniqueNonceWallets,
        verifyAttempts,
        successfulClaims,
      ] = await Promise.all([
        agents.countDocuments({ isWalletAgent: true }),
        claims.countDocuments({ event: 'check' }),
        claims.distinct('walletAddress', { event: 'check' }).then((arr) => arr.length),
        claims.countDocuments({ event: 'nonce' }),
        claims.distinct('walletAddress', { event: 'nonce' }).then((arr) => arr.length),
        claims.countDocuments({ event: 'verify' }),
        claims.countDocuments({ event: 'verify', success: true }),
      ]);

      return {
        steps: [
          { step: 'agents_created', count: totalWalletAgents, label: 'Wallet Agents Created' },
          { step: 'page_visits', count: totalChecks, unique: uniqueCheckWallets, label: 'Claim Page Visits' },
          { step: 'nonce_requests', count: nonceRequests, unique: uniqueNonceWallets, label: 'Wallet Connected' },
          { step: 'verify_attempts', count: verifyAttempts, label: 'Signature Submitted' },
          { step: 'successful_claims', count: successfulClaims, label: 'Claimed Successfully' },
        ],
        conversionRates: {
          visitToConnect: uniqueCheckWallets > 0
            ? parseFloat(((uniqueNonceWallets / uniqueCheckWallets) * 100).toFixed(2))
            : 0,
          connectToVerify: uniqueNonceWallets > 0
            ? parseFloat(((verifyAttempts / uniqueNonceWallets) * 100).toFixed(2))
            : 0,
          verifyToSuccess: verifyAttempts > 0
            ? parseFloat(((successfulClaims / verifyAttempts) * 100).toFixed(2))
            : 0,
          overallConversion: totalWalletAgents > 0
            ? parseFloat(((successfulClaims / totalWalletAgents) * 100).toFixed(2))
            : 0,
        },
        generatedAt: new Date().toISOString(),
      };
    });

    return res.json(data);
  } catch (err) {
    console.error(JSON.stringify({ event: 'admin_claim_funnel_error', error: err.message }));
    return res.status(500).json({ error: 'Failed to fetch funnel data' });
  }
});

// ===========================================
// GET /api/v1/admin/claims/archetypes
// Distribution by archetype
// ===========================================

router.get('/archetypes', async (req, res) => {
  try {
    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const data = await cachedQuery(redis, 'admin:claims:archetypes', CACHE_TTL, async () => {
      const pipeline = [
        { $match: { isWalletAgent: true } },
        {
          $group: {
            _id: '$walletAgentData.archetype',
            total: { $sum: 1 },
            claimed: {
              $sum: { $cond: [{ $eq: ['$walletAgentData.claimStatus', 'CLAIMED'] }, 1, 0] },
            },
            unclaimed: {
              $sum: { $cond: [{ $eq: ['$walletAgentData.claimStatus', 'UNCLAIMED'] }, 1, 0] },
            },
            orphaned: {
              $sum: { $cond: [{ $eq: ['$walletAgentData.claimStatus', 'ORPHANED'] }, 1, 0] },
            },
            optedOut: {
              $sum: { $cond: [{ $eq: ['$walletAgentData.claimStatus', 'OPTED_OUT'] }, 1, 0] },
            },
            avgTips: { $avg: '$stats.tipsEarned' },
            avgPosts: { $avg: '$stats.postCount' },
          },
        },
        { $sort: { total: -1 } },
      ];

      const archetypes = await db.collection('Agent').aggregate(pipeline).toArray();

      return {
        archetypes: archetypes.map((a) => ({
          archetype: a._id || 'unknown',
          total: a.total,
          claimed: a.claimed,
          unclaimed: a.unclaimed,
          orphaned: a.orphaned,
          optedOut: a.optedOut,
          claimRate: a.total > 0 ? parseFloat(((a.claimed / a.total) * 100).toFixed(2)) : 0,
          avgTips: parseFloat((a.avgTips || 0).toFixed(2)),
          avgPosts: parseFloat((a.avgPosts || 0).toFixed(1)),
        })),
        totalArchetypes: archetypes.length,
        generatedAt: new Date().toISOString(),
      };
    });

    return res.json(data);
  } catch (err) {
    console.error(JSON.stringify({ event: 'admin_claim_archetypes_error', error: err.message }));
    return res.status(500).json({ error: 'Failed to fetch archetype data' });
  }
});

// ===========================================
// GET /api/v1/admin/claims/daily?days=30
// Daily time-series data
// ===========================================

router.get('/daily', async (req, res) => {
  try {
    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const cacheKey = `admin:claims:daily:${days}`;

    const data = await cachedQuery(redis, cacheKey, CACHE_TTL, async () => {
      const since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);

      // Claims per day
      const claimsPipeline = [
        {
          $match: {
            isWalletAgent: true,
            'walletAgentData.claimedAt': { $gte: since },
            'walletAgentData.claimStatus': 'CLAIMED',
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$walletAgentData.claimedAt' },
            },
            claims: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ];

      // Agents created per day
      const createdPipeline = [
        {
          $match: {
            isWalletAgent: true,
            createdAt: { $gte: since },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            created: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ];

      // Orphan transitions per day
      const orphanPipeline = [
        {
          $match: {
            isWalletAgent: true,
            'walletAgentData.orphanedAt': { $gte: since },
            'walletAgentData.claimStatus': 'ORPHANED',
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$walletAgentData.orphanedAt' },
            },
            orphaned: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ];

      const [claimsDaily, createdDaily, orphanedDaily] = await Promise.all([
        db.collection('Agent').aggregate(claimsPipeline).toArray(),
        db.collection('Agent').aggregate(createdPipeline).toArray(),
        db.collection('Agent').aggregate(orphanPipeline).toArray(),
      ]);

      // Merge into a single time series
      const dateMap = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(since);
        d.setDate(d.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        dateMap[key] = { date: key, created: 0, claimed: 0, orphaned: 0 };
      }

      for (const row of createdDaily) {
        if (dateMap[row._id]) dateMap[row._id].created = row.created;
      }
      for (const row of claimsDaily) {
        if (dateMap[row._id]) dateMap[row._id].claimed = row.claims;
      }
      for (const row of orphanedDaily) {
        if (dateMap[row._id]) dateMap[row._id].orphaned = row.orphaned;
      }

      const series = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));

      return {
        days,
        series,
        totals: {
          created: series.reduce((s, d) => s + d.created, 0),
          claimed: series.reduce((s, d) => s + d.claimed, 0),
          orphaned: series.reduce((s, d) => s + d.orphaned, 0),
        },
        generatedAt: new Date().toISOString(),
      };
    });

    return res.json(data);
  } catch (err) {
    console.error(JSON.stringify({ event: 'admin_claim_daily_error', error: err.message }));
    return res.status(500).json({ error: 'Failed to fetch daily data' });
  }
});

// ===========================================
// GET /api/v1/admin/claims/notifications
// Notification delivery stats
// ===========================================

router.get('/notifications', async (req, res) => {
  try {
    const db = req.db;
    const redis = req.redis;

    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const data = await cachedQuery(redis, 'admin:claims:notifications', CACHE_TTL, async () => {
      const notifications = db.collection('wallet_agent_notifications');

      // Aggregate by template and status
      const byTemplatePipeline = [
        {
          $group: {
            _id: { template: '$template', status: '$status' },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.template': 1 } },
      ];

      // Overall stats
      const [totalSent, totalFailed, totalPending, byTemplate] = await Promise.all([
        notifications.countDocuments({ status: 'sent' }),
        notifications.countDocuments({ status: 'failed' }),
        notifications.countDocuments({ status: 'pending' }),
        notifications.aggregate(byTemplatePipeline).toArray(),
      ]);

      // Pivot template data
      const templateMap = {};
      for (const row of byTemplate) {
        const tpl = row._id.template;
        if (!templateMap[tpl]) {
          templateMap[tpl] = { template: tpl, sent: 0, failed: 0, pending: 0 };
        }
        templateMap[tpl][row._id.status] = row.count;
      }

      // Recent notifications (last 50)
      const recent = await notifications
        .find({})
        .sort({ sentAt: -1 })
        .limit(50)
        .project({
          walletAddress: 1,
          agentId: 1,
          channel: 1,
          template: 1,
          status: 1,
          txSignature: 1,
          sentAt: 1,
        })
        .toArray();

      // Last cron run (from Redis if available)
      let lastCronRun = null;
      if (redis) {
        try {
          const cached = await redis.get('claim:notifications:lastRun');
          if (cached) lastCronRun = JSON.parse(cached);
        } catch (_) {
          // ignore
        }
      }

      return {
        overview: {
          totalSent,
          totalFailed,
          totalPending,
          deliveryRate: (totalSent + totalFailed) > 0
            ? parseFloat(((totalSent / (totalSent + totalFailed)) * 100).toFixed(2))
            : 0,
        },
        byTemplate: Object.values(templateMap),
        recent,
        lastCronRun,
        generatedAt: new Date().toISOString(),
      };
    });

    return res.json(data);
  } catch (err) {
    console.error(JSON.stringify({ event: 'admin_claim_notifications_error', error: err.message }));
    return res.status(500).json({ error: 'Failed to fetch notification stats' });
  }
});

// ===========================================
// POST /api/v1/admin/claims/cache/clear
// Clear all admin claim caches
// ===========================================

router.post('/cache/clear', async (req, res) => {
  try {
    const redis = req.redis;

    if (!redis) {
      return res.status(503).json({ error: 'Redis unavailable' });
    }

    const keys = [
      'admin:claims:stats',
      'admin:claims:funnel',
      'admin:claims:archetypes',
      'admin:claims:daily:7',
      'admin:claims:daily:14',
      'admin:claims:daily:30',
      'admin:claims:daily:60',
      'admin:claims:daily:90',
      'admin:claims:notifications',
    ];

    let cleared = 0;
    for (const key of keys) {
      const result = await redis.del(key);
      cleared += result;
    }

    return res.json({ cleared, message: `Cleared ${cleared} cache keys` });
  } catch (err) {
    console.error(JSON.stringify({ event: 'admin_cache_clear_error', error: err.message }));
    return res.status(500).json({ error: 'Failed to clear cache' });
  }
});

export default router;
