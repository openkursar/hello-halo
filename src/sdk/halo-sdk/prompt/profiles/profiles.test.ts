import { describe, expect, it } from 'vitest';
import { resolvePromptProfile } from '../../index.js';
import type { PromptProfileSelection } from '../../types/config.js';

describe('prompt profile selection', () => {
  it('does not infer behavior from a brand or gateway alias', () => {
    for (const model of ['glm-5.3-flash', 'openrouter/glm-5.3-flash', 'deployment-42', 'unknown']) {
      expect(resolvePromptProfile(model).id).toBe('default');
    }
  });

  it('uses exact model mappings before the explicit default', () => {
    const selection: PromptProfileSelection = {
      default: 'explicit',
      models: { 'provider/model-a': 'default' },
    };
    expect(resolvePromptProfile('provider/model-a', selection).id).toBe('default');
    expect(resolvePromptProfile('model-a', selection).id).toBe('explicit');
    expect(resolvePromptProfile('other/model-a', selection).id).toBe('explicit');
  });

  it('does not interpret inherited properties as model mappings', () => {
    expect(resolvePromptProfile('toString', { models: {} }).id).toBe('default');
    expect(resolvePromptProfile('__proto__', { models: {} }).id).toBe('default');
  });

  it('is unchanged by serializing the selection for a worker', () => {
    const selection: PromptProfileSelection = { models: { alias: 'explicit' } };
    expect(resolvePromptProfile('alias', JSON.parse(JSON.stringify(selection))))
      .toBe(resolvePromptProfile('alias', selection));
    expect(Object.isFrozen(resolvePromptProfile('alias', selection))).toBe(true);
  });

  it('rejects an invalid explicit profile rather than silently weakening it', () => {
    expect(() => resolvePromptProfile('model', 'typo' as PromptProfileSelection)).toThrow('Unknown prompt profile');
  });

  it('keeps summary guidance separate from conversation guidance', () => {
    const profile = resolvePromptProfile('model', 'explicit');
    expect(profile.summaryGuidance).toContain('unresolved work');
    expect(profile.summaryGuidance).not.toContain('# Execution checkpoints');
    expect(resolvePromptProfile('model').summaryGuidance).toBe('');
  });
});
