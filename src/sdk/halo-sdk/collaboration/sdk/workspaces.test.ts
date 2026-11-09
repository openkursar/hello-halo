import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openMemberWorkspace, releaseMemberWorkspace, remapWorkspaceDeniedRoots, type MemberWorkspace } from './workspaces.js';
import type { CollaborationMember } from '../runtime.js';
import { createSdkCollaboration } from './index.js';
import { bindReadDenyFloor } from '../../core/read-policy.js';
import type { Options } from '../../types/config.js';
import type { LlmProvider, ProviderRequest, StreamEvent, ToolResultBlock } from '../../types/provider.js';
import * as processes from '../../utils/processes.js';

const run = promisify(execFile);
let directory: string;
let project: string;
let metadataDirectory: string;
const checkouts: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return (await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, timeout: 10_000 })).stdout.trim();
}

async function checkpoint(cwd: string, parent?: string): Promise<string> {
  await git(cwd, 'add', '.');
  const tree = await git(cwd, 'write-tree');
  const commit = await git(cwd, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Fixture snapshot');
  await git(cwd, 'update-ref', '-m', 'Fixture update', 'HEAD', commit);
  return commit;
}

function member(overrides: Partial<CollaborationMember> = {}): CollaborationMember {
  const value = { id: randomUUID(), name: 'worker', parentId: 'coordinator', prompt: 'Inspect the project.', createdAt: Date.now(), isolation: 'worktree' as const, ...overrides };
  checkouts.push(join(tmpdir(), `halo-collaboration-${value.id}`));
  return value;
}

async function open(overrides: Partial<CollaborationMember> = {}, parentCwd = project): Promise<MemberWorkspace> {
  return openMemberWorkspace({ member: member(overrides), parentCwd, metadataDirectory, signal: new AbortController().signal });
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-collaboration-workspaces-')));
  project = join(directory, 'project');
  metadataDirectory = join(directory, 'workspaces');
  await mkdir(join(project, 'nested'), { recursive: true });
  await writeFile(join(project, 'tracked.txt'), 'original');
  await writeFile(join(project, 'secret.txt'), 'SECRET_SENTINEL');
  await writeFile(join(project, 'nested', 'tracked.txt'), 'nested');
  await writeFile(join(project, '.gitignore'), 'ignored.txt\n');
  await git(project, 'init', '-q');
  await checkpoint(project);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(checkouts.splice(0).map(path => rm(path, { recursive: true, force: true })));
  await rm(directory, { recursive: true, force: true });
});

describe('collaborator workspace ownership', () => {
  it.each(['status', 'rev-parse', 'reflog', 'worktree'])('retains the checkout when cleanup cannot verify %s', async stage => {
    const placement = await open();
    const execute = processes.execFile;
    const calls: Array<{ args: string[]; timeout: number }> = [];
    vi.spyOn(processes, 'execFile').mockImplementation(((command, args, options, callback) => {
      if (command === 'git') {
        calls.push({ args, timeout: options.timeout });
        if (args[0] === stage) {
          queueMicrotask(() => callback(Object.assign(new Error('Fixture Git verification failure'), { code: 'ETIMEDOUT' }), '', ''));
          return {};
        }
      }
      return execute(command, args, options, callback);
    }) as typeof processes.execFile);
    await releaseMemberWorkspace(placement);
    expect(await readFile(join(placement.cwd, 'tracked.txt'), 'utf8')).toBe('original');
    expect(calls.every(call => call.timeout === 10_000)).toBe(true);
    expect(calls.some(call => call.args.includes('--force'))).toBe(false);
  });

  it('reports an allocated checkout if metadata persistence fails, without deleting the partial work', async () => {
    const identity = member();
    await mkdir(join(metadataDirectory, `${identity.id}.json.tmp`), { recursive: true });
    const checkout = join(await realpath(tmpdir()), `halo-collaboration-${identity.id}`);
    await expect(openMemberWorkspace({ member: identity, parentCwd: project, metadataDirectory,
      signal: new AbortController().signal })).rejects.toMatchObject({ checkout });
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('original');
  });
  it('keeps a checkout reusable until host cleanup, then removes only unchanged work', async () => {
    const identity = member();
    const options = { member: identity, parentCwd: project, metadataDirectory, signal: new AbortController().signal };
    const first = await openMemberWorkspace(options);
    expect(await readFile(join(first.cwd, 'tracked.txt'), 'utf8')).toBe('original');
    expect(await openMemberWorkspace(options)).toEqual(first);
    await releaseMemberWorkspace(first);
    await expect(access(first.checkout!)).rejects.toThrow();
    const restored = await openMemberWorkspace(options);
    expect(restored).toEqual(first);
    await releaseMemberWorkspace(restored);
  });

  it.each(['modified', 'untracked', 'ignored'])('retains %s work at host shutdown', async kind => {
    const placement = await open();
    const file = kind === 'modified' ? 'tracked.txt' : kind === 'untracked' ? 'new.txt' : 'ignored.txt';
    await writeFile(join(placement.cwd, file), 'retained work');
    await releaseMemberWorkspace(placement);
    expect(await readFile(join(placement.cwd, file), 'utf8')).toBe('retained work');
  });

  it.each(['new-head', 'reset-after-commit'])('retains clean checkouts with %s history', async mode => {
    const placement = await open();
    await writeFile(join(placement.cwd, 'tracked.txt'), 'committed work');
    await checkpoint(placement.cwd, placement.initialHead);
    if (mode === 'reset-after-commit') await git(placement.cwd, 'reset', '--hard', placement.initialHead!);
    expect(await git(placement.cwd, 'status', '--porcelain')).toBe('');
    await releaseMemberWorkspace(placement);
    await expect(access(placement.cwd)).resolves.toBeUndefined();
  });

  it('cleans nested checkouts through the common repository even if the parent checkout was removed first', async () => {
    const parent = await open();
    const child = await open({}, parent.cwd);
    expect(child.gitCommonDirectory).toBe(parent.gitCommonDirectory);
    await releaseMemberWorkspace(parent);
    await expect(access(parent.cwd)).rejects.toThrow();
    await releaseMemberWorkspace(child);
    await expect(access(child.cwd)).rejects.toThrow();
  });

  it('carries a repository-relative working subdirectory into each checkout', async () => {
    const placement = await open({}, join(project, 'nested'));
    expect(placement.cwd).toBe(join(await realpath(placement.checkout!), 'nested'));
    expect(await readFile(join(placement.cwd, 'tracked.txt'), 'utf8')).toBe('nested');
  });

  it('maps denied roots through both generations while retaining original denials', async () => {
    const parent = await open();
    const child = await open({}, parent.cwd);
    const original = join(project, 'secret.txt');
    const roots = remapWorkspaceDeniedRoots(remapWorkspaceDeniedRoots([original], parent), child);
    expect(roots).toEqual(expect.arrayContaining([original, join(parent.cwd, 'secret.txt'), join(child.cwd, 'secret.txt')]));
  });

  it('allows explicit nested and host-approved extra directories without creating a checkout', async () => {
    const nested = await open({ cwd: join(project, 'nested'), isolation: undefined });
    expect(nested).toEqual({ cwd: join(project, 'nested') });
    const extra = join(directory, 'extra');
    await mkdir(extra);
    expect(await openMemberWorkspace({ member: member({ cwd: extra, isolation: undefined }), parentCwd: project,
      additionalDirectories: ['../extra'], signal: new AbortController().signal })).toEqual({ cwd: extra });
  });

  it.each(['outside', 'symlink', 'relative', 'file', 'both'])('rejects invalid %s placement', async kind => {
    const outside = join(directory, 'outside');
    await mkdir(outside);
    const link = join(project, 'escape');
    await symlink(outside, link);
    const cwd = kind === 'outside' ? outside : kind === 'symlink' ? link : kind === 'relative' ? 'nested'
      : kind === 'file' ? join(project, 'tracked.txt') : project;
    await expect(open({ cwd, isolation: kind === 'both' ? 'worktree' : undefined })).rejects.toThrow();
  });

  it('rejects isolation outside a repository instead of sharing the caller directory', async () => {
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await expect(open({}, outside)).rejects.toThrow();
  });

  it('does not adopt or delete an existing checkout without its ownership record', async () => {
    const identity = member();
    const checkout = join(tmpdir(), `halo-collaboration-${identity.id}`);
    await mkdir(checkout);
    await writeFile(join(checkout, 'existing.txt'), 'unowned');
    await expect(openMemberWorkspace({ member: identity, parentCwd: project, metadataDirectory, signal: new AbortController().signal })).rejects.toThrow(/ownership/);
    expect(await readFile(join(checkout, 'existing.txt'), 'utf8')).toBe('unowned');
  });

  it('rejects a replaced checkout that belongs to another repository', async () => {
    const identity = member();
    const options = { member: identity, parentCwd: project, metadataDirectory, signal: new AbortController().signal };
    const placement = await openMemberWorkspace(options);
    await releaseMemberWorkspace(placement);
    await mkdir(placement.checkout!);
    await git(placement.checkout!, 'init', '-q');
    await expect(openMemberWorkspace(options)).rejects.toThrow(/could not be prepared/);
    await expect(access(placement.checkout!)).resolves.toBeUndefined();
  });

  it('rejects an isolated subdirectory that resolves outside its checkout and reports the retained location', async () => {
    const target = join(directory, 'target');
    await mkdir(target);
    const initial = await git(project, 'rev-parse', 'HEAD');
    await rm(join(project, 'nested'), { recursive: true });
    await symlink(target, join(project, 'nested'));
    await checkpoint(project, initial);
    await rm(join(project, 'nested'));
    await mkdir(join(project, 'nested'));
    const identity = member();
    await expect(openMemberWorkspace({ member: identity, parentCwd: join(project, 'nested'), metadataDirectory,
      signal: new AbortController().signal })).rejects.toMatchObject({ checkout: join(await realpath(tmpdir()), `halo-collaboration-${identity.id}`) });
  });

  it('enforces ancestral read denials in a nested isolated SDK session and artifact publication', async () => {
    const contextSecret = join(directory, 'context.txt');
    await writeFile(contextSecret, 'CONTEXT_SECRET_SENTINEL');
    const requests: Array<{ member: string; request: ProviderRequest }> = [];
    const turns = new Map<string, number>();
    const provider: LlmProvider = {
      id: 'fixture', name: 'Fixture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('Unexpected summary'); },
      async *createMessageStream(request): AsyncGenerator<StreamEvent> {
        const name = JSON.stringify(request.systemPrompt).includes('\\"second\\"') ? 'second' : 'first';
        const turn = turns.get(name) ?? 0;
        turns.set(name, turn + 1);
        requests.push({ member: name, request });
        const calls = name === 'first' && turn === 0
          ? [{ name: 'mcp__halo-team__spawn_agent', input: { name: 'second', prompt: 'Check access.', isolation: 'worktree' } }]
          : name === 'second' && turn === 0
            ? [join(project, 'secret.txt'), 'secret.txt', contextSecret].map(file_path => ({ name: 'Read', input: { file_path } }))
            : name === 'second' && turn === 1
              ? [{ name: 'mcp__halo-team__team_post_finding', input: { ref: 'secret.txt', content: 'Attempt to publish inaccessible source.' } }]
              : [];
        const usage = { input_tokens: 10, output_tokens: 10 };
        yield { type: 'message_start', id: `${name}-${turn}`, model: request.model, usage };
        for (const [index, call] of calls.entries()) {
          yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `${name}-${turn}-${index}`, ...call } };
          yield { type: 'content_block_stop', index };
        }
        if (!calls.length) {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Access check finished.' } };
          yield { type: 'content_block_stop', index: 0 };
        }
        yield { type: 'message_delta', stopReason: calls.length ? 'tool_use' : 'end_turn', usage };
        yield { type: 'message_stop' };
      },
    };
    const base: Options = { provider, model: 'fixture', cwd: project, settingSources: [],
      env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') },
      disallowedTools: ['Read(secret.txt)'], permissionMode: 'bypassPermissions',
      turnEndChecks: { openWork: false, completion: false } };
    bindReadDenyFloor(base, [contextSecret]);
    const notices: string[] = [];
    const binding = createSdkCollaboration({ sessionId: randomUUID(), getOptions: () => base,
      deliverToSource: async envelope => { notices.push(envelope.body); return 'buffered'; } });
    let locations: string[] = [];
    try {
      await binding.server.instance.callTool('spawn_agent', { name: 'first', prompt: 'Delegate the access check.', isolation: 'worktree' });
      while (binding.activeCount > 0) await binding.waitForChange(binding.revision);
      const second = requests.filter(entry => entry.member === 'second');
      expect(second).toHaveLength(3);
      const results = second[1].request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter((block): block is ToolResultBlock => block.type === 'tool_result');
      expect(results).toHaveLength(3);
      expect(results.every(result => result.is_error && /denied/i.test(String(result.content)))).toBe(true);
      const publications = second[2].request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter((block): block is ToolResultBlock => block.type === 'tool_result' && block.tool_use_id === 'second-1-0');
      expect(publications[0].is_error).toBe(true);
      expect(JSON.stringify(requests)).not.toContain('SECRET_SENTINEL');
      const result = await binding.server.instance.callTool('team_read_board', {});
      const board = JSON.parse(result!.content[0].text);
      locations = board.members.filter((entry: { worktree?: string }) => entry.worktree).map((entry: { worktree: string }) => entry.worktree);
      checkouts.push(...locations);
      expect(locations).toHaveLength(2);
      expect(board.findings).toHaveLength(0);
      expect(locations.every(location => notices.some(notice => notice.includes(location)))).toBe(true);
    } finally { await binding.close(); }
    for (const location of locations) await expect(access(location)).rejects.toThrow();
  });
});
