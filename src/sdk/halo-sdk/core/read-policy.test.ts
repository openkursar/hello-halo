import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { resolveQueryConfig } from './context.js';
import { codeSearchCacheRoot } from './read-policy.js';
import { createSessionCodeSearchService } from './code-search.js';
import { ReadTool } from '../tools/read/index.js';
import { GrepTool } from '../tools/grep/index.js';
import { realPath } from '../utils/read-deny.js';
import type { Options } from '../types/config.js';
import type { ToolContext } from '../types/tool.js';

let directory: string;
let workspace: string;
let cache: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdk-cache-read-policy-'));
  workspace = join(directory, 'workspace');
  cache = join(directory, 'cache');
  await mkdir(workspace);
  await mkdir(cache);
  await writeFile(join(workspace, 'sample.txt'), 'PUBLIC_SOURCE');
  await writeFile(join(cache, 'snippets.txt'), 'PRIVATE_CACHE_SENTINEL');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function options(cachePath = cache): Options {
  return { model: 'fixture', cwd: workspace, codeSearch: {
    backend: 'zvec-grep', nodePath: process.execPath, modulePath: join(directory, 'backend.mjs'), cachePath,
  } };
}
function context(input: Options): ToolContext {
  const config = resolveQueryConfig(input);
  return { cwd: config.cwd, sessionId: 'cache-policy', abortSignal: config.abortSignal, readDenyRoots: config.readDenyRoots };
}

describe('CodeSearch cache read policy', () => {
  it('denies actual Read and Grep access to existing cache contents without blocking the workspace', async () => {
    const ctx = context(options());
    const read = new ReadTool();
    const grep = new GrepTool();
    expect(await read.execute({ file_path: join(cache, 'snippets.txt') }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining('denied') });
    expect(await grep.execute({ path: cache, pattern: 'SENTINEL', output_mode: 'content' }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining('denied') });
    expect(await read.execute({ file_path: 'sample.txt' }, ctx)).toMatchObject({ isError: false, content: expect.stringContaining('PUBLIC_SOURCE') });
    const traversal = await grep.execute({ path: directory, pattern: 'PUBLIC_SOURCE|PRIVATE_CACHE_SENTINEL', output_mode: 'content' }, ctx);
    expect(traversal.isError).toBe(false);
    expect(traversal.content).toContain('PUBLIC_SOURCE');
    expect(traversal.content).not.toContain('PRIVATE_CACHE_SENTINEL');
  });

  it('resolves cache aliases and applies protection even when the search tool is filtered out', async () => {
    const alias = join(directory, 'cache-alias');
    await symlink(cache, alias, 'dir');
    const input = { ...options(alias), tools: [] };
    expect(resolveQueryConfig(input).readDenyRoots).toEqual([realPath(cache)]);
    expect(await new ReadTool().execute({ file_path: join(alias, 'snippets.txt') }, context(input))).toMatchObject({ isError: true });
  });

  it('does not change ordinary file access without an explicit search configuration', async () => {
    const input = { model: 'fixture', cwd: workspace };
    expect(resolveQueryConfig(input).readDenyRoots).toEqual([]);
    expect(await new ReadTool().execute({ file_path: join(cache, 'snippets.txt') }, context(input)))
      .toMatchObject({ isError: false, content: expect.stringContaining('PRIVATE_CACHE_SENTINEL') });
  });

  it('rejects a relative, shared, or workspace-overlapping cache directory', () => {
    for (const target of ['relative-cache', workspace, join(workspace, '.cache'), directory, homedir(), tmpdir(), parse(directory).root]) {
      expect(() => codeSearchCacheRoot(options(target)), target).toThrow('dedicated');
    }
  });

  it('keeps the host search floor when a request targets the internal cache directly', async () => {
    const service = createSessionCodeSearchService(options())!;
    try {
      await expect(service.search({ root: cache, query: 'SENTINEL', readDenyRoots: [] })).rejects.toThrow('read restrictions');
    } finally { await service.dispose(); }
  });
});
