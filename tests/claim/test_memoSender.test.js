/**
 * Tests for src/services/memoSender.js
 *
 * Covers: estimateBatchCost (pure function, no network/env deps)
 */

import { estimateBatchCost } from '../../src/services/memoSender.js';

// ---------------------------------------------------------------------------
// estimateBatchCost
// ---------------------------------------------------------------------------

describe('estimateBatchCost', () => {
  test('returns correct totalLamports for count=1', () => {
    const result = estimateBatchCost(1);
    expect(result.totalLamports).toBe(10000);
  });

  test('returns correct totalSol for count=1', () => {
    const result = estimateBatchCost(1);
    expect(result.totalSol).toBe(0.00001);
  });

  test('returns correct totalUsd for count=1', () => {
    const result = estimateBatchCost(1);
    // 0.00001 SOL * 150 = 0.0015 => rounded to 0.00
    expect(result.totalUsd).toBe(0);
  });

  test('returns correct values for count=10000', () => {
    const result = estimateBatchCost(10000);
    expect(result.totalLamports).toBe(100_000_000);
    expect(result.totalSol).toBe(0.1);
    expect(result.totalUsd).toBe(15);
  });

  test('result includes all required fields', () => {
    const result = estimateBatchCost(5);
    expect(result).toHaveProperty('totalLamports');
    expect(result).toHaveProperty('totalSol');
    expect(result).toHaveProperty('totalUsd');
    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('perTxLamports');
  });

  test('count field matches input', () => {
    const result = estimateBatchCost(42);
    expect(result.count).toBe(42);
  });

  test('perTxLamports is 10000', () => {
    const result = estimateBatchCost(1);
    expect(result.perTxLamports).toBe(10000);
  });

  test('cost scales linearly (double count = double cost)', () => {
    const cost100 = estimateBatchCost(100);
    const cost200 = estimateBatchCost(200);
    expect(cost200.totalLamports).toBe(cost100.totalLamports * 2);
    expect(cost200.totalSol).toBeCloseTo(cost100.totalSol * 2, 10);
  });

  test('returns zero costs for count=0', () => {
    const result = estimateBatchCost(0);
    expect(result.totalLamports).toBe(0);
    expect(result.totalSol).toBe(0);
    expect(result.totalUsd).toBe(0);
    expect(result.count).toBe(0);
  });

  test('handles large batch count (1 million)', () => {
    const result = estimateBatchCost(1_000_000);
    expect(result.totalLamports).toBe(10_000_000_000);
    expect(result.totalSol).toBe(10);
    expect(result.totalUsd).toBe(1500);
  });
});
