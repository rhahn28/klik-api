/**
 * On-Chain Memo Sender Service
 *
 * Sends Solana transactions with SPL Memo instructions to notify wallet
 * owners about their OpenClaw agents. Includes dust transfers to ensure
 * memos appear in standard wallet UIs.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DUST_LAMPORTS = 1000;
const MAX_MEMO_LENGTH = 200;
const ESTIMATED_LAMPORTS_PER_TX = 10000;

// ---------------------------------------------------------------------------
// Treasury keypair loader
// ---------------------------------------------------------------------------

function loadTreasuryKeypair() {
  const pk = process.env.TREASURY_PRIVATE_KEY;
  if (!pk) {
    throw new Error('TREASURY_PRIVATE_KEY environment variable not set');
  }
  try {
    const decoded = bs58.decode(pk);
    return Keypair.fromSecretKey(decoded);
  } catch (err) {
    throw new Error(`Failed to decode TREASURY_PRIVATE_KEY: ${err.message}`);
  }
}

function getConnection() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(rpcUrl, 'confirmed');
}

// ---------------------------------------------------------------------------
// Send a single claim memo
// ---------------------------------------------------------------------------

/**
 * Send an on-chain memo to a wallet address notifying them about their agent.
 *
 * @param {string} walletAddress - Solana public key of the recipient
 * @param {string} agentId - MongoDB ObjectId of the agent
 * @param {string} claimUrl - Full URL to the claim page
 * @returns {Promise<{signature: string, success: boolean}>}
 */
export async function sendClaimMemo(walletAddress, agentId, claimUrl) {
  const connection = getConnection();
  const treasury = loadTreasuryKeypair();

  let memo = `Your AI agent is live on KLIK! Claim it: ${claimUrl}`;
  if (memo.length > MAX_MEMO_LENGTH) {
    memo = memo.slice(0, MAX_MEMO_LENGTH - 3) + '...';
  }

  const memoBytes = Buffer.from(memo, 'utf-8');
  const recipientPubkey = new PublicKey(walletAddress);

  // SPL Memo instruction
  const memoInstruction = new TransactionInstruction({
    keys: [{ pubkey: treasury.publicKey, isSigner: true, isWritable: true }],
    programId: MEMO_PROGRAM_ID,
    data: memoBytes,
  });

  // Dust transfer so the memo shows up in wallet activity feeds
  const dustTransfer = SystemProgram.transfer({
    fromPubkey: treasury.publicKey,
    toPubkey: recipientPubkey,
    lamports: DUST_LAMPORTS,
  });

  const tx = new Transaction().add(dustTransfer, memoInstruction);

  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [treasury], {
      commitment: 'confirmed',
      maxRetries: 3,
    });

    console.log(JSON.stringify({
      event: 'memo_sent',
      wallet: walletAddress,
      agentId,
      signature,
      success: true,
    }));

    return { signature, success: true };
  } catch (err) {
    console.error(JSON.stringify({
      event: 'memo_send_failed',
      wallet: walletAddress,
      agentId,
      error: err.message,
    }));

    return { signature: null, success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Batch memo sender with concurrency control
// ---------------------------------------------------------------------------

/**
 * Send memos to a batch of wallet agents.
 *
 * @param {Array<{walletAddress: string, agentId: string, agentName: string}>} agents
 * @param {object} db - MongoDB database instance
 * @param {number} concurrency - Max parallel sends (default 5)
 * @returns {Promise<{total: number, succeeded: number, failed: number, results: Array}>}
 */
export async function sendBatchMemos(agents, db, concurrency = 5) {
  const results = [];
  let succeeded = 0;
  let failed = 0;
  const total = agents.length;

  console.log(JSON.stringify({
    event: 'batch_memo_start',
    total,
    concurrency,
    estimatedCostSol: estimateBatchCost(total).totalSol,
  }));

  // Process in batches of `concurrency`
  for (let i = 0; i < agents.length; i += concurrency) {
    const batch = agents.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async (agent) => {
        const claimUrl = `https://klik.cool/claim?wallet=${agent.walletAddress}`;
        const result = await sendClaimMemo(agent.walletAddress, agent.agentId, claimUrl);

        // Store notification record
        await db.collection('wallet_agent_notifications').insertOne({
          walletAddress: agent.walletAddress,
          agentId: agent.agentId,
          channel: 'onchain_memo',
          template: 'AGENT_CREATED',
          status: result.success ? 'sent' : 'failed',
          txSignature: result.signature,
          error: result.error || null,
          sentAt: new Date(),
        });

        return result;
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.success) {
        succeeded++;
        results.push(r.value);
      } else {
        failed++;
        results.push(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message });
      }
    }

    // Brief delay between batches to avoid RPC rate limits
    if (i + concurrency < agents.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Progress log every 50
    if ((i + concurrency) % 50 === 0 || i + concurrency >= agents.length) {
      console.log(JSON.stringify({
        event: 'batch_memo_progress',
        processed: Math.min(i + concurrency, total),
        total,
        succeeded,
        failed,
      }));
    }
  }

  console.log(JSON.stringify({
    event: 'batch_memo_complete',
    total,
    succeeded,
    failed,
  }));

  return { total, succeeded, failed, results };
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the SOL cost for sending a batch of memos.
 *
 * @param {number} count - Number of memos to send
 * @returns {{totalLamports: number, totalSol: number, totalUsd: number}}
 */
export function estimateBatchCost(count) {
  const totalLamports = count * ESTIMATED_LAMPORTS_PER_TX;
  const totalSol = totalLamports / 1e9;
  // Rough estimate at ~$150/SOL
  const totalUsd = totalSol * 150;

  return {
    totalLamports,
    totalSol: parseFloat(totalSol.toFixed(6)),
    totalUsd: parseFloat(totalUsd.toFixed(2)),
    perTxLamports: ESTIMATED_LAMPORTS_PER_TX,
    count,
  };
}

export default {
  sendClaimMemo,
  sendBatchMemos,
  estimateBatchCost,
};
