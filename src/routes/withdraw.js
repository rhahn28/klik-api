/**
 * Withdrawal Routes
 *
 * KLIK token withdrawals to Solana wallets.
 */

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { verifyUserJWT } from '../middleware/userAuth.js';
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount
} from '@solana/spl-token';
import bs58 from 'bs58';
import rateLimit from 'express-rate-limit';

const router = Router();

// Constants
const KLIK_MINT = new PublicKey(process.env.KLIK_TOKEN_MINT || '8cPAhMb6bvQg3v1v3yxBCLnUJkboEiV2F8W19z1CS5iB');
const KLIK_DECIMALS = 9;
const MIN_WITHDRAWAL = 100;
const MAX_WITHDRAWAL = 1_000_000;
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Rate limiter for withdrawals
const withdrawLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { error: 'Too many withdrawal requests. Try again in 1 hour.' }
});

// Load treasury keypair from env
let treasuryKeypair = null;
try {
  if (process.env.TREASURY_PRIVATE_KEY) {
    treasuryKeypair = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY));
    console.log('Treasury wallet loaded:', treasuryKeypair.publicKey.toBase58());
  } else {
    console.warn('TREASURY_PRIVATE_KEY not set - withdrawals will fail');
  }
} catch (err) {
  console.error('Failed to load treasury keypair:', err.message);
}

/**
 * POST /api/v1/user/withdraw
 * Withdraw KLIK tokens to user's Solana wallet
 */
router.post('/withdraw', verifyUserJWT, withdrawLimiter, async (req, res) => {
  const { amount, walletAddress } = req.body;

  // Validate amount
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < MIN_WITHDRAWAL) {
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAWAL} KLIK` });
  }
  if (numAmount > MAX_WITHDRAWAL) {
    return res.status(400).json({ error: `Maximum withdrawal is ${MAX_WITHDRAWAL.toLocaleString()} KLIK per transaction` });
  }

  // Validate wallet address
  if (!walletAddress || typeof walletAddress !== 'string') {
    return res.status(400).json({ error: 'Wallet address required' });
  }

  let recipientPubkey;
  try {
    recipientPubkey = new PublicKey(walletAddress);
    if (!PublicKey.isOnCurve(recipientPubkey)) {
      throw new Error('Invalid public key');
    }
  } catch {
    return res.status(400).json({ error: 'Invalid Solana wallet address' });
  }

  // Verify wallet matches user's linked wallet
  if (req.user.walletAddress !== walletAddress) {
    return res.status(403).json({ error: 'Wallet address does not match your linked wallet' });
  }

  // Check balance with atomic deduction to prevent race conditions
  const floorAmount = Math.floor(numAmount);
  const updateResult = await req.db.collection('User').findOneAndUpdate(
    {
      _id: req.user._id,
      klikBalance: { $gte: floorAmount }
    },
    {
      $inc: { klikBalance: -floorAmount },
      $set: { updatedAt: new Date() }
    },
    { returnDocument: 'after' }
  );

  if (!updateResult) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  // Create withdrawal record
  const withdrawal = {
    userId: req.user._id,
    amount: floorAmount,
    walletAddress,
    status: 'pending',
    txSignature: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const insertResult = await req.db.collection('Withdrawal').insertOne(withdrawal);
  const withdrawalId = insertResult.insertedId;

  // Respond immediately with pending status
  res.json({
    withdrawalId: withdrawalId.toString(),
    status: 'pending',
    amount: floorAmount,
    walletAddress,
    message: 'Withdrawal submitted. Check status in your wallet page.'
  });

  // Background: Execute the actual SPL token transfer
  (async () => {
    const db = req.db;
    const io = req.io;

    try {
      if (!treasuryKeypair) {
        throw new Error('Treasury wallet not configured');
      }

      const connection = new Connection(SOLANA_RPC, 'confirmed');

      // Get or create associated token accounts
      const treasuryATA = await getAssociatedTokenAddress(KLIK_MINT, treasuryKeypair.publicKey);
      const recipientATA = await getAssociatedTokenAddress(KLIK_MINT, recipientPubkey);

      const transaction = new Transaction();

      // Check if recipient has a token account; if not, create one
      try {
        await getAccount(connection, recipientATA);
      } catch {
        // Account doesn't exist - add create instruction
        transaction.add(
          createAssociatedTokenAccountInstruction(
            treasuryKeypair.publicKey, // payer
            recipientATA,              // associated token account
            recipientPubkey,           // owner
            KLIK_MINT                  // mint
          )
        );
      }

      // Add transfer instruction
      const rawAmount = BigInt(floorAmount) * BigInt(10 ** KLIK_DECIMALS);
      transaction.add(
        createTransferInstruction(
          treasuryATA,                // source
          recipientATA,               // destination
          treasuryKeypair.publicKey,  // authority
          rawAmount                   // amount in raw units
        )
      );

      // Sign and send
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = treasuryKeypair.publicKey;
      transaction.sign(treasuryKeypair);

      const txSignature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });

      // Wait for confirmation
      await connection.confirmTransaction(txSignature, 'confirmed');

      // Update withdrawal record
      await db.collection('Withdrawal').updateOne(
        { _id: withdrawalId },
        {
          $set: {
            status: 'completed',
            txSignature,
            updatedAt: new Date()
          }
        }
      );

      console.log(`Withdrawal ${withdrawalId}: ${floorAmount} KLIK -> ${walletAddress} TX: ${txSignature}`);

      // Notify user via Socket.io
      if (io) {
        io.to(`user:${req.user._id}`).emit('withdrawal:completed', {
          withdrawalId: withdrawalId.toString(),
          amount: floorAmount,
          txSignature
        });
      }
    } catch (err) {
      console.error(`Withdrawal ${withdrawalId} failed:`, err.message);

      // Refund balance on failure
      await db.collection('User').updateOne(
        { _id: req.user._id },
        { $inc: { klikBalance: floorAmount }, $set: { updatedAt: new Date() } }
      );

      // Mark withdrawal as failed
      await db.collection('Withdrawal').updateOne(
        { _id: withdrawalId },
        {
          $set: {
            status: 'failed',
            error: err.message,
            updatedAt: new Date()
          }
        }
      );

      // Notify user of failure
      if (io) {
        io.to(`user:${req.user._id}`).emit('withdrawal:failed', {
          withdrawalId: withdrawalId.toString(),
          amount: floorAmount,
          error: 'Transfer failed. Balance has been refunded.'
        });
      }
    }
  })();
});

/**
 * GET /api/v1/user/withdrawals
 * List user's withdrawal history
 */
router.get('/withdrawals', verifyUserJWT, async (req, res) => {
  try {
    const withdrawals = await req.db.collection('Withdrawal')
      .find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    res.json({ withdrawals });
  } catch (err) {
    console.error('Withdrawal history error:', err);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

/**
 * GET /api/v1/user/withdrawal/:id
 * Get single withdrawal status
 */
router.get('/withdrawal/:id', verifyUserJWT, async (req, res) => {
  try {
    const withdrawal = await req.db.collection('Withdrawal').findOne({
      _id: new ObjectId(req.params.id),
      userId: req.user._id
    });

    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    res.json({ withdrawal });
  } catch (err) {
    console.error('Withdrawal fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch withdrawal' });
  }
});

export default router;
