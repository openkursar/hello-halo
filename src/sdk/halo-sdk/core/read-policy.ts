import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Options } from '../types/config.js';
import { isDeniedReal, realPath, resolveReadDenyRoots } from '../utils/read-deny.js';

const inheritedRoots = new WeakMap<Options, readonly string[]>();

export function bindReadDenyFloor(options: Options, roots: readonly string[]): void {
  inheritedRoots.set(options, [...new Set(roots.map(realPath))]);
}

export function readDenyFloor(options: Options): readonly string[] {
  return inheritedRoots.get(options) ?? [];
}

export function inheritReadDenyFloor(target: Options, source: Options): void {
  const roots = inheritedRoots.get(source);
  if (roots) inheritedRoots.set(target, [...new Set([...roots, ...readDenyFloor(target)])]);
}

export function codeSearchCacheRoot(options: Options): string | undefined {
  if (!options.codeSearch) return undefined;
  const configured = options.codeSearch.cachePath;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
    throw new TypeError('CodeSearch cachePath must be an absolute path to a dedicated cache directory');
  }
  const cache = realPath(configured);
  const workspace = realPath(options.cwd ?? process.cwd());
  const sharedRoots = [path.parse(cache).root, homedir(), tmpdir(), '/tmp', '/var/tmp'].map(realPath);
  if (isDeniedReal(cache, [workspace]) || isDeniedReal(workspace, [cache]) ||
      sharedRoots.some(root => isDeniedReal(root, [cache]))) {
    throw new TypeError('CodeSearch cachePath must be a dedicated directory outside the workspace, not a home or shared temporary directory');
  }
  return cache;
}

/** Cache contents can contain source text from sessions with broader read access. */
export function codeSearchReadDenyRoots(options: Options): string[] {
  const cache = codeSearchCacheRoot(options);
  return [...new Set([...readDenyFloor(options), ...(cache ? [cache] : [])])];
}

export function resolveSessionReadDenyRoots(options: Options): string[] {
  return [...new Set([
    ...resolveReadDenyRoots(options.disallowedTools, options.cwd ?? process.cwd()),
    ...codeSearchReadDenyRoots(options),
  ])];
}
