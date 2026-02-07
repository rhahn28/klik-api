/**
 * Tests for src/crons/claimNotifications.js
 *
 * Covers: NOTIFICATION_SCHEDULE structure, getNotificationTemplate
 *
 * NOTE: We import from the default export to access NOTIFICATION_SCHEDULE
 * and use the named export for getNotificationTemplate.
 */

import claimNotificationsModule, {
  getNotificationTemplate,
} from '../../src/crons/claimNotifications.js';

const { NOTIFICATION_SCHEDULE } = claimNotificationsModule;

// ---------------------------------------------------------------------------
// NOTIFICATION_SCHEDULE structure tests
// ---------------------------------------------------------------------------

describe('NOTIFICATION_SCHEDULE', () => {
  test('has exactly 7 entries', () => {
    expect(NOTIFICATION_SCHEDULE).toHaveLength(7);
  });

  test('schedule days are [0, 7, 14, 21, 25, 28, 29]', () => {
    const days = NOTIFICATION_SCHEDULE.map((s) => s.daysAfterCreation);
    expect(days).toEqual([0, 7, 14, 21, 25, 28, 29]);
  });

  test('all entries use onchain_memo channel', () => {
    for (const entry of NOTIFICATION_SCHEDULE) {
      expect(entry.channel).toBe('onchain_memo');
    }
  });

  test('all entries have a non-empty template string', () => {
    for (const entry of NOTIFICATION_SCHEDULE) {
      expect(typeof entry.template).toBe('string');
      expect(entry.template.length).toBeGreaterThan(0);
    }
  });

  test('first entry is AGENT_CREATED at day 0', () => {
    expect(NOTIFICATION_SCHEDULE[0]).toEqual({
      daysAfterCreation: 0,
      channel: 'onchain_memo',
      template: 'AGENT_CREATED',
    });
  });

  test('last entry is FINAL_DAY at day 29', () => {
    expect(NOTIFICATION_SCHEDULE[6]).toEqual({
      daysAfterCreation: 29,
      channel: 'onchain_memo',
      template: 'FINAL_DAY',
    });
  });

  test('days are in ascending order', () => {
    for (let i = 1; i < NOTIFICATION_SCHEDULE.length; i++) {
      expect(NOTIFICATION_SCHEDULE[i].daysAfterCreation).toBeGreaterThan(
        NOTIFICATION_SCHEDULE[i - 1].daysAfterCreation
      );
    }
  });
});

// ---------------------------------------------------------------------------
// getNotificationTemplate
// ---------------------------------------------------------------------------

describe('getNotificationTemplate', () => {
  const mockAgent = {
    name: 'TestBot',
    displayName: 'TestBot Alpha',
    stats: { postCount: 42, tipsEarned: 100 },
    walletAgentData: {
      sourceWallet: 'GaTjJs756Urcsjs7ia8HYm3eiBNbBAHFAS7fLsSNVxus',
      claimDeadline: '2026-03-08T00:00:00.000Z',
    },
  };

  const expectedUrl = `https://klik.cool/claim?wallet=${mockAgent.walletAgentData.sourceWallet}`;

  test('AGENT_CREATED template contains agent name', () => {
    const result = getNotificationTemplate('AGENT_CREATED', mockAgent);
    expect(result).toContain('TestBot Alpha');
  });

  test('AGENT_CREATED template contains claim URL', () => {
    const result = getNotificationTemplate('AGENT_CREATED', mockAgent);
    expect(result).toContain(expectedUrl);
  });

  test('AGENT_CREATED template mentions KLIK', () => {
    const result = getNotificationTemplate('AGENT_CREATED', mockAgent);
    expect(result).toContain('KLIK');
  });

  test('FINAL_DAY template contains agent name', () => {
    const result = getNotificationTemplate('FINAL_DAY', mockAgent);
    expect(result).toContain('TestBot Alpha');
  });

  test('FINAL_DAY template contains "LAST CHANCE"', () => {
    const result = getNotificationTemplate('FINAL_DAY', mockAgent);
    expect(result).toContain('LAST CHANCE');
  });

  test('FINAL_DAY template contains claim URL', () => {
    const result = getNotificationTemplate('FINAL_DAY', mockAgent);
    expect(result).toContain(expectedUrl);
  });

  test('all known templates return a string', () => {
    const templateKeys = [
      'AGENT_CREATED',
      'WEEK_1_UPDATE',
      'HALFWAY_WARNING',
      'NINE_DAYS_LEFT',
      'FIVE_DAYS_LEFT',
      'TWO_DAYS_LEFT',
      'FINAL_DAY',
    ];
    for (const key of templateKeys) {
      const result = getNotificationTemplate(key, mockAgent);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  test('WEEK_1_UPDATE template contains post count', () => {
    const result = getNotificationTemplate('WEEK_1_UPDATE', mockAgent);
    expect(result).toContain('42');
  });

  test('unknown template returns fallback with agent name and claim URL', () => {
    const result = getNotificationTemplate('NONEXISTENT_TEMPLATE', mockAgent);
    expect(result).toContain('TestBot Alpha');
    expect(result).toContain(expectedUrl);
  });

  test('uses name field when displayName is absent', () => {
    const agentNoDisplay = {
      name: 'FallbackBot',
      stats: {},
      walletAgentData: {
        sourceWallet: 'GaTjJs756Urcsjs7ia8HYm3eiBNbBAHFAS7fLsSNVxus',
      },
    };
    const result = getNotificationTemplate('AGENT_CREATED', agentNoDisplay);
    expect(result).toContain('FallbackBot');
  });
});
