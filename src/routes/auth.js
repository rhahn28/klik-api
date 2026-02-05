/**
 * Auth API Routes
 *
 * Email/password authentication with JWT tokens and secure cookies.
 * Supports signup, login, logout, token refresh, password reset, and wallet linking.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { verifyUserJWT } from '../middleware/userAuth.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || (JWT_SECRET ? JWT_SECRET + '_refresh' : null);

// ===========================================
// RATE LIMITERS
// ===========================================

const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Too many login attempts. Try again in 1 minute.' }
});

const signupLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many signup attempts. Try again later.' }
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { error: 'Too many reset attempts. Try again in 1 hour.' }
});

// ===========================================
// HELPERS
// ===========================================

function generateTokens(userId, email) {
  const accessToken = jwt.sign(
    { userId: userId.toString(), email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  const refreshToken = jwt.sign(
    { userId: userId.toString(), type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );
  return { accessToken, refreshToken };
}

function setTokenCookies(res, accessToken, refreshToken) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('klik_access_token', accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/'
  });
  res.cookie('klik_refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/api/v1/auth/refresh'
  });
}

// ===========================================
// ROUTES
// ===========================================

/**
 * POST /api/v1/auth/signup
 * Create a new user account
 */
router.post('/signup', signupLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/\d/).withMessage('Password must contain a number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain a special character'),
  body('name').optional().trim().isLength({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Auth service not configured' });
    }

    const { email, password, name } = req.body;

    // Check existing user
    const existing = await req.db.collection('User').findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();

    const result = await req.db.collection('User').insertOne({
      email,
      passwordHash,
      name: name || null,
      avatarUrl: null,
      stripeCustomerId: null,
      subscriptionId: null,
      subscriptionStatus: 'inactive',
      subscriptionTier: 'free',
      subscriptionEndDate: null,
      walletAddress: null,
      klikBalance: 0,
      totalEarned: 0,
      todayEarned: 0,
      agentCount: 0,
      lastLoginAt: now,
      emailVerified: false,
      emailVerifyToken: crypto.randomBytes(32).toString('hex'),
      createdAt: now,
      updatedAt: now
    });

    const userId = result.insertedId;
    const { accessToken, refreshToken } = generateTokens(userId, email);
    setTokenCookies(res, accessToken, refreshToken);

    // Store refresh token in Redis for revocation
    if (req.redis) {
      await req.redis.set(`refresh:${userId}`, refreshToken, { EX: 30 * 24 * 60 * 60 });
    }

    // TODO: Send verification email via Resend

    res.status(201).json({
      user: {
        id: userId.toString(),
        email,
        name: name || null,
        subscriptionStatus: 'inactive',
        subscriptionTier: 'free',
        klikBalance: 0,
        totalEarned: 0,
        agents: []
      },
      accessToken // Also return in body for clients that can't read cookies
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

/**
 * POST /api/v1/auth/login
 * Authenticate user with email and password
 */
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Auth service not configured' });
    }

    const { email, password } = req.body;
    const user = await req.db.collection('User').findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await req.db.collection('User').updateOne(
      { _id: user._id },
      { $set: { lastLoginAt: new Date(), updatedAt: new Date() } }
    );

    const { accessToken, refreshToken } = generateTokens(user._id, email);
    setTokenCookies(res, accessToken, refreshToken);

    if (req.redis) {
      await req.redis.set(`refresh:${user._id}`, refreshToken, { EX: 30 * 24 * 60 * 60 });
    }

    // Fetch user's agents
    const agents = await req.db.collection('Agent').find(
      { userId: user._id, status: { $ne: 'DELETED' } },
      { projection: { apiKey: 0, agentSeed: 0 } }
    ).toArray();

    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionTier: user.subscriptionTier,
        klikBalance: user.klikBalance || 0,
        totalEarned: user.totalEarned || 0,
        todayEarned: user.todayEarned || 0,
        walletAddress: user.walletAddress,
        agents
      },
      accessToken
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/v1/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.klik_refresh_token;
    if (!refreshToken) {
      return res.status(401).json({ error: 'No refresh token' });
    }

    if (!JWT_REFRESH_SECRET) {
      return res.status(500).json({ error: 'Auth service not configured' });
    }

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    // Check token hasn't been revoked
    if (req.redis) {
      const stored = await req.redis.get(`refresh:${decoded.userId}`);
      if (stored !== refreshToken) {
        return res.status(401).json({ error: 'Token revoked' });
      }
    }

    const user = await req.db.collection('User').findOne(
      { _id: new ObjectId(decoded.userId) },
      { projection: { email: 1 } }
    );
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const tokens = generateTokens(user._id, user.email);
    setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

    if (req.redis) {
      await req.redis.set(`refresh:${user._id}`, tokens.refreshToken, { EX: 30 * 24 * 60 * 60 });
    }

    res.json({ accessToken: tokens.accessToken });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

/**
 * POST /api/v1/auth/logout
 * Logout user and revoke tokens
 */
router.post('/logout', verifyUserJWT, async (req, res) => {
  if (req.redis) {
    await req.redis.del(`refresh:${req.user._id}`);
  }
  res.clearCookie('klik_access_token');
  res.clearCookie('klik_refresh_token', { path: '/api/v1/auth/refresh' });
  res.json({ success: true });
});

/**
 * GET /api/v1/auth/me
 * Get current user info
 */
router.get('/me', verifyUserJWT, async (req, res) => {
  const agents = await req.db.collection('Agent').find(
    { userId: req.user._id, status: { $ne: 'DELETED' } },
    { projection: { apiKey: 0, agentSeed: 0 } }
  ).toArray();

  res.json({
    id: req.user._id.toString(),
    email: req.user.email,
    name: req.user.name,
    avatarUrl: req.user.avatarUrl,
    subscriptionStatus: req.user.subscriptionStatus,
    subscriptionTier: req.user.subscriptionTier,
    subscriptionEndDate: req.user.subscriptionEndDate,
    klikBalance: req.user.klikBalance || 0,
    totalEarned: req.user.totalEarned || 0,
    todayEarned: req.user.todayEarned || 0,
    walletAddress: req.user.walletAddress,
    agents
  });
});

/**
 * POST /api/v1/auth/forgot-password
 * Request password reset email
 */
router.post('/forgot-password', resetLimiter, [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  const { email } = req.body;
  const user = await req.db.collection('User').findOne({ email });

  // Always return success to prevent email enumeration
  if (!user) {
    return res.json({ message: 'If that email exists, a reset link has been sent.' });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  if (req.redis) {
    await req.redis.set(`pwd_reset:${resetToken}`, user._id.toString(), { EX: 3600 }); // 1 hour
  }

  // TODO: Send email with link: https://klik.cool/reset-password?token=${resetToken}
  console.log(`Password reset token for ${email}: ${resetToken}`);

  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

/**
 * POST /api/v1/auth/reset-password
 * Reset password using token
 */
router.post('/reset-password', [
  body('token').notEmpty(),
  body('newPassword')
    .isLength({ min: 8 })
    .matches(/\d/)
    .matches(/[!@#$%^&*(),.?":{}|<>]/)
], async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!req.redis) {
      return res.status(500).json({ error: 'Service unavailable' });
    }

    const userId = await req.redis.get(`pwd_reset:${token}`);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await req.db.collection('User').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { passwordHash, updatedAt: new Date() } }
    );

    await req.redis.del(`pwd_reset:${token}`);
    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

/**
 * POST /api/v1/auth/link-wallet
 * Link Solana wallet address to user account
 */
router.post('/link-wallet', verifyUserJWT, [
  body('walletAddress').notEmpty().isLength({ min: 32, max: 44 })
], async (req, res) => {
  try {
    const { walletAddress } = req.body;

    // Basic Solana address validation (base58, 32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
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

export default router;
