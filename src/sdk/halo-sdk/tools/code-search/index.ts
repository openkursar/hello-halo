import type { Tool } from '../../types/tool.js';
import { toolError, toolSuccess } from '../../types/tool.js';
import type { CodeSearchService } from '../../search/index.js';

export function createCodeSearchTool(service: CodeSearchService): Tool {
  return {
    name: 'CodeSearch',
    permissionLevel: 'readonly',
    isConcurrencySafe: () => true,
    description: `Find likely code locations in the current workspace from a natural-language question. Use this when you do not know the file or symbol name. Results are ranked candidates, not a complete list of occurrences; an empty result does not prove absence. Use Grep for exact text and Read to verify current source before changing it. The first request prepares a local index. After files change, set refresh=true to update it; otherwise the existing index may be stale.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000, description: 'The behavior, responsibility, or relationship you want to locate in this workspace.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum candidate locations; defaults to 5.' },
        refresh: { type: 'boolean', description: 'Update the index before searching when recent file changes matter. Defaults to false.' },
      },
      required: ['query'],
    },
    async execute(input, context) {
      try {
        const result = await service.search({ root: context.cwd, query: input.query as string, limit: input.limit as number | undefined,
          refresh: input.refresh as boolean | undefined, readDenyRoots: context.readDenyRoots, signal: context.abortSignal });
        const sections = [`Ranked code candidates; coverage is not exhaustive. Freshness: ${result.freshness}.`];
        for (const hit of result.hits) {
          sections.push(`${hit.path}:${hit.lineStart}-${hit.lineEnd}\n${hit.snippet}${hit.truncated ? '\n[Snippet shortened; use Read for the surrounding source.]' : ''}`);
        }
        if (result.hits.length === 0) sections.push('No candidates were returned. Try a different question or use Grep with an exact clue.');
        return toolSuccess(sections.join('\n\n'), { type: 'code_search', ...result });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : 'Code search is unavailable. Use Grep for exact searches.');
      }
    },
  };
}
