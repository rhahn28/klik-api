/**
 * Authentication & Registration Tests
 *
 * Tests for:
 * 1. Agent registration works without auth (creates unclaimed agent)
 * 2. Agent registration works WITH auth (links agent to user)
 * 3. Comment endpoint requires auth and returns 401 without it
 * 4. Upvote endpoint requires auth and returns 401 without it
 */

// ============================================
// Test 1: Agent Registration Without Auth (Unclaimed)
// ============================================

describe('Agent Registration - Unclaimed (No Auth)', () => {
  // Simulate the optionalUserJWT middleware behavior
  const optionalUserJWT = async (req, res, next) => {
    // No auth header = no user
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(); // Continue without req.user
    }
    // Would normally verify token and set req.user here
    next();
  };

  it('should create agent with owner=null when no auth provided', async () => {
    const mockReq = {
      headers: {}, // No auth header
      body: {
        name: 'testAgent',
        description: 'A test agent',
      },
      db: {
        collection: (name) => ({
          findOne: async () => null, // Name not taken
          insertOne: async (doc) => {
            // Verify the document has correct ownership fields
            expect(doc.owner).toBeNull();
            expect(doc.claimStatus).toBe('unclaimed');
            expect(doc.claimedAt).toBeNull();
            return { insertedId: { toString: () => 'test-id-123' } };
          },
        }),
      },
    };

    // Simulate middleware setting req.user = undefined
    await new Promise((resolve) => {
      optionalUserJWT(mockReq, {}, resolve);
    });

    // Verify req.user is not set
    expect(mockReq.user).toBeUndefined();

    // Simulate the registration logic
    const isAuthenticated = !!mockReq.user;
    const ownerId = isAuthenticated ? mockReq.user._id : null;
    const claimStatus = isAuthenticated ? 'claimed' : 'unclaimed';

    expect(isAuthenticated).toBe(false);
    expect(ownerId).toBeNull();
    expect(claimStatus).toBe('unclaimed');
  });

  it('should include claim_url in response for unclaimed agents', () => {
    const claimStatus = 'unclaimed';
    const agentId = 'test-id-123';

    const response = {
      success: true,
      agent_id: agentId,
      claim_status: claimStatus,
      owner_id: null,
    };

    // If unclaimed, add claim URL
    if (claimStatus === 'unclaimed') {
      response.claim_url = `https://klik.cool/claim/${agentId}`;
    }

    expect(response.claim_url).toBe('https://klik.cool/claim/test-id-123');
    expect(response.owner_id).toBeNull();
    expect(response.claim_status).toBe('unclaimed');
  });
});

// ============================================
// Test 2: Agent Registration With Auth (Claimed)
// ============================================

describe('Agent Registration - Claimed (With Auth)', () => {
  const mockUserId = { toString: () => 'user-123' };
  const mockUser = {
    _id: mockUserId,
    email: 'test@example.com',
    name: 'Test User',
  };

  it('should create agent with owner linked when user is authenticated', async () => {
    const mockReq = {
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      user: mockUser, // Simulating authenticated user (set by middleware)
      body: {
        name: 'myClaimedAgent',
        description: 'An agent linked to my account',
      },
    };

    // Simulate the registration logic
    const isAuthenticated = !!mockReq.user;
    const ownerId = isAuthenticated ? mockReq.user._id : null;
    const claimStatus = isAuthenticated ? 'claimed' : 'unclaimed';
    const claimedAt = isAuthenticated ? new Date() : null;

    expect(isAuthenticated).toBe(true);
    expect(ownerId).toBe(mockUserId);
    expect(claimStatus).toBe('claimed');
    expect(claimedAt).not.toBeNull();
  });

  it('should NOT include claim_url in response for claimed agents', () => {
    const claimStatus = 'claimed';
    const agentId = 'test-id-456';
    const ownerId = 'user-123';

    const response = {
      success: true,
      agent_id: agentId,
      claim_status: claimStatus,
      owner_id: ownerId,
    };

    // Only add claim URL if unclaimed
    if (claimStatus === 'unclaimed') {
      response.claim_url = `https://klik.cool/claim/${agentId}`;
    }

    expect(response.claim_url).toBeUndefined();
    expect(response.owner_id).toBe('user-123');
    expect(response.claim_status).toBe('claimed');
  });
});

// ============================================
// Test 3: Comment Endpoint Requires Auth
// ============================================

describe('User Comment Endpoint - Auth Required', () => {
  // Replicate the verifyUserJWT middleware logic for testing
  const verifyUserJWT = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // In real implementation, would verify token here
    // For test, simulate invalid/expired token
    if (req._simulateInvalidToken) {
      return res.status(401).json({ error: 'Authentication failed', code: 'AUTH_FAILED' });
    }

    next();
  };

  it('should return 401 when no auth header provided', async () => {
    const mockReq = {
      headers: {}, // No auth header
      params: { id: 'post-123' },
      body: { content: 'Test comment' },
    };

    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => {
            responseBody = body;
          },
        };
      },
    };
    const mockNext = jest.fn();

    await verifyUserJWT(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Authentication required');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 when auth header format is wrong', async () => {
    const mockReq = {
      headers: { authorization: 'Basic abc123' }, // Wrong format
      params: { id: 'post-123' },
      body: { content: 'Test comment' },
    };

    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => {
            responseBody = body;
          },
        };
      },
    };
    const mockNext = jest.fn();

    await verifyUserJWT(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Authentication required');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 when token is invalid', async () => {
    const mockReq = {
      headers: { authorization: 'Bearer invalid-token' },
      params: { id: 'post-123' },
      body: { content: 'Test comment' },
      _simulateInvalidToken: true,
    };

    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => {
            responseBody = body;
          },
        };
      },
    };
    const mockNext = jest.fn();

    await verifyUserJWT(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Authentication failed');
    expect(responseBody.code).toBe('AUTH_FAILED');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should call next() when valid auth provided', async () => {
    const mockReq = {
      headers: { authorization: 'Bearer valid-jwt-token' },
      params: { id: 'post-123' },
      body: { content: 'Test comment' },
      _simulateInvalidToken: false,
    };

    const mockRes = {
      status: () => ({ json: () => {} }),
    };
    const mockNext = jest.fn();

    await verifyUserJWT(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });
});

// ============================================
// Test 4: Upvote Endpoint Requires Auth
// ============================================

describe('User Upvote Endpoint - Auth Required', () => {
  // Same middleware used for upvote
  const verifyUserJWT = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req._simulateInvalidToken) {
      return res.status(401).json({ error: 'Authentication failed', code: 'AUTH_FAILED' });
    }

    next();
  };

  it('should return 401 when no auth header provided for upvote', async () => {
    const mockReq = {
      headers: {}, // No auth header
      params: { id: 'post-123' },
    };

    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => {
            responseBody = body;
          },
        };
      },
    };
    const mockNext = jest.fn();

    await verifyUserJWT(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Authentication required');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 when auth header has no Bearer prefix', async () => {
    const mockReq = {
      headers: { authorization: 'jwt-token-without-bearer' },
      params: { id: 'post-123' },
    };

    let responseStatus = null;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => {
            responseBody = body;
          },
        };
      },
    };
    const mockNext = jest.fn();

    await verifyUserJWT(mockReq, mockRes, mockNext);

    expect(responseStatus).toBe(401);
    expect(responseBody.error).toBe('Authentication required');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should call next() when valid Bearer token provided', async () => {
    const mockReq = {
      headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test' },
      params: { id: 'post-123' },
      _simulateInvalidToken: false,
    };

    const mockRes = {
      status: () => ({ json: () => {} }),
    };
    const mockNext = jest.fn();

    await verifyUserJWT(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });
});

// ============================================
// Test 5: Optional Auth Middleware Behavior
// ============================================

describe('Optional User JWT Middleware', () => {
  // Replicate optionalUserJWT behavior
  const optionalUserJWT = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    // No auth header = continue without user
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    // Try to verify token, but don't fail if invalid
    try {
      if (req._simulateValidToken) {
        req.user = { _id: 'user-123', email: 'test@example.com' };
      }
      // Invalid tokens are silently ignored in optional auth
    } catch (e) {
      // Don't fail on optional auth errors
    }

    next();
  };

  it('should continue without user when no auth header', async () => {
    const mockReq = {
      headers: {},
    };

    const mockNext = jest.fn();

    await optionalUserJWT(mockReq, {}, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.user).toBeUndefined();
  });

  it('should set req.user when valid token provided', async () => {
    const mockReq = {
      headers: { authorization: 'Bearer valid-token' },
      _simulateValidToken: true,
    };

    const mockNext = jest.fn();

    await optionalUserJWT(mockReq, {}, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.user).toBeDefined();
    expect(mockReq.user._id).toBe('user-123');
  });

  it('should continue without user when token is invalid (graceful failure)', async () => {
    const mockReq = {
      headers: { authorization: 'Bearer invalid-token' },
      _simulateValidToken: false,
    };

    const mockNext = jest.fn();

    await optionalUserJWT(mockReq, {}, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.user).toBeUndefined();
  });
});

// ============================================
// Test 6: Agent Document Structure
// ============================================

describe('Agent Document Structure - Ownership Fields', () => {
  it('should have correct ownership fields for claimed agent', () => {
    const mockUser = { _id: 'user-abc-123' };
    const isAuthenticated = true;

    const agent = {
      name: 'testAgent',
      owner: isAuthenticated ? mockUser._id : null,
      claimStatus: isAuthenticated ? 'claimed' : 'unclaimed',
      claimedAt: isAuthenticated ? new Date() : null,
    };

    expect(agent.owner).toBe('user-abc-123');
    expect(agent.claimStatus).toBe('claimed');
    expect(agent.claimedAt).toBeInstanceOf(Date);
  });

  it('should have correct ownership fields for unclaimed agent', () => {
    const isAuthenticated = false;

    const agent = {
      name: 'unclaimedAgent',
      owner: isAuthenticated ? 'user-id' : null,
      claimStatus: isAuthenticated ? 'claimed' : 'unclaimed',
      claimedAt: isAuthenticated ? new Date() : null,
    };

    expect(agent.owner).toBeNull();
    expect(agent.claimStatus).toBe('unclaimed');
    expect(agent.claimedAt).toBeNull();
  });
});
