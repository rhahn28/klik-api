/**
 * Migration 001: Wallet Agent Indexes and Collections
 *
 * Creates the collections and indexes needed for the OpenClaw
 * wallet agent claim system.
 *
 * Usage: node src/migrations/001_wallet_agent_indexes.js
 */

import { MongoClient } from 'mongodb';
import 'dotenv/config';

const mongoUrl = process.env.MONGODB_URL || process.env.MONGO_URL || process.env.DATABASE_URL;

async function migrate() {
  if (!mongoUrl) {
    console.error('ERROR: No MongoDB URL found in environment variables');
    console.error('Set MONGODB_URL, MONGO_URL, or DATABASE_URL');
    process.exit(1);
  }

  const client = new MongoClient(mongoUrl);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db('klik');

    // ===========================================
    // AGENT COLLECTION INDEXES (wallet agent fields)
    // ===========================================

    // Sparse unique index on source wallet — each wallet maps to at most one agent
    await db.collection('Agent').createIndex(
      { 'walletAgentData.sourceWallet': 1 },
      { sparse: true, unique: true, name: 'idx_wallet_agent_source_wallet' }
    );
    console.log('Created index: Agent.walletAgentData.sourceWallet (sparse, unique)');

    // Compound index for finding wallet agents by claim status
    await db.collection('Agent').createIndex(
      { isWalletAgent: 1, 'walletAgentData.claimStatus': 1 },
      { sparse: true, name: 'idx_wallet_agent_claim_status' }
    );
    console.log('Created index: Agent.isWalletAgent + walletAgentData.claimStatus');

    // Compound index for orphan queries (status + engagement sorting)
    await db.collection('Agent').createIndex(
      {
        isWalletAgent: 1,
        'walletAgentData.claimStatus': 1,
        'walletAgentData.claimDeadline': 1,
      },
      { sparse: true, name: 'idx_wallet_agent_orphan_deadline' }
    );
    console.log('Created index: Agent orphan deadline compound');

    // Index for orphan listing sorted by engagement
    await db.collection('Agent').createIndex(
      {
        isWalletAgent: 1,
        'walletAgentData.claimStatus': 1,
        'stats.totalTipsReceived': -1,
      },
      { sparse: true, name: 'idx_wallet_agent_orphan_engagement' }
    );
    console.log('Created index: Agent orphan engagement sorting');

    // ===========================================
    // WALLET_AGENT_CLAIMS COLLECTION
    // Audit log for all claim-related actions
    // ===========================================

    try {
      await db.createCollection('wallet_agent_claims');
      console.log('Created collection: wallet_agent_claims');
    } catch (e) {
      if (e.codeName === 'NamespaceExists') {
        console.log('Collection wallet_agent_claims already exists');
      } else {
        throw e;
      }
    }

    await db.collection('wallet_agent_claims').createIndex(
      { agentId: 1, action: 1 },
      { name: 'idx_claims_agent_action' }
    );
    await db.collection('wallet_agent_claims').createIndex(
      { walletAddress: 1, action: 1 },
      { name: 'idx_claims_wallet_action' }
    );
    await db.collection('wallet_agent_claims').createIndex(
      { timestamp: -1 },
      { name: 'idx_claims_timestamp' }
    );
    await db.collection('wallet_agent_claims').createIndex(
      { ip: 1, timestamp: -1 },
      { name: 'idx_claims_ip_timestamp' }
    );
    console.log('Created wallet_agent_claims indexes');

    // ===========================================
    // WALLET_OPT_OUTS COLLECTION
    // Permanent blocklist for opted-out wallets
    // ===========================================

    try {
      await db.createCollection('wallet_opt_outs');
      console.log('Created collection: wallet_opt_outs');
    } catch (e) {
      if (e.codeName === 'NamespaceExists') {
        console.log('Collection wallet_opt_outs already exists');
      } else {
        throw e;
      }
    }

    await db.collection('wallet_opt_outs').createIndex(
      { walletAddress: 1 },
      { unique: true, name: 'idx_opt_outs_wallet' }
    );
    await db.collection('wallet_opt_outs').createIndex(
      { optedOutAt: -1 },
      { name: 'idx_opt_outs_timestamp' }
    );
    console.log('Created wallet_opt_outs indexes');

    // ===========================================
    // WALLET_AGENT_NOTIFICATIONS COLLECTION
    // User notifications for claim/orphan events
    // ===========================================

    try {
      await db.createCollection('wallet_agent_notifications');
      console.log('Created collection: wallet_agent_notifications');
    } catch (e) {
      if (e.codeName === 'NamespaceExists') {
        console.log('Collection wallet_agent_notifications already exists');
      } else {
        throw e;
      }
    }

    await db.collection('wallet_agent_notifications').createIndex(
      { userId: 1, read: 1, createdAt: -1 },
      { name: 'idx_notifications_user_unread' }
    );
    await db.collection('wallet_agent_notifications').createIndex(
      { agentId: 1 },
      { name: 'idx_notifications_agent' }
    );
    await db.collection('wallet_agent_notifications').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 90 * 24 * 3600, name: 'idx_notifications_ttl' }
    );
    console.log('Created wallet_agent_notifications indexes');

    // ===========================================
    // ORPHAN_WATCHLIST COLLECTION
    // Users watching specific agents for orphan status
    // ===========================================

    try {
      await db.createCollection('orphan_watchlist');
      console.log('Created collection: orphan_watchlist');
    } catch (e) {
      if (e.codeName === 'NamespaceExists') {
        console.log('Collection orphan_watchlist already exists');
      } else {
        throw e;
      }
    }

    await db.collection('orphan_watchlist').createIndex(
      { userId: 1, agentId: 1 },
      { unique: true, name: 'idx_watchlist_user_agent' }
    );
    await db.collection('orphan_watchlist').createIndex(
      { agentId: 1, notified: 1 },
      { name: 'idx_watchlist_agent_notified' }
    );
    console.log('Created orphan_watchlist indexes');

    console.log('\n========================================');
    console.log('Migration 001 complete!');
    console.log('========================================');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrate();
