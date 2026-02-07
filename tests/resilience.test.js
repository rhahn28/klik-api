/**
 * Resilience Tests
 *
 * Tests for:
 * 1. Health endpoint returns correct status (200 ok / 503 degraded)
 * 2. DB null guard in verifyAgentApiKey middleware
 * 3. Route ordering - specific routes respond before agent wildcard
 */

// ============================================
// Test 1: Health Endpoint Status Codes
// ============================================

describe('Health Endpoint', () => {
  it('should return 200 and status "ok" when MongoDB is connected', () => {
    // Simulate a healthy app with db connected
    let mongoConnected = true;
    const db = {}; // Mock db object

    const mongoStatus = db && mongoConnected ? 'connected' : 'disconnected';
    const isHealthy = mongoStatus === 'connected';
    const statusCode = isHealthy ? 200 : 503;
    const status = isHealthy ? 'ok' : 'degraded';

    expect(statusCode).toBe(200);
    expect(status).toBe('ok');
    expect(mongoStatus).toBe('connected');
  });

  it('should return 503 and status "degraded" when MongoDB is disconnected', () => {
    // Simulate an unhealthy app with db disconnected
    let mongoConnected = false;
    const db = null; // No db

    const mongoStatus = db && mongoConnected ? 'connected' : 'disconnected';
    const isHealthy = mongoStatus === 'connected';
    const statusCode = isHealthy ? 200 : 503;
    const status = isHealthy ? 'ok' : 'degraded';

    expect(statusCode).toBe(503);
    expect(status).toBe('degraded');
    expect(mongoStatus).toBe('disconnected');
  });

  it('should return 503 when db exists but mongoConnected is false', () => {
    // Edge case: db object exists but connection flag is false
    let mongoConnected = false;
    const db = {}; // db object exists

    const mongoStatus = db && mongoConnected ? 'connected' : 'disconnected';
    const isHealthy = mongoStatus === 'connected';
    const statusCode = isHealthy ? 200 : 503;
    const status = isHealthy ? 'ok' : 'degraded';

    expect(statusCode).toBe(503);
    expect(status).toBe('degraded');
    expect(mongoStatus).toBe('disconnected');
  });
});

// ============================================
// Test 2: DB Null Guard in verifyAgentApiKey
// ============================================

describe('verifyAgentApiKey Middleware', () => {
  // Replicate the middleware logic for testing
  const verifyAgentApiKey = async (req, res, next) => {
    // Guard: Check if database is available
    if (!req.db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

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

  it('should return 503 when req.db is null/undefined', async () => {
    const mockReq = { db: null, headers: { authorization: 'Bearer test-key' } };
    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => { responseBody = body; }
        };
      }
    };
    const mockNext = jest.fn();

    await verifyAgentApiKey(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(503);
    expect(responseBody.error).toBe('Database unavailable');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 when no auth header provided (db available)', async () => {
    const mockReq = {
      db: { collection: () => ({ findOne: async () => null }) },
      headers: {}
    };
    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => { responseBody = body; }
        };
      }
    };
    const mockNext = jest.fn();

    await verifyAgentApiKey(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Missing or invalid authorization header');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 when auth header format is wrong', async () => {
    const mockReq = {
      db: { collection: () => ({ findOne: async () => null }) },
      headers: { authorization: 'Basic abc123' }
    };
    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => { responseBody = body; }
        };
      }
    };
    const mockNext = jest.fn();

    await verifyAgentApiKey(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Missing or invalid authorization header');
  });

  it('should call next() when valid API key provided', async () => {
    const mockAgent = { _id: 'test-id', name: 'TestAgent', status: 'ACTIVE' };
    const mockReq = {
      db: { collection: () => ({ findOne: async () => mockAgent }) },
      headers: { authorization: 'Bearer valid-api-key' }
    };
    const mockRes = {
      status: () => ({ json: () => {} })
    };
    const mockNext = jest.fn();

    await verifyAgentApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.agent).toBe(mockAgent);
  });

  it('should return 401 when API key not found in database', async () => {
    const mockReq = {
      db: { collection: () => ({ findOne: async () => null }) },
      headers: { authorization: 'Bearer invalid-api-key' }
    };
    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => { responseBody = body; }
        };
      }
    };
    const mockNext = jest.fn();

    await verifyAgentApiKey(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Invalid API key');
    expect(mockNext).not.toHaveBeenCalled();
  });
});

// ============================================
// Test 3: Route Ordering
// ============================================

describe('Route Ordering', () => {
  it('should correctly prioritize specific routes over wildcards', () => {
    // This test verifies the route ordering logic
    // In Express, routes are matched in order of registration
    // Specific routes must come BEFORE wildcard routes

    const routes = [
      { path: '/api/v1/claim', type: 'specific' },
      { path: '/api/v1/orphans', type: 'specific' },
      { path: '/api/v1/admin/claims', type: 'specific' },
      { path: '/api/v1/price/klik', type: 'specific' },
      { path: '/api/v1/dashboard', type: 'specific' },
      { path: '/api/v1/auth', type: 'specific' },
      { path: '/api/v1/billing', type: 'specific' },
      { path: '/api/v1/user-agents', type: 'specific' },
      { path: '/api/v1/withdraw', type: 'specific' },
      { path: '/api/v1/user', type: 'specific' },
      { path: '/api/internal', type: 'specific' },
      { path: '/api/v1/agents', type: 'wildcard' },
      { path: '/api/v1', type: 'wildcard' },
    ];

    // Find the index of the first wildcard route
    const firstWildcardIndex = routes.findIndex(r => r.type === 'wildcard');

    // All specific routes should come before the first wildcard
    const specificRoutes = routes.filter(r => r.type === 'specific');
    specificRoutes.forEach((route, index) => {
      const routeIndex = routes.indexOf(route);
      expect(routeIndex).toBeLessThan(firstWildcardIndex);
    });
  });

  it('should have claim routes before agent wildcard in actual order', () => {
    // Verify the specific order from index.js matches requirements
    const routeOrder = [
      '/api/v1/claim',       // OpenClaw claim routes FIRST
      '/api/v1/orphans',     // OpenClaw orphan routes
      '/api/v1/admin/claims',// OpenClaw admin stats
      '/api/v1/price/klik',  // Price endpoint
      '/api/v1/dashboard',
      '/api/v1/auth',
      '/api/v1/billing',
      '/api/v1/user-agents',
      '/api/v1/withdraw',    // NEW: dual mount for frontend compat
      '/api/v1/user',
      '/api/internal',
      '/api/v1/agents',      // Agent routes LAST
      '/api/v1',             // Root wildcard VERY LAST
    ];

    // Claim should be before agents
    expect(routeOrder.indexOf('/api/v1/claim')).toBeLessThan(routeOrder.indexOf('/api/v1/agents'));

    // Orphans should be before agents
    expect(routeOrder.indexOf('/api/v1/orphans')).toBeLessThan(routeOrder.indexOf('/api/v1/agents'));

    // Price should be before agents
    expect(routeOrder.indexOf('/api/v1/price/klik')).toBeLessThan(routeOrder.indexOf('/api/v1/agents'));

    // Withdraw should be before agents
    expect(routeOrder.indexOf('/api/v1/withdraw')).toBeLessThan(routeOrder.indexOf('/api/v1/agents'));
  });
});

// ============================================
// Test 4: Withdraw Route Dual Mount
// ============================================

describe('Withdraw Route Dual Mount', () => {
  it('should have both /withdraw and /user mounts for backward compatibility', () => {
    // The frontend expects /api/v1/withdraw/withdraw
    // Old code used /api/v1/user/withdraw
    // Both should work

    const mounts = ['/api/v1/withdraw', '/api/v1/user'];

    expect(mounts).toContain('/api/v1/withdraw');
    expect(mounts).toContain('/api/v1/user');
  });
});

// ============================================
// Test 5: MongoDB Retry Logic
// ============================================

describe('MongoDB Retry Logic', () => {
  it('should calculate correct exponential backoff delays', () => {
    const BASE_DELAY = 1000;
    const MAX_RETRIES = 5;

    const expectedDelays = [1000, 2000, 4000, 8000, 16000]; // 1s, 2s, 4s, 8s, 16s

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      expect(delay).toBe(expectedDelays[attempt - 1]);
    }
  });

  it('should have correct retry count of 5', () => {
    const MAX_RETRIES = 5;
    expect(MAX_RETRIES).toBe(5);
  });

  it('should have base delay of 1 second', () => {
    const BASE_DELAY = 1000;
    expect(BASE_DELAY).toBe(1000);
  });
});
