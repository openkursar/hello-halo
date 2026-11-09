/**
 * Unit tests for loadSkillCommands.
 *
 * Uses a temp directory to exercise the filesystem discovery branches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSkillCommands } from './skills.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-skills-test-'));
  // The loader falls back to the real HOME for user-level skill dirs; point
  // it at an empty fixture so assertions never see the machine's skills.
  const homeFixture = path.join(tmpRoot, 'home');
  fs.mkdirSync(homeFixture, { recursive: true });
  vi.stubEnv('HOME', homeFixture);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function writeFile(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

describe('loadSkillCommands — filesystem discovery', () => {
  it('picks up flat .md skill files', () => {
    writeFile(
      '.claude/skills/foo.md',
      `---\ndescription: "Foo skill"\n---\n\n# Foo\nbody text\n`,
    );
    const out = loadSkillCommands({ cwd: tmpRoot });
    const foo = out.find((c) => c.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo?.description).toBe('Foo skill');
    expect(foo?.type).toBe('prompt');
    expect(foo?.source).toBe('user');
  });

  it('picks up <name>/SKILL.md directory layout', () => {
    writeFile(
      '.claude/skills/bar/SKILL.md',
      `---\ndescription: "Bar skill"\nargumentHint: "<query>"\n---\n# Bar\n`,
    );
    const out = loadSkillCommands({ cwd: tmpRoot });
    const bar = out.find((c) => c.name === 'bar');
    expect(bar).toBeDefined();
    expect(bar?.description).toBe('Bar skill');
    expect(bar?.argumentHint).toBe('<query>');
  });

  it('falls back to first non-empty body line when frontmatter omits description', () => {
    writeFile(
      '.claude/skills/baz.md',
      `---\nname: baz\n---\nFirst real line of baz\nSecond line\n`,
    );
    const out = loadSkillCommands({ cwd: tmpRoot });
    const baz = out.find((c) => c.name === 'baz');
    expect(baz?.description).toBe('First real line of baz');
  });

  it('does not throw on malformed frontmatter; falls back gracefully', () => {
    writeFile(
      '.claude/skills/broken.md',
      `---\nthis is :: not :: yaml\nstill broken\n---\n\nfallback first line\n`,
    );
    const out = loadSkillCommands({ cwd: tmpRoot });
    const broken = out.find((c) => c.name === 'broken');
    // Description either parsed to "" and falls back, or extracts something.
    // Either way it must NOT throw and the entry must exist with a string.
    expect(broken).toBeDefined();
    expect(typeof broken?.description).toBe('string');
  });

  it('keeps bundled fallbacks when optional skill directories are absent', () => {
    const out = loadSkillCommands({ cwd: tmpRoot, configDir: '/no/such/dir' });
    expect(out.map(command => [command.name, command.source])).toEqual([
      ['commit', 'builtin'], ['pull-request', 'builtin'],
    ]);
  });

  it('SKILL.md basename inside flat scan is skipped (avoids self-naming as "SKILL")', () => {
    writeFile(
      '.claude/skills/SKILL.md',
      `---\ndescription: "should be ignored at top level"\n---\n`,
    );
    const out = loadSkillCommands({ cwd: tmpRoot });
    expect(out.find((c) => c.name === 'SKILL')).toBeUndefined();
  });
});

describe('loadSkillCommands — dedup ordering', () => {
  it('project skills take precedence over user configuration like the Skill tool', () => {
    writeFile('.claude/skills/stuck.md', `---\ndescription: "project stuck"\n---\n`);
    writeFile('cfg/skills/stuck.md', `---\ndescription: "user-overridden stuck"\n---\n`);
    const out = loadSkillCommands({ cwd: tmpRoot, configDir: path.join(tmpRoot, 'cfg') });
    const stuck = out.find((c) => c.name === 'stuck');
    expect(stuck?.description).toBe('project stuck');
    expect(stuck?.source).toBe('user');
  });
});

describe('loadSkillCommands — metadata consistency', () => {
  it('uses flat files before directory layouts and parses multiline YAML', () => {
    writeFile('.agents/skills/review/SKILL.md', '---\ndescription: directory copy\n---\n');
    writeFile('.agents/skills/review.md', '---\ndescription: >-\n  Review the changes\n  before publishing.\nargument-hint: "<path>"\n---\n');
    const command = loadSkillCommands({ cwd: tmpRoot }).find(item => item.name === 'review');
    expect(command?.description).toBe('Review the changes before publishing.');
    expect(command?.argumentHint).toBe('<path>');
  });

  it('uses session-specific home and conventions instead of the process home', () => {
    writeFile('session-home/.custom/skills/isolated.md', '---\ndescription: |\n  First line\n  Second line\n---\n');
    const commands = loadSkillCommands({
      cwd: tmpRoot,
      env: { HOME: path.join(tmpRoot, 'session-home'), SDK_CONFIG: undefined },
      conventions: { memoryFiles: [], memorySubdirs: [], agentDirs: ['.custom'], configDirEnv: 'SDK_CONFIG', userConfigDirName: '.custom' },
    });
    expect(commands.filter(command => command.source === 'user').map(command => command.name)).toEqual(['isolated']);
    expect(commands.find(command => command.name === 'isolated')?.description).toBe('First line\nSecond line');
  });
});

describe('loadSkillCommands — getPromptForCommand expansion', () => {
  it('expands the selected instructions directly with the supplied arguments', async () => {
    writeFile('.claude/skills/qux.md', `---\ndescription: "Qux"\n---\nReview these changes$ARGUMENTS_SUFFIX.\n`);
    const out = loadSkillCommands({ cwd: tmpRoot });
    const qux = out.find((c) => c.name === 'qux');
    expect(qux?.type).toBe('prompt');
    if (!qux || qux.type !== 'prompt' || !qux.getPromptForCommand) {
      throw new Error('expected qux to be a prompt command with expander');
    }
    const ctx = {
      sessionId: 's',
      cwd: tmpRoot,
      model: 'm',
      setModel: () => {},
      mcpServerStatuses: [],
      messages: [],
      clearMessages: () => {},
      compactSession: async () => {},
    };
    const noArg = await qux.getPromptForCommand('', ctx);
    expect(noArg).toEqual([{ role: 'user', content: '<skill-instructions name="qux">\nReview these changes.\n</skill-instructions>' }]);
    const withArg = await qux.getPromptForCommand('hello world', ctx);
    expect(withArg).toEqual([
      { role: 'user', content: '<skill-instructions name="qux">\nReview these changes: hello world.\n</skill-instructions>' },
    ]);
  });
});
