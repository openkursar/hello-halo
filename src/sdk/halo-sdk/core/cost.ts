/**
 * @module core/cost
 * CostTracker and ModelPricing for budget tracking and enforcement.
 * @license MIT
 */

import type { UsageInfo } from '../types/provider.js';
import { DEFAULT_CONTEXT_WINDOW } from '../prompt/constants.js';

// ---------------------------------------------------------------------------
// ModelPricing — per-model token pricing in USD per million tokens
// ---------------------------------------------------------------------------

/** Per-model pricing tiers (USD per million tokens). */
export interface ModelPricing {
  /** Cost per million input tokens */
  inputPerMtk: number;
  /** Cost per million output tokens */
  outputPerMtk: number;
  /** Cost per million cache-creation input tokens */
  cacheCreationPerMtk: number;
  /** Cost per million cache-read input tokens */
  cacheReadPerMtk: number;
}

/** Host-supplied pricing, keyed by exact model id. */
export type ModelPricingTable = Record<string, ModelPricing>;

const ZERO_PRICING: ModelPricing = {
  inputPerMtk: 0,
  outputPerMtk: 0,
  cacheCreationPerMtk: 0,
  cacheReadPerMtk: 0,
};

/**
 * Look up a model's pricing in the host-supplied table. The SDK ships no
 * prices of its own; a model missing from the table is costed at zero.
 */
export function getPricingForModel(model: string, table: ModelPricingTable = {}): ModelPricing {
  return table[model] ?? ZERO_PRICING;
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

/**
 * Tracks accumulated token usage and cost across a session.
 * Used for budget enforcement via `maxBudgetUsd`.
 */
/** Per-model usage entry for modelUsage tracking. */
export interface ModelUsageEntry {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
  /** Context window the session budgeted against, in tokens. */
  contextWindow: number;
}

export class CostTracker {
  private _inputTokens = 0;
  private _outputTokens = 0;
  private _cacheCreationTokens = 0;
  private _cacheReadTokens = 0;
  /** Running total cost in USD, accumulated per-call with correct pricing. */
  private _totalCostUsd = 0;
  private _pricing: ModelPricing;
  private _pricingTable: ModelPricingTable;
  private _contextWindow: number;
  private _modelUsage = new Map<string, ModelUsageEntry>();
  private readonly onUsage?: (usage: ModelUsageEntry, model: string) => void;

  constructor(
    model: string,
    contextWindow = DEFAULT_CONTEXT_WINDOW,
    pricingTable: ModelPricingTable = {},
    onUsage?: (usage: ModelUsageEntry, model: string) => void,
  ) {
    this.onUsage = onUsage;
    this._pricingTable = pricingTable;
    this._pricing = getPricingForModel(model, pricingTable);
    this._contextWindow = contextWindow;
  }

  /** Update the pricing tier for a new model. */
  setModel(model: string): void {
    this._pricing = getPricingForModel(model, this._pricingTable);
  }

  /**
   * Record token usage from a provider response.
   * @param usage - Usage info from the provider response
   * @param model - Optional model override for pricing lookup
   */
  add(usage: UsageInfo | undefined, model?: string): void {
    if (model) {
      this._pricing = getPricingForModel(model, this._pricingTable);
    }
    const reported = (value: number | undefined): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    const input = reported(usage?.input_tokens);
    const output = reported(usage?.output_tokens);
    const cacheCreation = reported(usage?.cache_creation_input_tokens);
    const cacheRead = reported(usage?.cache_read_input_tokens);

    this._inputTokens += input;
    this._outputTokens += output;
    this._cacheCreationTokens += cacheCreation;
    this._cacheReadTokens += cacheRead;

    // Track per-model usage
    const modelKey = model ?? 'unknown';
    const existing = this._modelUsage.get(modelKey);
    const pricing = model ? getPricingForModel(model, this._pricingTable) : this._pricing;
    const callCost =
      (input * pricing.inputPerMtk +
        output * pricing.outputPerMtk +
        cacheCreation * pricing.cacheCreationPerMtk +
        cacheRead * pricing.cacheReadPerMtk) /
      1_000_000;

    // Accumulate total cost per-call so model switches don't retroactively reprice history
    this._totalCostUsd += callCost;

    if (existing) {
      existing.input_tokens += input;
      existing.output_tokens += output;
      existing.cache_creation_input_tokens += cacheCreation;
      existing.cache_read_input_tokens += cacheRead;
      existing.total_cost_usd += callCost;
    } else {
      this._modelUsage.set(modelKey, {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        total_cost_usd: callCost,
        contextWindow: this._contextWindow,
      });
    }
    this.onUsage?.({
      input_tokens: input, output_tokens: output,
      cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead,
      total_cost_usd: callCost, contextWindow: this._contextWindow,
    }, modelKey);
  }

  /** Roll up already-accounted work without charging the shared execution budget again. */
  addReportedUsage(entries: Record<string, ModelUsageEntry>): void {
    for (const [model, entry] of Object.entries(entries)) {
      this._inputTokens += entry.input_tokens;
      this._outputTokens += entry.output_tokens;
      this._cacheCreationTokens += entry.cache_creation_input_tokens;
      this._cacheReadTokens += entry.cache_read_input_tokens;
      this._totalCostUsd += entry.total_cost_usd;
      const existing = this._modelUsage.get(model);
      if (existing) {
        existing.input_tokens += entry.input_tokens;
        existing.output_tokens += entry.output_tokens;
        existing.cache_creation_input_tokens += entry.cache_creation_input_tokens;
        existing.cache_read_input_tokens += entry.cache_read_input_tokens;
        existing.total_cost_usd += entry.total_cost_usd;
      } else this._modelUsage.set(model, { ...entry });
    }
  }

  /** Total accumulated cost in USD. */
  get totalCostUsd(): number {
    return this._totalCostUsd;
  }

  /** Total input tokens recorded. */
  get totalInputTokens(): number {
    return this._inputTokens;
  }

  /** Total output tokens recorded. */
  get totalOutputTokens(): number {
    return this._outputTokens;
  }

  /** Total cache creation tokens recorded. */
  get totalCacheCreationTokens(): number {
    return this._cacheCreationTokens;
  }

  /** Total cache read tokens recorded. */
  get totalCacheReadTokens(): number {
    return this._cacheReadTokens;
  }

  /** Total tokens across all categories. */
  get totalTokens(): number {
    return (
      this._inputTokens +
      this._outputTokens +
      this._cacheCreationTokens +
      this._cacheReadTokens
    );
  }

  /** Check whether the accumulated cost exceeds a budget. */
  isOverBudget(maxBudgetUsd: number): boolean {
    return this.totalCostUsd >= maxBudgetUsd;
  }

  /** Reset all counters to zero. */
  reset(): void {
    this._inputTokens = 0;
    this._outputTokens = 0;
    this._cacheCreationTokens = 0;
    this._cacheReadTokens = 0;
    this._totalCostUsd = 0;
    this._modelUsage.clear();
  }

  /** Get cumulative usage as a flat object. */
  getUsage(): {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } {
    return {
      input_tokens: this._inputTokens,
      output_tokens: this._outputTokens,
      cache_creation_input_tokens: this._cacheCreationTokens,
      cache_read_input_tokens: this._cacheReadTokens,
    };
  }

  /** Get per-model usage as a plain record. */
  getModelUsage(): Record<string, ModelUsageEntry> {
    const result: Record<string, ModelUsageEntry> = {};
    for (const [key, entry] of this._modelUsage) {
      result[key] = { ...entry };
    }
    return result;
  }

  /**
   * Combine usage already accounted by another execution tracker.
   */
  addChildCost(child: CostTracker): void {
    this._inputTokens += child.totalInputTokens;
    this._outputTokens += child.totalOutputTokens;
    this._cacheCreationTokens += child.totalCacheCreationTokens;
    this._cacheReadTokens += child.totalCacheReadTokens;
    this._totalCostUsd += child.totalCostUsd;

    // Merge per-model usage
    for (const [modelKey, childEntry] of Object.entries(child.getModelUsage())) {
      const existing = this._modelUsage.get(modelKey);
      if (existing) {
        existing.input_tokens += childEntry.input_tokens;
        existing.output_tokens += childEntry.output_tokens;
        existing.cache_creation_input_tokens +=
          childEntry.cache_creation_input_tokens;
        existing.cache_read_input_tokens += childEntry.cache_read_input_tokens;
        existing.total_cost_usd += childEntry.total_cost_usd;
      } else {
        this._modelUsage.set(modelKey, { ...childEntry });
      }
    }
  }

  /** Human-readable summary string. */
  summary(): string {
    const cost = this.totalCostUsd;
    const total = this.totalTokens;
    if (cost < 0.01) {
      return `${total} tokens (<$0.01)`;
    }
    return `${total} tokens ($${cost.toFixed(2)})`;
  }
}
