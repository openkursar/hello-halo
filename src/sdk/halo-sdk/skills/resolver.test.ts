import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CostTracker } from '../core/cost.js';
import { buildSessionRegistry, dispatchSlashCommand } from '../commands/index.js';
import { loadSkillCommands } from '../commands/sources/skills.js';
import type { SlashCommandContext } from '../commands/types.js';
import { SkillTool } from '../tools/skill/index.js';
import type { ToolContext } from '../types/tool.js';
import { discoverSkillFiles, loadSkill, readSkillMetadata, resolveSkill, resolveSkillCatalog, skillSearchDirs } from './index.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync), readdirSync: vi.fn(actual.readdirSync) };
});

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-skill-resolver-'));
  ctx = {
    sessionId: 'skill-session', cwd: root, env: { HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'config') },
    currentTurn: 0, costTracker: new CostTracker('test'), abortSignal: new AbortController().signal,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('shared skill resolution', () => {
  it('uses the same winning file for catalog, tool invocation and direct slash expansion', async () => {
    write('.agents/commands/commit.md', '---\ndescription: Project procedure\n---\nCheck project rules$ARGUMENTS_SUFFIX.');
    write('.agents/commands/commit/SKILL.md', 'Directory version');
    write('.agents/skills/commit.md', 'Skills version');
    write('.claude/commands/commit.md', 'Alternate convention version');
    write('config/skills/commit.md', 'User config version');
    write('home/.agents/commands/commit.md', 'Home version');

    const catalog = resolveSkillCatalog(ctx);
    expect(catalog.filter(entry => entry.name === 'commit')).toHaveLength(1);
    expect(catalog.find(entry => entry.name === 'commit')?.description).toBe('Project procedure');
    const tool = await SkillTool.execute({ skill: 'commit', args: 'selected paths' }, ctx);
    const command = loadSkillCommands(ctx).find(entry => entry.name === 'commit');
    if (!command || command.type !== 'prompt' || !command.getPromptForCommand) throw new Error('Missing command');
    const messages = await command.getPromptForCommand('selected paths', {} as SlashCommandContext);
    expect(tool.content).toBe('Check project rules: selected paths.');
    expect(messages[0].content).toContain(tool.content);
    expect(messages[0].content).not.toContain('Use the commit skill');
  });

  it('uses user configuration ahead of legacy home skills and bundled fallbacks', async () => {
    write('config/skills/pull-request/SKILL.md', 'User request process.');
    write('home/.agents/skills/pull-request.md', 'Legacy process.');
    const entry = resolveSkill('pull-request', ctx)!;
    expect((await loadSkill(entry)).prompt).toBe('User request process.');
    expect(entry.source.kind).toBe('file');
  });

  it('preserves disk precedence when a skill name differs from a fallback only in case', async () => {
    write('.agents/skills/Commit.md', 'Local capitalization must not expose the fallback.');
    const catalog = resolveSkillCatalog(ctx);
    expect(catalog.filter(entry => entry.name.toLowerCase() === 'commit')).toHaveLength(1);
    expect((await SkillTool.execute({ skill: 'commit' }, ctx)).content).toBe('Local capitalization must not expose the fallback.');
    const command = buildSessionRegistry({ skills: loadSkillCommands(ctx) }).get('COMMIT');
    expect(command?.source).toBe('user');
  });

  it('normalizes names consistently when a skill file has a repeated Markdown suffix', async () => {
    write('.agents/skills/review.md.md', 'Review the exact selected source.');
    expect(resolveSkillCatalog(ctx).some(entry => entry.name === 'review')).toBe(true);
    expect((await SkillTool.execute({ skill: 'review.md' }, ctx)).content).toBe('Review the exact selected source.');
  });

  it('does not advertise a file under the reserved catalog-listing name', async () => {
    write('.agents/skills/List.md', 'This name is reserved for listing.');
    expect(resolveSkillCatalog(ctx).some(entry => entry.name.toLowerCase() === 'list')).toBe(false);
    expect((await SkillTool.execute({ skill: 'LIST' }, ctx)).content).toContain('Available skills (2)');
  });

  it('deduplicates symlinked sources and can load a symlinked skill package', async () => {
    const real = write('shared/review/SKILL.md', 'Review the selected change.');
    fs.mkdirSync(path.join(root, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(path.dirname(real), path.join(root, '.agents', 'skills', 'review'), 'dir');
    fs.symlinkSync(path.join(root, '.agents', 'skills'), path.join(root, '.agents', 'commands'), 'dir');
    const files = discoverSkillFiles(skillSearchDirs(ctx));
    expect(files.filter(([name]) => name === 'review')).toHaveLength(1);
    expect((await SkillTool.execute({ skill: 'review' }, ctx)).content).toBe('Review the selected change.');
  });

  it('does not fall back to a bundled workflow when a selected disk command disappears', async () => {
    const filePath = write('.agents/skills/commit.md', 'Project commit process.');
    const command = loadSkillCommands(ctx).find(entry => entry.name === 'commit');
    if (!command || command.type !== 'prompt' || !command.getPromptForCommand) throw new Error('Missing command');
    fs.rmSync(filePath);
    await expect(command.getPromptForCommand('', {} as SlashCommandContext)).rejects.toThrow();
  });

  it('shares pinned source entries across metadata, Skill calls and slash commands', async () => {
    const filePath = write('.agents/skills/commit.md', '---\ndescription: Project approval\n---\nProject commit process.');
    const skillCatalog = resolveSkillCatalog(ctx);
    const pinned = { ...ctx, skillCatalog };
    const command = loadSkillCommands(pinned).find(entry => entry.name === 'commit');
    fs.rmSync(filePath);
    expect(resolveSkillCatalog(pinned)).toBe(skillCatalog);
    expect(resolveSkill('commit', pinned)?.source.kind).toBe('file');
    expect((await SkillTool.execute({ skill: 'commit' }, pinned)).isError).toBe(true);
    if (!command || command.type !== 'prompt' || !command.getPromptForCommand) throw new Error('Missing command');
    await expect(command.getPromptForCommand('', {} as SlashCommandContext)).rejects.toThrow();
    expect(Object.isFrozen(skillCatalog)).toBe(true);
    expect(Object.isFrozen(skillCatalog[0].source)).toBe(true);
  });

  it('keeps host commands ahead of bundled and disk skill commands', async () => {
    write('.agents/skills/commit.md', 'Project commit process.');
    const registry = buildSessionRegistry({
      skills: loadSkillCommands(ctx),
      user: [{ name: 'commit', description: 'Host commit action' }],
    });
    expect(registry.get('commit')?.description).toBe('Host commit action');
    expect((await dispatchSlashCommand(registry, 'commit', '', {} as SlashCommandContext)).kind).toBe('host-handled');
  });

  it('exposes no skill commands and performs no discovery when disabled', () => {
    const readDirectory = vi.mocked(fs.readdirSync).mockClear();
    expect(loadSkillCommands({ ...ctx, enabled: false })).toEqual([]);
    expect(readDirectory).not.toHaveBeenCalled();
  });
});

describe('skill instruction boundaries', () => {
  it('loads built-in instructions without a source-file resource at the working directory', async () => {
    const catalog = resolveSkillCatalog(ctx);
    expect(catalog.map(entry => entry.name)).toEqual(['commit', 'pull-request']);
    expect(JSON.stringify(catalog)).not.toContain('Start with the requested scope.');
    const result = await SkillTool.execute({ skill: 'pull-request', args: 'target release' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('merge request');
    expect(result.content).toContain('target release');
  });

  it('reads a bounded metadata prefix and defers the body until invocation', async () => {
    const filePath = write('.agents/skills/large.md', `---\ndescription: Short metadata\n---\n${'body '.repeat(20_000)}`);
    const read = vi.mocked(fs.readSync).mockClear();
    const catalog = resolveSkillCatalog(ctx);
    expect(read.mock.calls.every(call => typeof call[3] === 'number' && call[3] <= 16 * 1024)).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('body body');
    fs.writeFileSync(filePath, '---\ndescription: Short metadata\n---\nUpdated instructions.');
    expect((await loadSkill(catalog.find(entry => entry.name === 'large')!)).prompt).toBe('Updated instructions.');
  });

  it('rejects oversized instructions instead of returning a partial workflow', async () => {
    write('.agents/skills/large.md', 'x'.repeat(1024 * 1024 + 1));
    const result = await SkillTool.execute({ skill: 'large' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('byte read limit');
  });

  it('expands arguments once and preserves literal dollar replacement syntax', async () => {
    write('.agents/skills/literal.md', '---\r\ndescription: Literal arguments\r\n---\r\nValue: $ARGUMENTS; suffix$ARGUMENTS_SUFFIX');
    const result = await SkillTool.execute({ skill: 'literal', args: '$& $ARGUMENTS' }, ctx);
    expect(result.content).toBe('Value: $& $ARGUMENTS; suffix: $& $ARGUMENTS');
  });

  it('rejects paths and non-text arguments without loading another file', async () => {
    write('.agents/private.md', 'Private outside the skill catalog.');
    const traversal = await SkillTool.execute({ skill: '../private' }, ctx);
    expect(traversal.isError).toBe(true);
    expect(traversal.content).not.toContain('Private outside');
    expect((await SkillTool.execute({ skill: 'commit', args: {} }, ctx)).isError).toBe(true);
  });

  it('accepts a malformed metadata shape as body-only metadata without throwing', () => {
    const filePath = write('.agents/skills/sequence.md', '---\n- one\n- two\n---\nFallback description.');
    expect(readSkillMetadata(filePath).description).toBe('Fallback description.');
  });

  it('bounds large listings and lets the caller narrow by name', async () => {
    for (let i = 0; i < 100; i++) write(`.agents/skills/entry-${String(i).padStart(3, '0')}.md`, `---\ndescription: ${'detail '.repeat(50)}\n---\nInstructions.`);
    const listed = await SkillTool.execute({ skill: 'list' }, ctx);
    expect(listed.content.length).toBeLessThan(16_000);
    expect(listed.content).toContain('entries omitted');
    const narrowed = await SkillTool.execute({ skill: 'list', args: 'entry-099' }, ctx);
    expect(narrowed.content).toContain('Available skills (1)');
    expect(narrowed.content).toContain('entry-099');
  });
});
