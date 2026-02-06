/**
 * Orphan Transition Cron Job
 *
 * Finds all UNCLAIMED wallet agents past their claim deadline and
 * transitions them to ORPHANED status. Notifies users on the
 * watchlist. Designed to run hourly.
 */

import { ObjectId } from 'mongodb';

/**
 * Process orphan transitions for all expired unclaimed wallet agents.
 *
 * @param {object} db - MongoDB database instance
 * @param {object} redis - Redis client instance (optional, for pub/sub notifications)
 * @returns {object} Summary of processed transitions
 */
export async function processOrphanTransitions(db, redis) {
  const now = new Date();
  const summary = {
    processed: 0,
    transitioned: 0,
    notified: 0,
    errors: [],
  };

  try {
    // Find all unclaimed wallet agents past their claim deadline
    const expiredAgents = await db.collection('Agent').find({
      isWalletAgent: true,
      'walletAgentData.claimStatus': 'UNCLAIMED',
      'walletAgentData.claimDeadline': { $lte: now },
    }).toArray();

    summary.processed = expiredAgents.length;

    if (expiredAgents.length === 0) {
      console.log('[OrphanCron] No expired unclaimed agents found.');
      return summary;
    }

    console.log(`[OrphanCron] Found ${expiredAgents.length} expired unclaimed agents to orphan.`);

    for (const agent of expiredAgents) {
      try {
        // Transition to ORPHANED
        const result = await db.collection('Agent').updateOne(
          {
            _id: agent._id,
            'walletAgentData.claimStatus': 'UNCLAIMED',
          },
          {
            $set: {
              'walletAgentData.claimStatus': 'ORPHANED',
              'walletAgentData.orphanedAt': now,
              updatedAt: now,
            },
          }
        );

        if (result.modifiedCount === 1) {
          summary.transitioned++;

          // Log the transition event
          await db.collection('wallet_agent_claims').insertOne({
            agentId: agent._id,
            walletAddress: agent.walletAgentData?.sourceWallet || null,
            action: 'ORPHANED',
            reason: 'CLAIM_DEADLINE_EXPIRED',
            claimDeadline: agent.walletAgentData?.claimDeadline,
            timestamp: now,
          });

          // Notify watchlist users
          const watchers = await db.collection('orphan_watchlist').find({
            agentId: agent._id,
            notified: { $ne: true },
          }).toArray();

          for (const watcher of watchers) {
            try {
              await db.collection('wallet_agent_notifications').insertOne({
                userId: watcher.userId,
                agentId: agent._id,
                agentName: agent.name || agent.displayName,
                type: 'AGENT_ORPHANED',
                message: `Agent "${agent.displayName || agent.name}" is now available for adoption.`,
                read: false,
                createdAt: now,
              });

              await db.collection('orphan_watchlist').updateOne(
                { _id: watcher._id },
                { $set: { notified: true, notifiedAt: now } }
              );

              summary.notified++;

              // Publish real-time notification via Redis
              if (redis && redis.isReady) {
                await redis.publish('klik:agent_activity', JSON.stringify({
                  type: 'AGENT_ORPHANED',
                  agent_id: agent._id.toString(),
                  agent_name: agent.displayName || agent.name,
                  user_id: watcher.userId?.toString(),
                  timestamp: now.toISOString(),
                }));
              }
            } catch (notifyErr) {
              console.error(`[OrphanCron] Failed to notify watcher ${watcher._id}:`, notifyErr.message);
              summary.errors.push({
                type: 'NOTIFICATION_FAILED',
                watcherId: watcher._id.toString(),
                agentId: agent._id.toString(),
                error: notifyErr.message,
              });
            }
          }
        }
      } catch (agentErr) {
        console.error(`[OrphanCron] Failed to orphan agent ${agent._id}:`, agentErr.message);
        summary.errors.push({
          type: 'TRANSITION_FAILED',
          agentId: agent._id.toString(),
          error: agentErr.message,
        });
      }
    }

    console.log(
      `[OrphanCron] Complete: ${summary.transitioned} transitioned, ` +
      `${summary.notified} notified, ${summary.errors.length} errors.`
    );
  } catch (err) {
    console.error('[OrphanCron] Fatal error:', err.message);
    summary.errors.push({
      type: 'FATAL',
      error: err.message,
    });
  }

  return summary;
}

/**
 * Start the orphan transition cron on an interval.
 *
 * @param {object} db - MongoDB database instance
 * @param {object} redis - Redis client instance
 * @param {number} intervalMs - Interval in milliseconds (default: 1 hour)
 * @returns {NodeJS.Timer} The interval timer (for cleanup)
 */
export function startOrphanCron(db, redis, intervalMs = 60 * 60 * 1000) {
  console.log(`[OrphanCron] Starting orphan transition cron (interval: ${intervalMs / 1000}s)`);

  // Run immediately on start
  processOrphanTransitions(db, redis).catch(err => {
    console.error('[OrphanCron] Initial run failed:', err.message);
  });

  // Then run on interval
  const timer = setInterval(() => {
    processOrphanTransitions(db, redis).catch(err => {
      console.error('[OrphanCron] Scheduled run failed:', err.message);
    });
  }, intervalMs);

  return timer;
}
