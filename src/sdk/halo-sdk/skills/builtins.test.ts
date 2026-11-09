import { describe, expect, it } from 'vitest';
import { getBuiltinSkillDefinitions, type BuiltinSkillDefinition } from '../index.js';
import { getBuiltinSkillDefinitions as workerDefinitions } from '../worker/index.js';
import { loadSkill, resolveSkillCatalog } from './index.js';

describe('public builtin definitions', () => {
  it('exposes the same immutable definitions from both public entries', () => {
    const definitions: readonly BuiltinSkillDefinition[] = getBuiltinSkillDefinitions();
    expect(workerDefinitions()).toBe(definitions);
    expect(getBuiltinSkillDefinitions()).toBe(definitions);
    expect(definitions.map(definition => definition.name)).toEqual(['commit', 'pull-request']);
    expect(Object.isFrozen(definitions)).toBe(true);
    for (const definition of definitions) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(definition.description).toBeTruthy();
      expect(definition.argumentHint).toBeTruthy();
      expect(definition.instructions).toContain('$ARGUMENTS');
    }
  });

  it('uses the exact bodies loaded by builtin skill invocation', async () => {
    for (const definition of getBuiltinSkillDefinitions()) {
      const loaded = await loadSkill({ ...definition, source: { kind: 'builtin', name: definition.name } }, 'request details');
      expect(loaded.prompt).toBe(definition.instructions.replace(/\$ARGUMENTS/g, 'request details').trim());
    }
  });

  it('does not add definitions to an explicitly empty catalog', () => {
    getBuiltinSkillDefinitions();
    expect(resolveSkillCatalog({ cwd: process.cwd(), skillCatalog: [] })).toEqual([]);
  });
});
