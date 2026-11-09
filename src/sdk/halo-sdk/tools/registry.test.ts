/**
 * Unit tests for tools/registry.ts
 * Covers getAllTools, filterTools, findToolByName.
 */

import { describe, it, expect } from 'vitest';
import { getAllTools, filterTools, findToolByName } from './registry.js';
import type { Tool } from '../types/tool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidTool(t: Tool): boolean {
  return (
    typeof t.name === 'string' &&
    t.name.length > 0 &&
    typeof t.description === 'string' &&
    typeof t.inputSchema === 'object' &&
    t.inputSchema !== null &&
    typeof t.permissionLevel === 'string' &&
    typeof t.execute === 'function'
  );
}

// ---------------------------------------------------------------------------
// getAllTools
// ---------------------------------------------------------------------------

describe('getAllTools', () => {
  it('returns a non-empty array', () => {
    const tools = getAllTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('includes the core built-in tools', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'Goal']) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('every tool satisfies the Tool interface', () => {
    const tools = getAllTools();
    for (const t of tools) {
      expect(isValidTool(t)).toBe(true);
    }
  });

  it('every tool name is unique', () => {
    const tools = getAllTools();
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('contains core file tools', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('Read')).toBe(true);
    expect(names.has('Write')).toBe(true);
    expect(names.has('Edit')).toBe(true);
    expect(names.has('Glob')).toBe(true);
    expect(names.has('Grep')).toBe(true);
  });

  it('contains Bash tool', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('Bash')).toBe(true);
  });

  it('contains web tools', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('WebFetch')).toBe(true);
  });

  it('contains skill and planning tools', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('Agent')).toBe(false);
    expect(names.has('Skill')).toBe(true);
    expect(names.has('TodoWrite')).toBe(true);
  });

  it('contains communication tools', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('AskUserQuestion')).toBe(true);
  });

  it('keeps collaboration ownership outside the built-in tool registry', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('SendMessage')).toBe(false);
    expect(names.has('TeamCreate')).toBe(false);
    expect(names.has('TeamDelete')).toBe(false);
  });

  it('leaves out tools a shell command or the host already covers', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    for (const removed of ['EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'WebSearch']) {
      expect(names.has(removed), removed).toBe(false);
    }
  });

  it('does not ship scheduling tools', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('CronCreate')).toBe(false);
  });

  it('contains background shell task controls', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('TaskStop')).toBe(true);
    expect(names.has('TaskOutput')).toBe(true);
  });

  it('keeps TodoWrite as the only task list', () => {
    const names = new Set(getAllTools().map((t) => t.name));
    expect(names.has('TodoWrite')).toBe(true);
    for (const removed of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      expect(names.has(removed)).toBe(false);
    }
  });

  it('all permissionLevels are valid values', () => {
    const valid = new Set(['none', 'readonly', 'write', 'execute']);
    for (const t of getAllTools()) {
      expect(valid.has(t.permissionLevel), `${t.name} has invalid permissionLevel`).toBe(true);
    }
  });

  it('returns a new array each call (no shared reference)', () => {
    const a = getAllTools();
    const b = getAllTools();
    expect(a).not.toBe(b);
  });
});

describe('filterTools', () => {
  it('returns all tools when no options provided', () => {
    const all = getAllTools();
    expect(filterTools(all)).toHaveLength(all.length);
  });

  it('returns all tools when empty options provided', () => {
    const all = getAllTools();
    expect(filterTools(all, {})).toHaveLength(all.length);
  });

  it('filters by allowedTools — only listed tools returned', () => {
    const all = getAllTools();
    const result = filterTools(all, { allowedTools: ['Read', 'Write', 'Edit'] });
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit']),
    );
  });

  it('returns empty when allowedTools contains no matches', () => {
    const all = getAllTools();
    const result = filterTools(all, { allowedTools: ['NonExistentTool'] });
    expect(result).toHaveLength(0);
  });

  it('filters by disallowedTools — listed tools excluded', () => {
    const all = getAllTools();
    const result = filterTools(all, { disallowedTools: ['Bash'] });
    expect(result.find((t) => t.name === 'Bash')).toBeUndefined();
    expect(result).toHaveLength(all.length - 1);
  });

  it('disallows multiple tools', () => {
    const all = getAllTools();
    const result = filterTools(all, { disallowedTools: ['Bash', 'Grep', 'WebFetch'] });
    expect(result.find((t) => t.name === 'Bash')).toBeUndefined();
    expect(result.find((t) => t.name === 'Grep')).toBeUndefined();
    expect(result.find((t) => t.name === 'WebFetch')).toBeUndefined();
    expect(result).toHaveLength(all.length - 3);
  });

  it('allowedTools applied first, then disallowedTools', () => {
    const all = getAllTools();
    const result = filterTools(all, {
      allowedTools: ['Read', 'Write', 'Bash'],
      disallowedTools: ['Bash'],
    });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Read', 'Write']),
    );
  });

  it('empty allowedTools array returns empty list', () => {
    const all = getAllTools();
    const result = filterTools(all, { allowedTools: [] });
    expect(result).toHaveLength(all.length);
  });

  it('does not mutate the input array', () => {
    const all = getAllTools();
    const original = [...all];
    filterTools(all, { disallowedTools: ['Bash'] });
    expect(all).toHaveLength(original.length);
  });
});

// ---------------------------------------------------------------------------
// findToolByName
// ---------------------------------------------------------------------------

describe('findToolByName', () => {
  it('finds a tool by exact name', () => {
    const all = getAllTools();
    const found = findToolByName(all, 'Read');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Read');
  });

  it('returns undefined when name does not match any tool', () => {
    const all = getAllTools();
    expect(findToolByName(all, 'NonExistentTool')).toBeUndefined();
  });

  it('returns undefined on empty array', () => {
    expect(findToolByName([], 'Read')).toBeUndefined();
  });

  it('is case-sensitive', () => {
    const all = getAllTools();
    expect(findToolByName(all, 'read')).toBeUndefined();
    expect(findToolByName(all, 'READ')).toBeUndefined();
    expect(findToolByName(all, 'Read')).toBeDefined();
  });

  it('finds tool by partial pool (filtered list)', () => {
    const all = getAllTools();
    const filtered = filterTools(all, { allowedTools: ['Bash', 'Grep'] });
    expect(findToolByName(filtered, 'Bash')).toBeDefined();
    expect(findToolByName(filtered, 'Read')).toBeUndefined();
  });

  it('returns the first match when duplicates exist', () => {
    const bashTool = getAllTools().find((t) => t.name === 'Bash')!;
    const dupeList = [bashTool, bashTool];
    const found = findToolByName(dupeList, 'Bash');
    expect(found).toBe(bashTool);
  });
});
