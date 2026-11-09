import type { Options } from '../types/config.js';
import type { ModelUsageEntry } from './cost.js';

/** One source request owns this ledger; delegated sessions borrow it without resetting it. */
export class ExecutionBudget {
  private spentValue = 0;
  private totalValue = 0;
  observe(usage: ModelUsageEntry): void {
    this.spentValue += usage.total_cost_usd;
    this.totalValue += usage.total_cost_usd;
  }
  get spent(): number { return this.spentValue; }
  get total(): number { return this.totalValue; }
  resetRequest(): void { this.spentValue = 0; }
}

const budgets = new WeakMap<Options, ExecutionBudget>();

export function bindExecutionBudget(options: Options, budget: ExecutionBudget): void { budgets.set(options, budget); }
export function executionBudget(options: Options): ExecutionBudget | undefined { return budgets.get(options); }
