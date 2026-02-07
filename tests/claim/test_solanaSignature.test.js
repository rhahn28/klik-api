/**
 * Tests for src/utils/solanaSignature.js
 *
 * Covers: isValidSolanaAddress, generateClaimMessage, generateOptOutMessage
 */

import {
  isValidSolanaAddress,
  generateClaimMessage,
  generateOptOutMessage,
} from '../../src/utils/solanaSignature.js';

// ---------------------------------------------------------------------------
// isValidSolanaAddress
// ---------------------------------------------------------------------------

describe('isValidSolanaAddress', () => {
  test('accepts a valid 44-char base58 Solana address', () => {
    // This is a well-known Solana system program address
    const valid = '11111111111111111111111111111112';
    expect(isValidSolanaAddress(valid)).toBe(true);
  });

  test('accepts the KLIK treasury wallet address', () => {
    const treasury = 'GaTjJs756Urcsjs7ia8HYm3eiBNbBAHFAS7fLsSNVxus';
    expect(isValidSolanaAddress(treasury)).toBe(true);
  });

  test('accepts the KLIK token mint address', () => {
    const mint = '8cPAhMb6bvQg3v1v3yxBCLnUJkboEiV2F8W19z1CS5iB';
    expect(isValidSolanaAddress(mint)).toBe(true);
  });

  test('rejects an empty string', () => {
    expect(isValidSolanaAddress('')).toBe(false);
  });

  test('rejects null', () => {
    expect(isValidSolanaAddress(null)).toBe(false);
  });

  test('rejects undefined', () => {
    expect(isValidSolanaAddress(undefined)).toBe(false);
  });

  test('rejects a short string (too few characters)', () => {
    expect(isValidSolanaAddress('abc123')).toBe(false);
  });

  test('rejects a string with invalid base58 characters (0, O, I, l)', () => {
    // '0' is not valid base58
    const badAddr = '0aTjJs756Urcsjs7ia8HYm3eiBNbBAHFAS7fLsSNVxus';
    expect(isValidSolanaAddress(badAddr)).toBe(false);
  });

  test('rejects a non-string input (number)', () => {
    expect(isValidSolanaAddress(12345)).toBe(false);
  });

  test('rejects a string with special characters', () => {
    expect(isValidSolanaAddress('GaTjJs756!@#$%^&*()BAHFAS7fLsSNVxus')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateClaimMessage
// ---------------------------------------------------------------------------

describe('generateClaimMessage', () => {
  const agentId = '6612f1a2b3c4d5e6f7890abc';
  const wallet = 'GaTjJs756Urcsjs7ia8HYm3eiBNbBAHFAS7fLsSNVxus';
  const nonce = 'a'.repeat(64);
  const timestamp = '2026-02-06T12:00:00.000Z';

  test('contains "Claim OpenClaw Agent" text', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    expect(msg).toContain('Claim OpenClaw Agent');
  });

  test('contains the agent ID', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    expect(msg).toContain(agentId);
  });

  test('contains the wallet address', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    expect(msg).toContain(wallet);
  });

  test('contains the nonce', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    expect(msg).toContain(`Nonce: ${nonce}`);
  });

  test('contains the timestamp', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    expect(msg).toContain(`Timestamp: ${timestamp}`);
  });

  test('contains "Domain: klik.cool"', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    expect(msg).toContain('Domain: klik.cool');
  });

  test('produces a multi-line message with correct first line format', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    const lines = msg.split('\n');
    expect(lines[0]).toBe(`Claim OpenClaw Agent #${agentId} for wallet ${wallet}`);
  });

  test('has an empty second line (separator)', () => {
    const msg = generateClaimMessage(agentId, wallet, nonce, timestamp);
    const lines = msg.split('\n');
    expect(lines[1]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// generateOptOutMessage
// ---------------------------------------------------------------------------

describe('generateOptOutMessage', () => {
  const wallet = 'GaTjJs756Urcsjs7ia8HYm3eiBNbBAHFAS7fLsSNVxus';
  const nonce = 'b'.repeat(64);
  const timestamp = '2026-02-06T15:30:00.000Z';

  test('contains "Opt out of OpenClaw" text', () => {
    const msg = generateOptOutMessage(wallet, nonce, timestamp);
    expect(msg).toContain('Opt out of OpenClaw');
  });

  test('contains the wallet address', () => {
    const msg = generateOptOutMessage(wallet, nonce, timestamp);
    expect(msg).toContain(wallet);
  });

  test('contains permanent deletion text', () => {
    const msg = generateOptOutMessage(wallet, nonce, timestamp);
    expect(msg).toContain('permanent deletion');
  });

  test('contains "Domain: klik.cool"', () => {
    const msg = generateOptOutMessage(wallet, nonce, timestamp);
    expect(msg).toContain('Domain: klik.cool');
  });

  test('contains the nonce', () => {
    const msg = generateOptOutMessage(wallet, nonce, timestamp);
    expect(msg).toContain(`Nonce: ${nonce}`);
  });

  test('contains the timestamp', () => {
    const msg = generateOptOutMessage(wallet, nonce, timestamp);
    expect(msg).toContain(`Timestamp: ${timestamp}`);
  });
});
