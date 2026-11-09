/** Anthropic-specific opt-ins; stable caching and effort need no beta header. */

export const BETA_CONTEXT_1M = 'context-1m-2025-08-07';

export interface BuildBetasOptions {
  enableInterleavedThinking?: boolean;
  enableContextManagement?: boolean;
  enable1mContext?: boolean;
  enableTaskBudgets?: boolean;
  extraBetas?: string[];
}

export function buildBetas(options: BuildBetasOptions = {}): string[] {
  const betas = [
    ...(options.enableInterleavedThinking ? ['interleaved-thinking-2025-05-14'] : []),
    ...(options.enableContextManagement ? ['context-management-2025-06-27'] : []),
    ...(options.enable1mContext ? [BETA_CONTEXT_1M] : []),
    ...(options.enableTaskBudgets ? ['task-budgets-2026-03-13'] : []),
    ...(options.extraBetas ?? []),
  ];
  return [...new Set(betas.filter(Boolean))];
}
