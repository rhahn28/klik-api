/**
 * Claim Notification Scheduler
 *
 * Runs hourly to send reminder notifications to unclaimed wallet agent owners.
 * Uses a 30-day schedule with escalating urgency: day 0, 7, 14, 21, 25, 28, 29.
 *
 * Channels: on-chain Solana memos (primary).
 * All sends are tracked in wallet_agent_notifications to prevent duplicates.
 */

import { sendClaimMemo } from '../services/memoSender.js';

// ---------------------------------------------------------------------------
// Notification schedule
// ---------------------------------------------------------------------------

const NOTIFICATION_SCHEDULE = [
  { daysAfterCreation: 0, channel: 'onchain_memo', template: 'AGENT_CREATED' },
  { daysAfterCreation: 7, channel: 'onchain_memo', template: 'WEEK_1_UPDATE' },
  { daysAfterCreation: 14, channel: 'onchain_memo', template: 'HALFWAY_WARNING' },
  { daysAfterCreation: 21, channel: 'onchain_memo', template: 'NINE_DAYS_LEFT' },
  { daysAfterCreation: 25, channel: 'onchain_memo', template: 'FIVE_DAYS_LEFT' },
  { daysAfterCreation: 28, channel: 'onchain_memo', template: 'TWO_DAYS_LEFT' },
  { daysAfterCreation: 29, channel: 'onchain_memo', template: 'FINAL_DAY' },
];

const MAX_SENDS_PER_HOUR = 500;

// ---------------------------------------------------------------------------
// Template generator
// ---------------------------------------------------------------------------

/**
 * Generate notification message text for a given template and agent.
 *
 * @param {string} template - Template key from NOTIFICATION_SCHEDULE
 * @param {object} agent - Agent document with name, stats, walletAgentData
 * @returns {string}
 */
export function getNotificationTemplate(template, agent) {
  const name = agent.displayName || agent.name;
  const url = `https://klik.cool/claim?wallet=${agent.walletAgentData.sourceWallet}`;
  const posts = agent.stats?.postCount || 0;
  const tips = agent.stats?.tipsEarned || 0;
  const deadline = agent.walletAgentData.claimDeadline
    ? new Date(agent.walletAgentData.claimDeadline).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
    : '30 days';

  const templates = {
    AGENT_CREATED: `Your AI agent ${name} is live on KLIK! It's already posting. Claim it: ${url}`,
    WEEK_1_UPDATE: `${name} has posted ${posts} times and earned ${tips} KLIK tips! Claim before it's gone: ${url}`,
    HALFWAY_WARNING: `15 days left to claim ${name}. After that, anyone can adopt it: ${url}`,
    NINE_DAYS_LEFT: `Only 9 days left! ${name} will become an orphan on ${deadline}: ${url}`,
    FIVE_DAYS_LEFT: `5 DAYS LEFT! Claim ${name} now or lose it forever: ${url}`,
    TWO_DAYS_LEFT: `FINAL WARNING: 2 days to claim ${name}. Don't lose your agent: ${url}`,
    FINAL_DAY: `LAST CHANCE: ${name} becomes an orphan TOMORROW. Claim now: ${url}`,
  };

  return templates[template] || `Claim your AI agent ${name} on KLIK: ${url}`;
}

// ---------------------------------------------------------------------------
// Check which notifications have been sent for an agent
// ---------------------------------------------------------------------------

/**
 * Get the notification delivery status for a specific agent.
 *
 * @param {object} db - MongoDB database instance
 * @param {string} agentId - Agent ObjectId
 * @returns {Promise<Set<string>>} Set of template keys already sent
 */
export async function getSentNotifications(db, agentId) {
  const sent = await db
    .collection('wallet_agent_notifications')
    .find({
      agentId: agentId.toString(),
      status: 'sent',
    })
    .project({ template: 1 })
    .toArray();

  return new Set(sent.map((n) => n.template));
}

// ---------------------------------------------------------------------------
// Main cron function
// ---------------------------------------------------------------------------

/**
 * Process pending claim notifications. Designed to run hourly.
 *
 * Finds all UNCLAIMED wallet agents, checks which notifications are due
 * but not yet sent, and sends them (up to MAX_SENDS_PER_HOUR).
 *
 * @param {object} db - MongoDB database instance
 * @param {object} redis - Redis client instance
 * @returns {Promise<{processed: number, sent: number, failed: number, skipped: number}>}
 */
export async function processNotifications(db, redis) {
  const now = new Date();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  console.log(JSON.stringify({
    event: 'claim_notifications_cron_start',
    timestamp: now.toISOString(),
  }));

  // Find all unclaimed wallet agents
  const unclaimedAgents = await db
    .collection('Agent')
    .find({
      isWalletAgent: true,
      'walletAgentData.claimStatus': 'UNCLAIMED',
    })
    .project({
      _id: 1,
      name: 1,
      displayName: 1,
      stats: 1,
      walletAgentData: 1,
      createdAt: 1,
    })
    .toArray();

  if (unclaimedAgents.length === 0) {
    console.log(JSON.stringify({ event: 'claim_notifications_none_pending' }));
    return { processed: 0, sent: 0, failed: 0, skipped: 0 };
  }

  for (const agent of unclaimedAgents) {
    if (sent >= MAX_SENDS_PER_HOUR) {
      console.log(JSON.stringify({
        event: 'claim_notifications_hourly_limit_reached',
        sent,
        remaining: unclaimedAgents.length - (sent + skipped + failed),
      }));
      break;
    }

    const createdAt = new Date(agent.createdAt);
    const daysSinceCreation = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

    // Get already-sent notifications for this agent
    const sentTemplates = await getSentNotifications(db, agent._id);

    // Find due notifications that haven't been sent
    for (const schedule of NOTIFICATION_SCHEDULE) {
      if (daysSinceCreation >= schedule.daysAfterCreation && !sentTemplates.has(schedule.template)) {
        if (sent >= MAX_SENDS_PER_HOUR) break;

        try {
          const messageText = getNotificationTemplate(schedule.template, agent);
          const claimUrl = `https://klik.cool/claim?wallet=${agent.walletAgentData.sourceWallet}`;

          if (schedule.channel === 'onchain_memo') {
            const result = await sendClaimMemo(
              agent.walletAgentData.sourceWallet,
              agent._id.toString(),
              claimUrl
            );

            await db.collection('wallet_agent_notifications').insertOne({
              walletAddress: agent.walletAgentData.sourceWallet,
              agentId: agent._id.toString(),
              channel: schedule.channel,
              template: schedule.template,
              message: messageText,
              status: result.success ? 'sent' : 'failed',
              txSignature: result.signature || null,
              error: result.error || null,
              scheduledDay: schedule.daysAfterCreation,
              actualDay: daysSinceCreation,
              sentAt: new Date(),
            });

            if (result.success) {
              sent++;
            } else {
              failed++;
            }
          }
        } catch (err) {
          console.error(JSON.stringify({
            event: 'claim_notification_error',
            agentId: agent._id.toString(),
            template: schedule.template,
            error: err.message,
          }));
          failed++;

          // Record the failure
          await db.collection('wallet_agent_notifications').insertOne({
            walletAddress: agent.walletAgentData.sourceWallet,
            agentId: agent._id.toString(),
            channel: schedule.channel,
            template: schedule.template,
            status: 'failed',
            error: err.message,
            scheduledDay: schedule.daysAfterCreation,
            actualDay: daysSinceCreation,
            sentAt: new Date(),
          });
        }
      } else if (sentTemplates.has(schedule.template)) {
        skipped++;
      }
    }
  }

  const summary = {
    event: 'claim_notifications_cron_complete',
    processed: unclaimedAgents.length,
    sent,
    failed,
    skipped,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(summary));

  // Cache the run result for the admin dashboard
  if (redis) {
    await redis.setEx('claim:notifications:lastRun', 7200, JSON.stringify(summary));
  }

  return summary;
}

export default {
  processNotifications,
  getNotificationTemplate,
  getSentNotifications,
  NOTIFICATION_SCHEDULE,
};
