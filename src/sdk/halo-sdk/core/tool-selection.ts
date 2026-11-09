import type { Options } from '../types/config.js';
import type { Tool } from '../types/tool.js';
import { getAllTools } from '../tools/registry.js';

export interface BorrowedToolSnapshot { revision: number; tools: readonly Tool[] }
export interface BorrowedToolSource { read(): BorrowedToolSnapshot; initial: readonly Tool[] }
const borrowedSources = new WeakMap<Options, BorrowedToolSource>();

export function bindBorrowedToolSource(options: Options, source: BorrowedToolSource): void {
  borrowedSources.set(options, source);
}

export function borrowedToolSource(options: Options): BorrowedToolSource | undefined {
  return borrowedSources.get(options);
}

/** Shares tool instances and catalog revisions without transferring connection ownership. */
export function borrowedMcpSource(read: () => BorrowedToolSnapshot): () => BorrowedToolSnapshot {
  let snapshot: BorrowedToolSnapshot | undefined;
  return () => {
    const current = read();
    if (!snapshot || snapshot.revision !== current.revision) {
      snapshot = { revision: current.revision, tools: current.tools.filter(tool => tool.mcpSource && tool.mcpSource.server !== 'halo-team') };
    }
    return snapshot;
  };
}

/** Optional capabilities join the built-in pool before the caller selects tool names. */
export function configuredBuiltInTools(options: Pick<Options, 'tools'>, extra: readonly Tool[] = []): Tool[] {
  const all = [...getAllTools(), ...extra];
  if (!Array.isArray(options.tools)) return all;
  const selected = new Set(options.tools);
  return all.filter(tool => selected.has(tool.name));
}
