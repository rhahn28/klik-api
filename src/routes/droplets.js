/**
 * KLIK Droplet Management Routes (INTERNAL)
 *
 * These routes proxy commands from the KLIK API to agent droplets
 * over the Tailscale mesh. They handle:
 * - Provisioning new agents on droplets
 * - Sending directives to agents
 * - Getting agent status from droplets
 * - Pausing/resuming agents
 * - Deleting agents
 * - Droplet health monitoring
 * - Auto-scaling (create new droplets when full)
 *
 * All routes require the internal admin token (KLIK_ADMIN_TOKEN).
 * In production, the frontend calls these routes, and they proxy
 * to the droplet FastAPI servers over Tailscale.
 *
 * For local dev (no Tailscale), these call localhost:18789 directly.
 */

import express from 'express';
import { ObjectId } from 'mongodb';
import { seedAgentStyles } from '../utils/seed-agent-styles.js';

const router = express.Router();

// Internal admin token verification
const verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const adminToken = process.env.KLIK_ADMIN_TOKEN;

  if (!adminToken) {
    return res.status(500).json({ error: 'KLIK_ADMIN_TOKEN not configured' });
  }

  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return res.status(401).json({ error: 'Unauthorized — admin token required' });
  }

  next();
};

// Helper: Get the droplet URL for an agent
async function getDropletUrl(db, agentId) {
  // First check if we have a droplet mapping
  const agent = await db.collection('Agent').findOne({ _id: new ObjectId(agentId) });
  if (!agent) return null;

  if (agent.dropletId) {
    const droplet = await db.collection('agent_droplets').findOne({ _id: agent.dropletId });
    if (droplet && droplet.status === 'active') {
      return `http://${droplet.tailscale_ip}:8443`;
    }
  }

  // Local dev fallback: call the local FastAPI server directly
  return process.env.LOCAL_RUNTIME_URL || 'http://localhost:18789';
}

// Helper: Get the internal token for droplet communication
function getInternalToken() {
  return process.env.KLIK_INTERNAL_API_TOKEN || process.env.KLIK_ADMIN_TOKEN || '';
}

// Helper: Make an authenticated request to a droplet
async function dropletRequest(url, method, body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${getInternalToken()}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.detail || data.error || `Droplet returned ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// Helper: Find a droplet with capacity (bin-packing: fill fullest first)
async function findDropletWithCapacity(db) {
  const droplet = await db.collection('agent_droplets')
    .find({
      status: 'active',
      $expr: { $lt: ['$current_agents', '$max_agents'] }
    })
    .sort({ current_agents: -1 }) // Fill fullest first (bin-pack)
    .limit(1)
    .toArray();

  return droplet.length > 0 ? droplet[0] : null;
}

// ============================================
// PROVISIONING
// ============================================

/**
 * POST /api/internal/agents/provision
 *
 * Provision a new agent. Flow:
 * 1. Find a droplet with capacity
 * 2. Call the droplet's /api/agents/provision endpoint
 * 3. Register the agent-to-droplet mapping
 * 4. Return the new agent info
 */
router.post('/agents/provision', verifyAdminToken, async (req, res) => {
  try {
    const {
      name,
      wallet_address,
      personality,
      schedule,
      content_style,
      visual_style,
      ai_provider,
      ai_api_key,
    } = req.body;

    if (!name || !wallet_address) {
      return res.status(400).json({ error: 'name and wallet_address are required' });
    }

    // Check if agent name is taken
    const existing = await req.db.collection('Agent').findOne({
      name: name.toLowerCase()
    });
    if (existing) {
      return res.status(409).json({ error: `Agent '${name}' already exists` });
    }

    // Find a droplet with capacity
    let droplet = await findDropletWithCapacity(req.db);

    if (!droplet) {
      // Try auto-scaling if Hetzner token is available
      const hetznerToken = process.env.HETZNER_API_TOKEN;
      if (hetznerToken) {
        console.log('No droplets with capacity — triggering auto-scale...');
        try {
          await createHetznerDroplet(hetznerToken);
          // Note: New droplet takes 2-3 min to come online.
          // For now, fall back to local runtime while it provisions.
          console.log('Auto-scale triggered. Using local runtime for this agent.');
        } catch (scaleErr) {
          console.error('Auto-scale failed:', scaleErr.message);
        }
      } else {
        console.warn('No droplets with capacity found — using local runtime');
      }
    }

    // Build provisioning request
    const provisionBody = {
      agent_id: `klik-user-${wallet_address.slice(0, 8)}`,
      name: name,
      wallet_address: wallet_address,
      personality: personality || {
        type: 'default',
        voice: '',
        interests: [],
        avoid_topics: [],
        tone: 'casual',
        traits: [],
      },
      schedule: schedule || {
        frequency_hours: 6,
        tip_budget_daily: 100,
        max_tip_per_post: 10,
      },
      content_style: content_style || '',
      visual_style: visual_style || 'default',
      ai_provider: ai_provider || 'platform',
      ai_api_key: ai_api_key || null,
    };

    // Call the droplet's provisioning endpoint
    const dropletUrl = droplet
      ? `http://${droplet.tailscale_ip}:8443`
      : (process.env.LOCAL_RUNTIME_URL || 'http://localhost:18789');

    const result = await dropletRequest(
      `${dropletUrl}/api/agents/provision`,
      'POST',
      provisionBody
    );

    // Update droplet agent count
    if (droplet) {
      await req.db.collection('agent_droplets').updateOne(
        { _id: droplet._id },
        { $inc: { current_agents: 1 }, $set: { last_health_check: new Date() } }
      );

      // Store droplet reference on agent
      await req.db.collection('Agent').updateOne(
        { _id: new ObjectId(result.agent_id) },
        { $set: { dropletId: droplet._id } }
      );
    }

    res.status(201).json({
      success: true,
      agent_id: result.agent_id,
      name: result.name,
      status: result.status,
      droplet: droplet ? droplet.hostname : 'local',
    });

  } catch (error) {
    console.error('Provisioning error:', error);
    const status = error.status || 500;
    res.status(status).json({
      error: 'Provisioning failed',
      detail: error.message,
    });
  }
});

// ============================================
// AGENT MANAGEMENT
// ============================================

/**
 * POST /api/internal/agents/:id/directive
 */
router.post('/agents/:id/directive', verifyAdminToken, async (req, res) => {
  try {
    const dropletUrl = await getDropletUrl(req.db, req.params.id);
    if (!dropletUrl) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const result = await dropletRequest(
      `${dropletUrl}/api/agents/${req.params.id}/directive`,
      'POST',
      req.body
    );

    res.json(result);
  } catch (error) {
    console.error('Directive error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * GET /api/internal/agents/:id/status
 */
router.get('/agents/:id/status', verifyAdminToken, async (req, res) => {
  try {
    const dropletUrl = await getDropletUrl(req.db, req.params.id);
    if (!dropletUrl) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const result = await dropletRequest(
      `${dropletUrl}/api/agents/${req.params.id}/status`,
      'GET'
    );

    res.json(result);
  } catch (error) {
    console.error('Status error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * POST /api/internal/agents/:id/pause
 */
router.post('/agents/:id/pause', verifyAdminToken, async (req, res) => {
  try {
    const dropletUrl = await getDropletUrl(req.db, req.params.id);
    if (!dropletUrl) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const result = await dropletRequest(
      `${dropletUrl}/api/agents/${req.params.id}/pause`,
      'POST'
    );

    res.json(result);
  } catch (error) {
    console.error('Pause error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * POST /api/internal/agents/:id/resume
 */
router.post('/agents/:id/resume', verifyAdminToken, async (req, res) => {
  try {
    const dropletUrl = await getDropletUrl(req.db, req.params.id);
    if (!dropletUrl) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const result = await dropletRequest(
      `${dropletUrl}/api/agents/${req.params.id}/resume`,
      'POST'
    );

    res.json(result);
  } catch (error) {
    console.error('Resume error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * DELETE /api/internal/agents/:id
 */
router.delete('/agents/:id', verifyAdminToken, async (req, res) => {
  try {
    const dropletUrl = await getDropletUrl(req.db, req.params.id);
    if (!dropletUrl) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const result = await dropletRequest(
      `${dropletUrl}/api/agents/${req.params.id}`,
      'DELETE'
    );

    // Decrement droplet agent count
    const agent = await req.db.collection('Agent').findOne({
      _id: new ObjectId(req.params.id)
    });
    if (agent && agent.dropletId) {
      await req.db.collection('agent_droplets').updateOne(
        { _id: agent.dropletId },
        { $inc: { current_agents: -1 } }
      );
    }

    res.json(result);
  } catch (error) {
    console.error('Delete error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ============================================
// DROPLET MANAGEMENT
// ============================================

/**
 * GET /api/internal/droplets
 *
 * List all droplets with their status
 */
router.get('/droplets', verifyAdminToken, async (req, res) => {
  try {
    const droplets = await req.db.collection('agent_droplets')
      .find({})
      .sort({ current_agents: -1 })
      .toArray();

    res.json({
      droplets: droplets.map(d => ({
        id: d._id.toString(),
        hostname: d.hostname,
        tailscale_ip: d.tailscale_ip,
        provider: d.provider,
        current_agents: d.current_agents,
        max_agents: d.max_agents,
        status: d.status,
        utilization: `${Math.round((d.current_agents / d.max_agents) * 100)}%`,
        last_health_check: d.last_health_check,
        created_at: d.created_at,
      })),
      count: droplets.length,
      total_agents: droplets.reduce((sum, d) => sum + d.current_agents, 0),
      total_capacity: droplets.reduce((sum, d) => sum + d.max_agents, 0),
    });
  } catch (error) {
    console.error('List droplets error:', error);
    res.status(500).json({ error: 'Failed to list droplets' });
  }
});

/**
 * POST /api/internal/droplets/register
 *
 * Register a new droplet (called by cloud-init on new droplets)
 */
router.post('/droplets/register', verifyAdminToken, async (req, res) => {
  try {
    const { hostname, tailscale_ip, provider, max_agents, ram_mb } = req.body;

    if (!hostname || !tailscale_ip) {
      return res.status(400).json({ error: 'hostname and tailscale_ip required' });
    }

    const result = await req.db.collection('agent_droplets').insertOne({
      provider: provider || 'hetzner',
      tailscale_ip,
      hostname,
      current_agents: 0,
      max_agents: max_agents || 80,
      ram_mb: ram_mb || 8192,
      status: 'active',
      created_at: new Date(),
      last_health_check: new Date(),
    });

    console.log(`New droplet registered: ${hostname} (${tailscale_ip})`);

    res.status(201).json({
      success: true,
      droplet_id: result.insertedId.toString(),
      hostname,
    });
  } catch (error) {
    console.error('Register droplet error:', error);
    res.status(500).json({ error: 'Failed to register droplet' });
  }
});

/**
 * POST /api/internal/droplets/health-check
 *
 * Run health check on all active droplets
 */
router.post('/droplets/health-check', verifyAdminToken, async (req, res) => {
  try {
    const droplets = await req.db.collection('agent_droplets')
      .find({ status: 'active' })
      .toArray();

    const results = [];

    for (const droplet of droplets) {
      try {
        const health = await dropletRequest(
          `http://${droplet.tailscale_ip}:8443/health`,
          'GET'
        );

        await req.db.collection('agent_droplets').updateOne(
          { _id: droplet._id },
          { $set: { last_health_check: new Date() } }
        );

        results.push({
          hostname: droplet.hostname,
          status: 'healthy',
          agents_active: health.agents_active,
        });
      } catch (err) {
        results.push({
          hostname: droplet.hostname,
          status: 'unreachable',
          error: err.message,
        });
      }
    }

    res.json({
      checked: results.length,
      healthy: results.filter(r => r.status === 'healthy').length,
      unreachable: results.filter(r => r.status === 'unreachable').length,
      results,
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// ============================================
// AUTO-SCALING
// ============================================

/**
 * POST /api/internal/droplets/auto-scale
 *
 * Check if new droplets are needed.
 * Called periodically or before provisioning.
 *
 * Logic:
 * 1. Calculate total capacity vs total agents
 * 2. If utilization > 80%, create a new droplet
 * 3. Returns scaling decision + action taken
 */
router.post('/droplets/auto-scale', verifyAdminToken, async (req, res) => {
  try {
    const droplets = await req.db.collection('agent_droplets')
      .find({ status: 'active' })
      .toArray();

    const totalCapacity = droplets.reduce((sum, d) => sum + d.max_agents, 0);
    const totalAgents = droplets.reduce((sum, d) => sum + d.current_agents, 0);
    const utilization = totalCapacity > 0 ? totalAgents / totalCapacity : 1;

    const result = {
      total_droplets: droplets.length,
      total_agents: totalAgents,
      total_capacity: totalCapacity,
      utilization: `${Math.round(utilization * 100)}%`,
      needs_scale: utilization > 0.8 || totalCapacity === 0,
      action: 'none',
    };

    if (result.needs_scale) {
      // Check if Hetzner auto-provisioning is enabled
      const hetznerToken = process.env.HETZNER_API_TOKEN;

      if (hetznerToken) {
        // Create new droplet via Hetzner API
        try {
          const newDroplet = await createHetznerDroplet(hetznerToken);
          result.action = 'created_droplet';
          result.new_droplet = newDroplet;
        } catch (hetznerError) {
          console.error('Hetzner auto-scale error:', hetznerError);
          result.action = 'scale_failed';
          result.error = hetznerError.message;
        }
      } else {
        result.action = 'manual_scale_needed';
        result.message = 'HETZNER_API_TOKEN not set — create droplet manually using provision-droplet.sh';
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Auto-scale error:', error);
    res.status(500).json({ error: 'Auto-scale check failed' });
  }
});

/**
 * GET /api/internal/droplets/capacity
 *
 * Quick capacity check — returns available slots.
 */
router.get('/droplets/capacity', verifyAdminToken, async (req, res) => {
  try {
    const droplets = await req.db.collection('agent_droplets')
      .find({ status: 'active' })
      .toArray();

    const totalCapacity = droplets.reduce((sum, d) => sum + d.max_agents, 0);
    const totalAgents = droplets.reduce((sum, d) => sum + d.current_agents, 0);
    const availableSlots = totalCapacity - totalAgents;

    // Find the best droplet (fullest with capacity = bin-pack)
    const bestDroplet = droplets
      .filter(d => d.current_agents < d.max_agents)
      .sort((a, b) => b.current_agents - a.current_agents)[0];

    res.json({
      available_slots: availableSlots,
      total_capacity: totalCapacity,
      total_agents: totalAgents,
      utilization: totalCapacity > 0 ? `${Math.round((totalAgents / totalCapacity) * 100)}%` : '0%',
      best_droplet: bestDroplet ? {
        id: bestDroplet._id.toString(),
        hostname: bestDroplet.hostname,
        available: bestDroplet.max_agents - bestDroplet.current_agents,
      } : null,
      can_provision: availableSlots > 0,
    });
  } catch (error) {
    console.error('Capacity check error:', error);
    res.status(500).json({ error: 'Capacity check failed' });
  }
});

/**
 * Helper: Create a new Hetzner CX31 droplet via API.
 * Returns the server info after creation.
 */
async function createHetznerDroplet(apiToken) {
  const hostname = `klik-droplet-${Date.now().toString(36)}`;

  // Read cloud-init template
  // In production, this would be stored in the database or config service
  const cloudInitTemplate = `#!/bin/bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey=${process.env.TAILSCALE_AUTH_KEY || ''} --hostname=${hostname}
# Full cloud-init in config/cloud-init.yaml
`;

  const response = await fetch('https://api.hetzner.cloud/v1/servers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: hostname,
      server_type: process.env.HETZNER_SERVER_TYPE || 'cx31',
      image: 'ubuntu-22.04',
      location: process.env.HETZNER_LOCATION || 'nbg1',
      ssh_keys: process.env.HETZNER_SSH_KEY_IDS
        ? process.env.HETZNER_SSH_KEY_IDS.split(',').map(Number)
        : [],
      user_data: cloudInitTemplate,
      labels: {
        project: 'klik',
        role: 'agent-droplet',
        managed: 'auto-scale',
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Hetzner API error: ${error.error?.message || response.status}`);
  }

  const data = await response.json();
  console.log(`Auto-scaled: Created ${hostname} (ID: ${data.server.id})`);

  return {
    server_id: data.server.id,
    hostname,
    public_ip: data.server.public_net?.ipv4?.ip || 'pending',
    status: 'provisioning',
  };
}

// ============================================
// SEED AGENT STYLES
// ============================================

/**
 * GET /api/internal/seed-styles
 *
 * Run the agent styles migration to set visual_style and category on all agents.
 * Requires admin token.
 */
router.get('/seed-styles', verifyAdminToken, async (req, res) => {
  try {
    if (!req.db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    console.log('[seed-styles] Running agent styles migration...');
    const results = await seedAgentStyles(req.db);

    console.log(`[seed-styles] Migration complete: ${results.agentsUpdated} agents, ${results.personalitiesUpdated} personalities`);

    res.json({
      success: true,
      message: 'Agent styles migration completed',
      results,
    });
  } catch (error) {
    console.error('[seed-styles] Migration error:', error);
    res.status(500).json({
      error: 'Migration failed',
      message: error.message,
    });
  }
});

export default router;
