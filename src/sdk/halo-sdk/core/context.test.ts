/**
 * Unit tests for resolveQueryConfig.
 */

import { describe, it, expect } from 'vitest';
import { resolveQueryConfig } from './context.js';
import type { Options } from '../types/config.js';
import { DEFAULT_CONTEXT_WINDOW } from '../prompt/constants.js';

function resolve(options: Partial<Options> = {}) {
  return resolveQueryConfig({ model: 'deepseek-chat', ...options } as Options);
}

describe('resolveQueryConfig — read-deny rules', () => {
  it('resolves Read(...) rules against cwd and leaves tool names alone', () => {
    const cfg = resolve({ cwd: '/srv/ws', disallowedTools: ['Bash', 'Read(//srv/ws/.halo/runs/**)', 'Read(notes)'] });
    expect(cfg.readDenyRoots).toEqual(['/srv/ws/.halo/runs', '/srv/ws/notes']);
    expect(cfg.disallowedTools).toEqual(['Bash', 'Read(//srv/ws/.halo/runs/**)', 'Read(notes)']);
  });

  it('closes nothing without rules', () => {
    expect(resolve().readDenyRoots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveQueryConfig — defaults
// ---------------------------------------------------------------------------

describe('resolveQueryConfig — defaults', () => {
  it('throws when no model is provided', () => {
    expect(() => resolveQueryConfig({} as Options)).toThrow(/model is required/);
  });

  it('applies provided model', () => {
    const cfg = resolve({ model: 'glm-4.6' });
    expect(cfg.model).toBe('glm-4.6');
  });

  it('preserves serializable prompt selection without changing protocol selection', () => {
    const promptProfile = { default: 'default' as const, models: { alias: 'explicit' as const } };
    const cfg = resolve({ model: 'alias', promptProfile, toolCallingMode: 'json' });
    expect(cfg.promptProfile).toEqual(promptProfile);
    expect(cfg.toolCallingMode).toBe('json');
    expect(resolve().promptProfile).toBeUndefined();
  });

  it('sets maxTokens to 16384', () => {
    expect(resolve().maxTokens).toBe(16384);
  });

  it('applies default maxTurns of 100', () => {
    expect(resolve().maxTurns).toBe(100);
  });

  it('applies provided maxTurns', () => {
    expect(resolve({ maxTurns: 5 }).maxTurns).toBe(5);
  });

  it('applies default maxBudgetUsd of Infinity', () => {
    expect(resolve().maxBudgetUsd).toBe(Infinity);
  });

  it('applies provided maxBudgetUsd', () => {
    expect(resolve({ maxBudgetUsd: 1.5 }).maxBudgetUsd).toBe(1.5);
  });

  it('defaults cwd to process.cwd()', () => {
    expect(resolve().cwd).toBe(process.cwd());
  });

  it('applies provided cwd', () => {
    expect(resolve({ cwd: '/tmp/test' }).cwd).toBe('/tmp/test');
  });

  it('defaults env to {}', () => {
    expect(resolve().env).toEqual({});
  });

  it('applies provided env', () => {
    expect(resolve({ env: { FOO: 'bar' } }).env).toEqual({ FOO: 'bar' });
  });

  it('defaults systemPrompt to the default preset', () => {
    expect(resolve().systemPrompt).toEqual({ type: 'preset', preset: 'default' });
  });

  it('applies custom systemPrompt', () => {
    const cfg = resolve({
      systemPrompt: { type: 'custom', value: 'Be helpful' },
    } as unknown as Partial<Options>);
    expect(cfg.systemPrompt).toEqual({ type: 'custom', value: 'Be helpful' });
  });

  it('defaults effort to high', () => {
    expect(resolve().effort).toBe('high');
  });

  it('applies provided effort level', () => {
    expect(resolve({ effort: 'max' }).effort).toBe('max');
  });

  it('defaults toolResultBudget to 50000', () => {
    expect(resolve().toolResultBudget).toBe(50_000);
  });

  it('defaults includePartialMessages to false', () => {
    expect(resolve().includePartialMessages).toBe(false);
  });

  it('defaults permissionMode to default', () => {
    expect(resolve().permissionMode).toBe('default');
  });

  it('applies provided permissionMode', () => {
    expect(resolve({ permissionMode: 'bypassPermissions' }).permissionMode).toBe('bypassPermissions');
  });

  it('creates abortSignal when no abortController is provided', () => {
    const cfg = resolve();
    expect(cfg.abortSignal).toBeInstanceOf(AbortSignal);
    expect(cfg.abortSignal.aborted).toBe(false);
  });

  it('uses provided abortController signal', () => {
    const ac = new AbortController();
    ac.abort();
    expect(resolve({ abortController: ac }).abortSignal.aborted).toBe(true);
  });

  it('passes through optional fields as undefined when not provided', () => {
    const cfg = resolve();
    expect(cfg.allowedTools).toBeUndefined();
    expect(cfg.disallowedTools).toBeUndefined();
    expect(cfg).not.toHaveProperty('agents');
    expect(cfg.mcpServers).toBeUndefined();
    expect(cfg.hooks).toBeUndefined();
    expect(cfg.canUseTool).toBeUndefined();
    expect(cfg.fallbackModel).toBeUndefined();
    expect(cfg.betas).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveQueryConfig — thinking resolution
// ---------------------------------------------------------------------------

describe('resolveQueryConfig — thinking', () => {
  it('defaults to disabled thinking', () => {
    expect(resolve().thinking).toEqual({ type: 'disabled' });
  });

  it('uses explicit thinking config when provided', () => {
    const cfg = resolve({ thinking: { type: 'enabled', budgetTokens: 5000 } });
    expect(cfg.thinking).toEqual({ type: 'enabled', budgetTokens: 5000 });
  });

  it('explicit thinking config takes precedence over maxThinkingTokens', () => {
    const cfg = resolve({
      thinking: { type: 'enabled', budgetTokens: 3000 },
      maxThinkingTokens: 9000,
    });
    expect(cfg.thinking).toEqual({ type: 'enabled', budgetTokens: 3000 });
  });

  it('maxThinkingTokens > 0 → enabled with budget, regardless of model', () => {
    for (const model of ['deepseek-reasoner', 'glm-4.6']) {
      const cfg = resolve({ model, maxThinkingTokens: 4000 });
      expect(cfg.thinking).toEqual({ type: 'enabled', budgetTokens: 4000 });
    }
  });

  it('maxThinkingTokens = 0 → disabled thinking', () => {
    expect(resolve({ maxThinkingTokens: 0 }).thinking).toEqual({ type: 'disabled' });
  });

  it('maxThinkingTokens > 0 → adaptive when the host declares adaptiveThinking', () => {
    const cfg = resolve({ maxThinkingTokens: 4000, adaptiveThinking: true });
    expect(cfg.thinking).toEqual({ type: 'adaptive' });
    expect(cfg.adaptiveThinking).toBe(true);
  });

  it('adaptiveThinking alone does not turn thinking on', () => {
    expect(resolve({ adaptiveThinking: true }).thinking).toEqual({ type: 'disabled' });
  });
});

describe('resolveQueryConfig — maxOutputTokens', () => {
  it('takes the host-declared output limit', () => {
    expect(resolve({ maxOutputTokens: 64_000 }).maxTokens).toBe(64_000);
  });

  it('falls back to 16384 when undeclared', () => {
    expect(resolve().maxTokens).toBe(16384);
  });
});

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

describe('resolveQueryConfig — contextWindow', () => {
  it('defaults when the host declares nothing', () => {
    expect(resolve().contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('takes the declared window verbatim, above or below the default', () => {
    expect(resolve({ contextWindow: 1_000_000 }).contextWindow).toBe(1_000_000);
    expect(resolve({ contextWindow: 32_768 }).contextWindow).toBe(32_768);
  });

  it('never infers the window from the model name', () => {
    const models = ['deepseek-chat', 'glm-4.6', 'qwen3-coder', 'kimi-k2'];
    for (const model of models) {
      expect(resolve({ model }).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  });

  it('does not silently honour the 1M beta as a window declaration', () => {
    const cfg = resolve({ betas: ['context-1m-2025-08-07'] } as Partial<Options>);
    expect(cfg.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe('resolveQueryConfig — turnEndChecks', () => {
  it('checks open work and skips the completion check by default', () => {
    expect(resolve().turnEndChecks).toEqual({ openWork: true, completion: false });
  });

  it('takes each switch from Options independently', () => {
    expect(resolve({ turnEndChecks: { completion: true } }).turnEndChecks).toEqual({
      openWork: true,
      completion: true,
    });
    expect(resolve({ turnEndChecks: { openWork: false } }).turnEndChecks).toEqual({
      openWork: false,
      completion: false,
    });
  });
});
