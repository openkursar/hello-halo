import { randomUUID } from 'node:crypto';
import type { CodeSearchOptions, CodeSearchRequest, CodeSearchResult, CodeSearchDiagnostics, CodeSearchService } from '../search/types.js';
import type { Tool, ToolContext, ToolResult } from '../types/tool.js';
import type { ToolDefinition } from '../types/provider.js';
import { callbackError, loadBinding, nativeError, parseNativeValue, routeNativeLog, stringifyNativeValue, type NativeCollaborationCallback } from './binding.js';
import { toolFormatter } from './tool-authority.js';
import { registerNativeToolDefinition } from './tool-identities.js';

export type { CodeSearchOptions, CodeSearchRequest, CodeSearchResult, CodeSearchDiagnostics, CodeSearchService } from '../search/types.js';

const log: NativeCollaborationCallback = (error, _name, input) => {
  if (error) return JSON.stringify({ ok: false, error: { message: error.message } });
  routeNativeLog(JSON.parse(input));
  return '{"ok":true}';
};

export function createCodeSearchService(options: CodeSearchOptions): CodeSearchService {
  const nativeProcessEnv = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  let handle;
  try { handle = new (loadBinding().NativeCodeSearchService)(stringifyNativeValue({ ...options, nativeProcessEnv }), log); }
  catch (error) { throw nativeError(error); }
  return {
    async search(request: CodeSearchRequest): Promise<CodeSearchResult> {
      const { signal, ...plain } = request;
      const id = randomUUID();
      const cancel = () => handle.cancel(id);
      try {
        const operation = handle.search(stringifyNativeValue(plain), id, signal?.aborted ?? false);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        return parseNativeValue(await operation) as CodeSearchResult;
      } catch (error) { throw nativeError(error); }
      finally { signal?.removeEventListener('abort', cancel); }
    },
    async dispose(): Promise<void> {
      try { await handle.dispose(); }
      catch (error) { throw nativeError(error); }
    },
  };
}

export function getCodeSearchDiagnostics(): CodeSearchDiagnostics {
  try { return parseNativeValue(loadBinding().codeSearchDiagnostics()) as CodeSearchDiagnostics; }
  catch (error) { throw nativeError(error); }
}

function value<T>(method: string, args: unknown[]): T {
  try { return parseNativeValue(loadBinding().codeSearchValue(method, stringifyNativeValue(args))) as T; }
  catch (error) { throw nativeError(error); }
}

function feedback(context: ToolContext, method: 'result' | 'error', input: unknown): ToolResult {
  const format = toolFormatter(context);
  return format ? format(`codeSearch.${method}`, input) : value(method, [input]);
}

export function createCodeSearchTool(service: CodeSearchService): Tool {
  const definition = value<ToolDefinition>('definition', []);
  const tool: Tool = {
    name: definition.name, description: definition.description, inputSchema: definition.input_schema,
    permissionLevel: 'readonly', isConcurrencySafe: () => true,
    async execute(input, context) {
      try {
        const result = await service.search({ root: context.cwd, query: input.query as string, limit: input.limit as number | undefined,
          refresh: input.refresh as boolean | undefined, readDenyRoots: context.readDenyRoots, signal: context.abortSignal });
        const output = feedback(context, 'result', result);
        output.metadata = { ...output.metadata, ...result };
        return output;
      } catch (error) {
        return feedback(context, 'error', error instanceof Error ? JSON.parse(callbackError(error)) : null);
      }
    },
  };
  registerNativeToolDefinition(tool, 'CodeSearchDefinition');
  return tool;
}
