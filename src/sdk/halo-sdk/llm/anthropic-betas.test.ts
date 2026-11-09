import { describe, it, expect } from 'vitest';
import { buildBetas } from './anthropic-betas.js';

describe('Anthropic beta selection', () => {
  it('does not opt ordinary requests into beta features', () => {
    expect(buildBetas()).toEqual([]);
  });

  it('does not derive beta opt-ins from retired caching, effort or tool-format switches', () => {
    const options = {
      extraBetas: [], enableCaching: true, enableEffort: true,
      hasThinking: true, enableTokenEfficientTools: true,
    };
    expect(buildBetas(options)).toEqual([]);
  });

  it('keeps public opt-ins for features the request actually selects', () => {
    expect(buildBetas({
      enableInterleavedThinking: true,
      enableContextManagement: true,
      enable1mContext: true,
      enableTaskBudgets: true,
    })).toEqual([
      'interleaved-thinking-2025-05-14',
      'context-management-2025-06-27',
      'context-1m-2025-08-07',
      'task-budgets-2026-03-13',
    ]);
  });

  it('preserves caller-supplied strings and deduplicates them', () => {
    expect(buildBetas({
      enable1mContext: true,
      extraBetas: ['caller-feature-2099-01-01', 'context-1m-2025-08-07', '', 'caller-feature-2099-01-01'],
    })).toEqual(['context-1m-2025-08-07', 'caller-feature-2099-01-01']);
  });
});
