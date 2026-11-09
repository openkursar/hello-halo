import { describe, expect, it } from 'vitest';
import { resolveQueryConfig } from '../core/context.js';
import { snapshotSkillCatalog } from './index.js';
import type { SkillCatalog } from '../index.js';

const builtin = { name: 'commit', description: 'Commit workflow', source: { kind: 'builtin' as const, name: 'commit' } };

describe('public skill catalog validation', () => {
  it.each([
    null, {}, [null], [{ ...builtin, name: '../commit' }], [{ ...builtin, name: 'list' }],
    [builtin, { ...builtin, name: 'COMMIT.md' }], [{ ...builtin, description: 1 }],
    [{ ...builtin, whenToUse: false }], [{ ...builtin, argumentHint: [] }],
    [{ ...builtin, source: { kind: 'file', path: 'relative.md' } }],
    [{ ...builtin, source: { kind: 'builtin', name: 'missing' } }],
    [{ ...builtin, source: { kind: 'inline', body: 'not supported' } }],
  ])('rejects invalid input without falling back to discovery: %j', value => {
    expect(() => resolveQueryConfig({ model: 'test', skillCatalog: value as SkillCatalog })).toThrow(/skillCatalog/);
  });

  it('normalizes names and creates an immutable metadata-only snapshot', () => {
    const input = [{ ...builtin, name: ' commit.md ', source: { ...builtin.source }, body: 'not catalog metadata' }];
    const snapshot = snapshotSkillCatalog(input);
    input[0].source.name = 'pull-request';
    expect(snapshot).toEqual([{ ...builtin, whenToUse: undefined, argumentHint: undefined }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0].source)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('not catalog metadata');
  });

  it('distinguishes empty from omitted', () => {
    expect(resolveQueryConfig({ model: 'test' }).skillCatalog).toBeUndefined();
    expect(resolveQueryConfig({ model: 'test', skillCatalog: [] }).skillCatalog).toEqual([]);
  });
});
