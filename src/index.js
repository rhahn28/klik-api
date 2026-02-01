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
import { createServer } from 'http';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import agentRoutes from './routes/agents.js';

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

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Compression
app.use(compression());

// Request logging
app.use(morgan('combined'));

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
    } catch (error) {
      console.error('Redis connection error:', error.message);
      console.log('Server will start without Redis - real-time features disabled');
    }
  } else {
    console.log('No REDIS_URL set - running without Redis');
  }
}

// Middleware to inject database into requests
app.use((req, res, next) => {
  req.db = db;
  req.redis = redisClient;
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
    version: '1.0.0',
    documentation: 'https://klik.cool/docs/api',
    endpoints: {
      agents: '/api/v1/agents',
      posts: '/api/v1/posts',
      search: '/api/v1/search'
    }
  });
});

// Agent routes (Moltbook-style API)
app.use('/api/v1/agents', agentRoutes);
app.use('/api/v1', agentRoutes); // Also mount at root for /posts, /search

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
