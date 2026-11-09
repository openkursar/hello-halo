/**
 * @module tools/skill/skill-tool.test
 * Unit tests for SkillTool — disk skills, listing, argument expansion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';
import { SkillTool } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(cwd: string): ToolContext {
  return {
    sessionId: 'test-session',
    cwd,
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    // Isolated HOME so listing tests never see the machine's own skills.
    env: { HOME: cwd, CLAUDE_CONFIG_DIR: undefined },
  };
}

let tmpDir: string;
let commandsDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-skill-test-'));
  commandsDir = path.join(tmpDir, '.claude', 'commands');
  await fs.mkdir(commandsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// SkillTool — metadata
// ===========================================================================

describe('SkillTool — metadata', () => {
  it('has correct name', () => {
    expect(SkillTool.name).toBe('Skill');
  });

  it('has none permissionLevel (read-only prompt expansion)', () => {
    expect(SkillTool.permissionLevel).toBe('none');
  });

  it('has inputSchema', () => {
    expect(SkillTool.inputSchema).toBeTruthy();
  });
});

// ===========================================================================
// SkillTool — input validation
// ===========================================================================

describe('SkillTool — input validation', () => {
  it('returns error when skill is missing', async () => {
    const result = await SkillTool.execute({}, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/missing required parameter: skill/i);
  });

  it('returns error when skill is not a string', async () => {
    const result = await SkillTool.execute({ skill: 42 }, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/missing required parameter: skill/i);
  });
});

// ===========================================================================
// SkillTool — disk skills
// ===========================================================================

describe('SkillTool — disk skills', () => {
  it('returns prompt from disk skill file', async () => {
    await fs.writeFile(
      path.join(commandsDir, 'my-skill.md'),
      'Do something useful.\n',
    );
    const result = await SkillTool.execute({ skill: 'my-skill' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Do something useful.');
  });

  it('strips YAML frontmatter from disk skill', async () => {
    const content = '---\ntitle: My Skill\n---\nActual prompt content.\n';
    await fs.writeFile(path.join(commandsDir, 'fm-skill.md'), content);
    const result = await SkillTool.execute({ skill: 'fm-skill' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Actual prompt content.');
  });

  it('replaces $ARGUMENTS in disk skill', async () => {
    await fs.writeFile(
      path.join(commandsDir, 'arg-skill.md'),
      'Run this: $ARGUMENTS\n',
    );
    const result = await SkillTool.execute(
      { skill: 'arg-skill', args: 'npm test' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Run this: npm test');
  });

  it('disk skill with no $ARGUMENTS is returned as-is', async () => {
    await fs.writeFile(path.join(commandsDir, 'plain.md'), 'A plain prompt.\n');
    const result = await SkillTool.execute({ skill: 'plain', args: 'ignored' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('A plain prompt.');
  });

  it('returns error when skill file expands to empty content', async () => {
    // A file with only whitespace after stripping
    await fs.writeFile(path.join(commandsDir, 'empty.md'), '   \n   \n');
    const result = await SkillTool.execute({ skill: 'empty' }, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/expanded to empty content/i);
  });

  it('strips .md extension from disk skill name', async () => {
    await fs.writeFile(path.join(commandsDir, 'ext-skill.md'), 'Content.\n');
    const result = await SkillTool.execute(
      { skill: 'ext-skill.md' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Content.');
  });
});

// ===========================================================================
// SkillTool — skill not found
// ===========================================================================

describe('SkillTool — skill not found', () => {
  it('returns error with hint to use list when skill not found', async () => {
    const result = await SkillTool.execute({ skill: 'no-such-skill' }, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
    expect(result.content).toMatch(/skill="list"/);
  });
});

// ===========================================================================
// SkillTool — list mode
// ===========================================================================

describe('SkillTool — list mode', () => {
  it('lists bundled workflows when none exist on disk', async () => {
    const result = await SkillTool.execute({ skill: 'list' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Available skills (2)');
    expect(result.content).toContain('commit');
    expect(result.content).toContain('pull-request');
  });

  it('includes disk skills in listing', async () => {
    await fs.writeFile(
      path.join(commandsDir, 'custom-check.md'),
      '# Custom\nRun all checks.\n',
    );
    const result = await SkillTool.execute({ skill: 'list' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('custom-check');
    expect(result.content).toContain('Run all checks.');
  });

  it('lists total skill count', async () => {
    await fs.writeFile(path.join(commandsDir, 'counted.md'), 'Counted.\n');
    const result = await SkillTool.execute({ skill: 'list' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/Available skills \(3\)/);
  });
});

// ===========================================================================
// SkillTool — skills/ directory search (standard)
// ===========================================================================

describe('SkillTool — skills/ directory search', () => {
  let skillsDir: string;

  beforeEach(async () => {
    skillsDir = path.join(tmpDir, '.claude', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
  });

  it('finds flat .md skill in .claude/skills/', async () => {
    await fs.writeFile(path.join(skillsDir, 'analyze.md'), 'Analyze this code.\n');
    const result = await SkillTool.execute({ skill: 'analyze' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Analyze this code.');
  });

  it('lists flat skills from .claude/skills/ in list mode', async () => {
    await fs.writeFile(path.join(skillsDir, 'optimize.md'), '# Optimize\nSpeed up code.\n');
    const result = await SkillTool.execute({ skill: 'list' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('optimize');
  });

  it('commands/ takes precedence over skills/ for same skill name', async () => {
    await fs.writeFile(path.join(commandsDir, 'dupe.md'), 'From commands.\n');
    await fs.writeFile(path.join(skillsDir, 'dupe.md'), 'From skills.\n');
    const result = await SkillTool.execute({ skill: 'dupe' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('From commands.');
  });

  it('deduplicates: same skill name only appears once in list', async () => {
    await fs.writeFile(path.join(commandsDir, 'xuniq.md'), 'Unique cmd.\n');
    await fs.writeFile(path.join(skillsDir, 'xuniq.md'), 'Unique skill.\n');
    const result = await SkillTool.execute({ skill: 'list' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    // The bullet-point line "  xuniq — ..." must appear exactly once
    const matches = result.content.match(/^\s+xuniq\s+—/m) ?? [];
    expect(matches.length).toBe(1);
    expect(result.content).toMatch(/Available skills \(3\)/);
  });
});

// ===========================================================================
// SkillTool — directory format (<name>/SKILL.md)
// ===========================================================================

describe('SkillTool — directory format (<name>/SKILL.md)', () => {
  it('finds skill in <name>/SKILL.md inside commands/', async () => {
    const skillDir = path.join(commandsDir, 'my-tool');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Run my tool.\n');
    const result = await SkillTool.execute({ skill: 'my-tool' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Run my tool.');
  });

  it('finds skill in <name>/SKILL.md inside skills/', async () => {
    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    const skillDir = path.join(skillsDir, 'helper');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Helper content.\n');
    const result = await SkillTool.execute({ skill: 'helper' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Helper content.');
  });

  it('lists directory-format skill in list mode', async () => {
    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    const skillDir = path.join(skillsDir, 'refactor');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Refactor Skill\nRefactor code.\n');
    const result = await SkillTool.execute({ skill: 'list' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('refactor');
  });

  it('flat .md takes precedence over <name>/SKILL.md in same dir', async () => {
    const skillDir = path.join(commandsDir, 'dual');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(commandsDir, 'dual.md'), 'Flat wins.\n');
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Dir loses.\n');
    const result = await SkillTool.execute({ skill: 'dual' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Flat wins.');
  });

  it('directory-format skill supports $ARGUMENTS substitution', async () => {
    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    const skillDir = path.join(skillsDir, 'greet');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Hello, $ARGUMENTS!\n');
    const result = await SkillTool.execute({ skill: 'greet', args: 'World' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Hello, World!');
  });
});

// ===========================================================================
// SkillTool — CLAUDE_CONFIG_DIR global skills
// ===========================================================================

describe('SkillTool — CLAUDE_CONFIG_DIR global skills', () => {
  let configDir: string;
  let globalSkillsDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-skill-config-'));
    globalSkillsDir = path.join(configDir, 'skills');
    await fs.mkdir(globalSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function makeCtxWithConfig(cwd: string, claudeConfigDir: string): ToolContext {
    return {
      sessionId: 'test-session',
      cwd,
      abortSignal: new AbortController().signal,
      costTracker: new CostTracker('test-model'),
      currentTurn: 0,
      env: { CLAUDE_CONFIG_DIR: claudeConfigDir, HOME: cwd },
    };
  }

  it('finds flat skill in CLAUDE_CONFIG_DIR/skills/', async () => {
    await fs.writeFile(path.join(globalSkillsDir, 'global-skill.md'), 'Global content.\n');
    const result = await SkillTool.execute(
      { skill: 'global-skill' },
      makeCtxWithConfig(tmpDir, configDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Global content.');
  });

  it('finds directory-format skill in CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md', async () => {
    const skillDir = path.join(globalSkillsDir, 'global-tool');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Global SDK skill.\n');
    const result = await SkillTool.execute(
      { skill: 'global-tool' },
      makeCtxWithConfig(tmpDir, configDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Global SDK skill.');
  });

  it('local skill in commands/ overrides global skill with same name', async () => {
    await fs.writeFile(path.join(globalSkillsDir, 'shared.md'), 'Global version.\n');
    await fs.writeFile(path.join(commandsDir, 'shared.md'), 'Local version.\n');
    const result = await SkillTool.execute(
      { skill: 'shared' },
      makeCtxWithConfig(tmpDir, configDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Local version.');
  });

  it('lists global skills alongside local skills', async () => {
    await fs.writeFile(path.join(globalSkillsDir, 'global-only.md'), 'Global.\n');
    await fs.writeFile(path.join(commandsDir, 'local-only.md'), 'Local.\n');
    const result = await SkillTool.execute(
      { skill: 'list' },
      makeCtxWithConfig(tmpDir, configDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('global-only');
    expect(result.content).toContain('local-only');
  });
});

// ===========================================================================
// SkillTool — $ARGUMENTS_SUFFIX substitution in disk skills
// ===========================================================================

describe('SkillTool — $ARGUMENTS_SUFFIX in disk skills', () => {
  it('replaces $ARGUMENTS_SUFFIX with ": <args>" when args provided', async () => {
    await fs.writeFile(
      path.join(commandsDir, 'suffix-skill.md'),
      'Review code$ARGUMENTS_SUFFIX.\n',
    );
    const result = await SkillTool.execute(
      { skill: 'suffix-skill', args: 'for performance' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Review code: for performance.');
  });

  it('replaces $ARGUMENTS_SUFFIX with empty string when no args', async () => {
    await fs.writeFile(
      path.join(commandsDir, 'suffix-skill.md'),
      'Review code$ARGUMENTS_SUFFIX.\n',
    );
    const result = await SkillTool.execute({ skill: 'suffix-skill' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Review code.');
  });

  it('handles both $ARGUMENTS and $ARGUMENTS_SUFFIX together', async () => {
    await fs.writeFile(
      path.join(commandsDir, 'combo.md'),
      'Task: $ARGUMENTS$ARGUMENTS_SUFFIX\n',
    );
    const result = await SkillTool.execute(
      { skill: 'combo', args: 'refactor' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Task: refactor: refactor');
  });

  it('$ARGUMENTS_SUFFIX is empty when args is whitespace-only', async () => {
    await fs.writeFile(
      path.join(commandsDir, 'ws-skill.md'),
      'Do it$ARGUMENTS_SUFFIX.\n',
    );
    const result = await SkillTool.execute(
      { skill: 'ws-skill', args: '   ' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Do it.');
  });
});
