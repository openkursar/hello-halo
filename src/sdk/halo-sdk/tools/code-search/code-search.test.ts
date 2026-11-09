import { describe, expect, it, vi } from 'vitest';
import { createCodeSearchTool } from './index.js';
import type { CodeSearchResult, CodeSearchService } from '../../search/index.js';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';

function context(): ToolContext {
  return { sessionId:'search-test',cwd:'/workspace',abortSignal:new AbortController().signal,
    costTracker:new CostTracker('test'),currentTurn:0,env:{},readDenyRoots:['/unrelated/private'] };
}

describe('CodeSearch tool', () => {
  it('forwards current permissions and cancellation while reporting bounded candidate evidence', async () => {
    const result: CodeSearchResult = { exhaustive:false,freshness:'possibly_stale',hits:[{
      path:'/workspace/auth.ts',lineStart:4,lineEnd:9,snippet:'function authorize() {}',truncated:true,
    }] };
    const search = vi.fn(async () => result);
    const service: CodeSearchService = {search,dispose:async()=>{}};
    const ctx = context();
    const output = await createCodeSearchTool(service).execute({query:'find authentication',limit:3,refresh:true},ctx);
    expect(search).toHaveBeenCalledWith({root:ctx.cwd,query:'find authentication',limit:3,refresh:true,
      readDenyRoots:ctx.readDenyRoots,signal:ctx.abortSignal});
    expect(output.isError).toBe(false);
    expect(output.content).toContain('not exhaustive');
    expect(output.content).toContain('possibly_stale');
    expect(output.content).toContain('/workspace/auth.ts:4-9');
    expect(output.content).toContain('Snippet shortened');
    expect(output.metadata).toMatchObject({type:'code_search',exhaustive:false,hits:result.hits});
  });

  it('does not turn an unavailable backend into a false no-match result', async () => {
    const tool = createCodeSearchTool({search:async()=>{throw new Error('Backend unavailable');},dispose:async()=>{}});
    const result = await tool.execute({query:'find authentication'},context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Backend unavailable');
  });
});
