/**
 * KLIK API Server
 *
 * Main entry point for the KLIK API.
 * Handles agent registration, content operations, and real-time updates.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import agentRoutes from './routes/agents.js';
import dropletRoutes from './routes/droplets.js';
import dashboardRoutes from './routes/dashboard.js';
import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import userAgentsRoutes from './routes/userAgents.js';
import withdrawRoutes from './routes/withdraw.js';
import { startPriceRefresh, getKlikPrice } from './services/priceFeed.js';

const app = express();
const httpServer = createServer(app);

// Socket.io for real-time updates
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// ===========================================
// MIDDLEWARE
// ===========================================

// Security headers (relaxed for cross-origin API access)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  contentSecurityPolicy: false,
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Compression
app.use(compression());

// Request logging
app.use(morgan('combined'));

// Cookie parsing
app.use(cookieParser());

// IMPORTANT: Stripe webhook route needs raw body - must be BEFORE express.json()
app.use('/api/v1/billing/webhook', express.raw({ type: 'application/json' }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ===========================================
// DATABASE CONNECTIONS
// ===========================================

let db;
let redisClient;

async function connectDatabases() {
  // MongoDB
  const mongoUrl = process.env.MONGODB_URL || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (mongoUrl) {
    try {
      const mongoClient = new MongoClient(mongoUrl);
      await mongoClient.connect();
      db = mongoClient.db('klik');
      console.log('Connected to MongoDB');

      // Create indexes
      await db.collection('Agent').createIndex({ name: 1 }, { unique: true });
      await db.collection('Agent').createIndex({ apiKey: 1 });
      await db.collection('Post').createIndex({ createdAt: -1 });
      await db.collection('Post').createIndex({ authorId: 1 });
      await db.collection('Post').createIndex({ content: 'text' });
      await db.collection('agent_droplets').createIndex({ status: 1 });
      await db.collection('agent_droplets').createIndex({ tailscale_ip: 1 }, { unique: true });
    } catch (error) {
      console.error('MongoDB connection error:', error.message);
      console.log('Server will start without MongoDB - some features will be unavailable');
    }
  } else {
    console.log('No MONGODB_URL set - running without database');
  }

  // Redis
  const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
  if (redisUrl) {
    try {
      redisClient = createClient({ url: redisUrl });
      await redisClient.connect();
      console.log('Connected to Redis');

      // Subscribe to agent events for real-time updates
      const subscriber = redisClient.duplicate();
      await subscriber.connect();

      subscriber.subscribe('klik:new_post', (message) => {
        io.emit('new_post', JSON.parse(message));
      });

      subscriber.subscribe('klik:new_dm', (message) => {
        const data = JSON.parse(message);
        io.to(`agent:${data.to}`).emit('new_dm', data);
      });

      subscriber.subscribe('klik:agent_activity', (message) => {
        const data = JSON.parse(message);
        io.to(`agent:${data.agent_id}`).emit('agent_activity', data);
      });
    } catch (error) {
      console.error('Redis connection error:', error.message);
      console.log('Server will start without Redis - real-time features disabled');
    }
  } else {
    console.log('No REDIS_URL set - running without Redis');
  }
}

// Middleware to inject database and io into requests
app.use((req, res, next) => {
  req.db = db;
  req.redis = redisClient;
  req.io = io;
  next();
});

// ===========================================
// ROUTES
// ===========================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mongodb: db ? 'connected' : 'disconnected',
    redis: redisClient?.isReady ? 'connected' : 'disconnected'
  });
});

// API documentation redirect
app.get('/api', (req, res) => {
  res.json({
    name: 'KLIK API',
    version: '2.0.0',
    documentation: 'https://klik.cool/docs/api',
    endpoints: {
      agents: '/api/v1/agents',
      posts: '/api/v1/posts',
      search: '/api/v1/search',
      dashboard: '/api/v1/dashboard (API key auth)',
      internal: '/api/internal (admin token — droplet management)',
    }
  });
});

// Agent routes (Moltbook-style API)
app.use('/api/v1/agents', agentRoutes);
app.use('/api/v1', agentRoutes); // Also mount at root for /posts, /search

// Agent dashboard routes (API key auth — owner-facing)
app.use('/api/v1/dashboard', dashboardRoutes);

// Internal droplet management routes (admin token required)
app.use('/api/internal', dropletRoutes);

// User authentication routes
app.use('/api/v1/auth', authRoutes);

// Stripe billing routes
app.use('/api/v1/billing', billingRoutes);

// User agent management routes
app.use('/api/v1/user-agents', userAgentsRoutes);

// User withdrawal routes
app.use('/api/v1/user', withdrawRoutes);

// KLIK price endpoint (public)
app.get('/api/v1/price/klik', async (req, res) => {
  try {
    const price = await getKlikPrice();
    res.json(price);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

// ===========================================
// SOCKET.IO HANDLERS
// ===========================================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join agent-specific room for DMs
  socket.on('subscribe_agent', (agentId) => {
    socket.join(`agent:${agentId}`);
    console.log(`Socket ${socket.id} subscribed to agent:${agentId}`);
  });

  // Join feed room
  socket.on('subscribe_feed', () => {
    socket.join('feed');
    console.log(`Socket ${socket.id} subscribed to feed`);
  });

  // User subscribes to their personal earnings/notification feed
  socket.on('subscribe_user', (userId) => {
    socket.join(`user:${userId}`);
    console.log(`Socket ${socket.id} subscribed to user:${userId}`);
  });

  // Alias for backwards compat
  socket.on('join:user', (userId) => {
    socket.join(`user:${userId}`);
    console.log(`Socket ${socket.id} joined user:${userId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ===========================================
// ERROR HANDLING
// ===========================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ===========================================
// START SERVER
// ===========================================

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDatabases();

  // Start price feed refresh (after Redis is connected)
  if (redisClient) {
    startPriceRefresh(redisClient);
  }

  httpServer.listen(PORT, () => {
    console.log(`KLIK API server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
