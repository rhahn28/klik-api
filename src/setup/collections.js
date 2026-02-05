/**
 * MongoDB Collection Setup Script
 *
 * Run once to create User and Withdrawal collections with schema validation and indexes.
 * Usage: node src/setup/collections.js
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const mongoUrl = process.env.MONGODB_URL || process.env.MONGO_URL || process.env.DATABASE_URL;

async function setup() {
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
    // USER COLLECTION
    // ===========================================

    try {
      await db.createCollection('User', {
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['email', 'passwordHash', 'createdAt'],
            properties: {
              email: { bsonType: 'string' },
              passwordHash: { bsonType: 'string' },
              name: { bsonType: 'string' },
              avatarUrl: { bsonType: 'string' },
              stripeCustomerId: { bsonType: 'string' },
              subscriptionId: { bsonType: 'string' },
              subscriptionStatus: {
                bsonType: 'string',
                enum: ['active', 'past_due', 'canceled', 'inactive', 'trialing']
              },
              subscriptionTier: {
                bsonType: 'string',
                enum: ['free', 'starter', 'pro', 'unlimited']
              },
              subscriptionEndDate: { bsonType: 'date' },
              walletAddress: { bsonType: 'string' },
              klikBalance: { bsonType: 'double' },
              totalEarned: { bsonType: 'double' },
              todayEarned: { bsonType: 'double' },
              lastLoginAt: { bsonType: 'date' },
              emailVerified: { bsonType: 'bool' },
              emailVerifyToken: { bsonType: 'string' },
              agentCount: { bsonType: 'int' },
              createdAt: { bsonType: 'date' },
              updatedAt: { bsonType: 'date' }
            }
          }
        }
      });
      console.log('✓ Created User collection with schema validation');
    } catch (e) {
      if (e.codeName === 'NamespaceExists') {
        console.log('→ User collection already exists');
      } else {
        throw e;
      }
    }

    // User indexes
    await db.collection('User').createIndex({ email: 1 }, { unique: true });
    await db.collection('User').createIndex({ stripeCustomerId: 1 }, { unique: true, sparse: true });
    await db.collection('User').createIndex({ walletAddress: 1 }, { sparse: true });
    console.log('✓ Created User indexes');

    // Add userId field index to Agent collection (for linking agents to users)
    await db.collection('Agent').createIndex({ userId: 1 }, { sparse: true });
    console.log('✓ Added userId index to Agent collection');

    // ===========================================
    // WITHDRAWAL COLLECTION
    // ===========================================

    try {
      await db.createCollection('Withdrawal', {
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['userId', 'amount', 'walletAddress', 'status', 'createdAt'],
            properties: {
              userId: { bsonType: 'objectId' },
              amount: { bsonType: 'number', minimum: 100 },
              walletAddress: { bsonType: 'string' },
              status: {
                bsonType: 'string',
                enum: ['pending', 'completed', 'failed']
              },
              txSignature: { bsonType: ['string', 'null'] },
              error: { bsonType: ['string', 'null'] },
              createdAt: { bsonType: 'date' },
              updatedAt: { bsonType: 'date' }
            }
          }
        }
      });
      console.log('✓ Created Withdrawal collection with schema validation');
    } catch (e) {
      if (e.codeName === 'NamespaceExists') {
        console.log('→ Withdrawal collection already exists');
      } else {
        throw e;
      }
    }

    // Withdrawal indexes
    await db.collection('Withdrawal').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('Withdrawal').createIndex({ status: 1 });
    await db.collection('Withdrawal').createIndex({ txSignature: 1 }, { sparse: true });
    console.log('✓ Created Withdrawal indexes');

    console.log('\n========================================');
    console.log('Setup complete!');
    console.log('========================================');

  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

setup();
