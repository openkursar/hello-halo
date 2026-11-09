/**
 * Unit tests for CostTracker and pricing utilities.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CostTracker, getPricingForModel, type ModelPricingTable } from './cost.js';

const PRICING: ModelPricingTable = {
  'glm-4.6': { inputPerMtk: 3.0, outputPerMtk: 15.0, cacheCreationPerMtk: 3.75, cacheReadPerMtk: 0.3 },
  'deepseek-chat': { inputPerMtk: 0.27, outputPerMtk: 1.1, cacheCreationPerMtk: 0, cacheReadPerMtk: 0.07 },
  'deepseek-reasoner': { inputPerMtk: 15.0, outputPerMtk: 75.0, cacheCreationPerMtk: 0, cacheReadPerMtk: 1.5 },
};

// ---------------------------------------------------------------------------
// getPricingForModel
// ---------------------------------------------------------------------------

describe('getPricingForModel', () => {
  it('returns the host-supplied entry for an exact model id', () => {
    expect(getPricingForModel('deepseek-chat', PRICING).inputPerMtk).toBe(0.27);
  });

  it('costs a model missing from the table at zero', () => {
    const p = getPricingForModel('unknown-model-xyz', PRICING);
    expect(p).toEqual({ inputPerMtk: 0, outputPerMtk: 0, cacheCreationPerMtk: 0, cacheReadPerMtk: 0 });
  });

  it('ships no prices of its own', () => {
    expect(getPricingForModel('deepseek-chat').inputPerMtk).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — basic accumulation
// ---------------------------------------------------------------------------

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker('glm-4.6', undefined, PRICING);
  });

  it('does not invent usage or poison totals when a provider omits usage', () => {
    tracker.add(undefined);
    tracker.add({ input_tokens: NaN, output_tokens: -1, cache_read_input_tokens: Infinity });
    tracker.add({ output_tokens: 12 } as import('../types/provider.js').UsageInfo);
    expect(tracker.getUsage()).toEqual({ input_tokens: 0, output_tokens: 12,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(Number.isFinite(tracker.totalCostUsd)).toBe(true);
  });

  it('starts at zero', () => {
    expect(tracker.totalCostUsd).toBe(0);
    expect(tracker.totalInputTokens).toBe(0);
    expect(tracker.totalOutputTokens).toBe(0);
  });

  it('accumulates tokens from a single add()', () => {
    tracker.add({ input_tokens: 1000, output_tokens: 500 });
    expect(tracker.totalInputTokens).toBe(1000);
    expect(tracker.totalOutputTokens).toBe(500);
    // cost = (1000 * 3 + 500 * 15) / 1_000_000 = 0.0105
    expect(tracker.totalCostUsd).toBeCloseTo(0.0105, 6);
  });

  it('accumulates tokens across multiple add() calls', () => {
    tracker.add({ input_tokens: 1000, output_tokens: 0 });
    tracker.add({ input_tokens: 2000, output_tokens: 0 });
    expect(tracker.totalInputTokens).toBe(3000);
  });

  it('calculates cost with cache tokens', () => {
    tracker.add({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 0,
    });
    expect(tracker.totalCostUsd).toBeCloseTo(3.75, 4);
  });

  it('counts tokens but no cost when no pricing is supplied', () => {
    const unpriced = new CostTracker('glm-4.6');
    unpriced.add({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(unpriced.totalInputTokens).toBe(1_000_000);
    expect(unpriced.totalCostUsd).toBe(0);
  });

  it('isOverBudget returns true when over limit', () => {
    tracker.add({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(tracker.isOverBudget(0.001)).toBe(true);
  });

  it('isOverBudget returns false when under limit', () => {
    tracker.add({ input_tokens: 100, output_tokens: 100 });
    expect(tracker.isOverBudget(1000)).toBe(false);
  });

  it('reset() clears all counters', () => {
    tracker.add({ input_tokens: 5000, output_tokens: 1000 });
    tracker.reset();
    expect(tracker.totalInputTokens).toBe(0);
    expect(tracker.totalOutputTokens).toBe(0);
    expect(tracker.totalCostUsd).toBe(0);
    expect(Object.keys(tracker.getModelUsage())).toHaveLength(0);
  });

  it('getModelUsage() tracks per-model entry', () => {
    tracker.add({ input_tokens: 1000, output_tokens: 0 }, 'deepseek-reasoner');
    const usage = tracker.getModelUsage();
    expect(usage['deepseek-reasoner']).toBeDefined();
    expect(usage['deepseek-reasoner'].input_tokens).toBe(1000);
  });

  it('does not reprice earlier calls when model changes', () => {
    tracker.add({ input_tokens: 1_000_000, output_tokens: 0 });
    const costBefore = tracker.totalCostUsd;

    tracker.add({ input_tokens: 0, output_tokens: 0 }, 'deepseek-reasoner');
    expect(tracker.totalCostUsd).toBeCloseTo(costBefore, 4);
  });

  it('addChildCost() rolls up child totals', () => {
    const child = new CostTracker('deepseek-chat', undefined, PRICING);
    child.add({ input_tokens: 100_000, output_tokens: 50_000 });

    const parentCostBefore = tracker.totalCostUsd;
    tracker.addChildCost(child);

    expect(tracker.totalCostUsd).toBeGreaterThan(parentCostBefore);
    expect(tracker.totalInputTokens).toBe(100_000);
    expect(tracker.totalOutputTokens).toBe(50_000);
  });

  it('summary() includes token count', () => {
    tracker.add({ input_tokens: 1000, output_tokens: 500 });
    expect(tracker.summary()).toContain('1500');
  });

  it('getUsage() returns flat usage object', () => {
    tracker.add({
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
    });
    const u = tracker.getUsage();
    expect(u.input_tokens).toBe(100);
    expect(u.output_tokens).toBe(200);
    expect(u.cache_creation_input_tokens).toBe(50);
    expect(u.cache_read_input_tokens).toBe(25);
  });
});
