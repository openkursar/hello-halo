import type { Options } from '../types/config.js';
import type { Tool } from '../types/tool.js';
import { createCodeSearchService, type CodeSearchService } from '../search/index.js';
import { createCodeSearchTool } from '../tools/code-search/index.js';
import { codeSearchCacheRoot, resolveSessionReadDenyRoots } from './read-policy.js';

const bridges = new WeakMap<Options, CodeSearchService>();

export function bindCodeSearchBridge(options: Options, service: CodeSearchService): void {
  bridges.set(options, service);
}

export function codeSearchBridge(options: Options): CodeSearchService | undefined {
  return bridges.get(options);
}

export function includesCodeSearch(options: Options): boolean {
  return !!options.codeSearch &&
    (!Array.isArray(options.tools) || options.tools.includes('CodeSearch')) &&
    !options.disallowedTools?.includes('CodeSearch') &&
    !options.customTools?.some(tool => tool.name === 'CodeSearch');
}

/** The host's configured read restrictions remain a floor for worker and child requests. */
export function createSessionCodeSearchService(options: Options): CodeSearchService | undefined {
  if (!includesCodeSearch(options)) return undefined;
  const cachePath = codeSearchCacheRoot(options)!;
  const hostDenied = resolveSessionReadDenyRoots(options);
  const service = createCodeSearchService({ ...options.codeSearch!, cachePath });
  let disposal: Promise<void> | undefined;
  return {
    search(request) {
      if (typeof request.root !== 'string') return Promise.reject(new TypeError('Code search requires a workspace path'));
      const denied = new Set([...hostDenied, ...(request.readDenyRoots ?? [])]);
      return service.search({ ...request, readDenyRoots: [...denied] });
    },
    dispose() { return disposal ??= service.dispose(); },
  };
}

export interface SessionCodeSearch {
  tool: Tool;
  dispose(): Promise<void>;
  borrow(): CodeSearchService;
}

export function prepareCodeSearch(options: Options): SessionCodeSearch | undefined {
  if (!includesCodeSearch(options)) return undefined;
  const service = bridges.get(options) ?? createSessionCodeSearchService(options)!;
  return {
    tool: createCodeSearchTool(service),
    dispose: () => service.dispose(),
    borrow: () => ({ search: request => service.search(request), async dispose() {} }),
  };
}
