import type { ToolDiscoveryOptions } from '../types/config.js';
import type { Message, ToolDefinition, ToolUseBlock } from '../types/provider.js';
import type { Tool, ToolResult } from '../types/tool.js';
import type { ToolCatalog } from '../core/tool-context/catalog.js';
import type { ToolContextRecord, ToolContextSnapshot, ToolDefinitionSnapshot, NormalizedToolCall, ToolDiscoveryEnvelope } from '../core/tool-context/types.js';
import type { ToolDiscoveryState as StateContract } from '../core/tool-context/state.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue, type NativeToolDiscoveryHandle } from './binding.js';

interface Description {
  catalog: { eager: string[]; deferred: Record<string, ToolDefinitionSnapshot>; directory: string; generation: string };
  modelDefinitions: ToolDefinition[];
  discoveryEntries: boolean;
  searchDefinition: ToolDefinition;
}

const handles = new WeakMap<object, NativeToolDiscoveryHandle>();
const instances = new Map<string, WeakRef<ToolDiscoveryState>>();
const finalized = new FinalizationRegistry<string>(identity => {
  if (!instances.get(identity)?.deref()) instances.delete(identity);
});

export function toolDiscoveryHandle(state: object | null | undefined): NativeToolDiscoveryHandle | undefined {
  return state ? handles.get(state) : undefined;
}

export function wrapToolDiscoveryState(handle: NativeToolDiscoveryHandle, tools: readonly Tool[]): StateContract {
  const existing = instances.get(handle.identity)?.deref();
  return (existing ?? new ToolDiscoveryState(tools, { services: {} }, 0, 0, [], false, handle)) as unknown as StateContract;
}

export class ToolDiscoveryState {
  readonly catalog: ToolCatalog;
  readonly searchTool: Tool;
  readonly modelDefinitions: ToolDefinition[];
  readonly discoveryEntries: boolean;
  private readonly handle: NativeToolDiscoveryHandle;

  constructor(tools: readonly Tool[], options: ToolDiscoveryOptions, resultCharacters: number, recoveryTokens: number,
    disallowedTools: readonly string[] = [], historicalRepresentation = false, handle?: NativeToolDiscoveryHandle) {
    try {
      this.handle = handle ?? new (loadBinding().NativeToolDiscoveryState)(stringifyNativeValue({
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema, mcpSource: tool.mcpSource })),
        options, resultCharacters, recoveryTokens, disallowed: disallowedTools, historical: historicalRepresentation,
      }));
    } catch (error) { throw nativeError(error); }
    handles.set(this, this.handle);
    instances.set(this.handle.identity, new WeakRef(this));
    finalized.register(this, this.handle.identity);
    const description = this.call<Description>('description');
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    const deferred = new Map(Object.entries(description.catalog.deferred));
    this.catalog = {
      eager: description.catalog.eager.map(name => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`Tool discovery execution reference is unavailable: ${name}`);
        return tool;
      }),
      deferred, directory: description.catalog.directory, generation: description.catalog.generation,
      search: (query, server) => this.call<ToolDefinitionSnapshot[]>('catalog.search', [query, server])
        .map(entry => deferred.get(entry.definition.name) ?? entry),
    };
    this.modelDefinitions = description.modelDefinitions;
    this.discoveryEntries = description.discoveryEntries;
    this.searchTool = {
      name: description.searchDefinition.name, description: description.searchDefinition.description,
      inputSchema: description.searchDefinition.input_schema, permissionLevel: 'readonly', isConcurrencySafe: () => true,
      execute: async (input, context) => this.call('search', [input, context.toolUseId]),
    };
  }

  private call<T>(method: string, args: unknown[] = []): T {
    try { return parseNativeValue(this.handle.call(method, stringifyNativeValue(args))) as T; }
    catch (error) { throw nativeError(error); }
  }

  get enabled(): boolean { return this.call('enabled'); }
  get needsBaseline(): boolean { return this.call('needsBaseline'); }
  baselineCommitted(): void { this.call('baselineCommitted'); }
  setRecoveryBudget(tokens: number): void { this.call('setRecoveryBudget', [tokens]); }
  snapshot(): ToolContextSnapshot { return this.call('snapshot'); }
  directoryMessage(): Message { return this.call('directoryMessage'); }
  restore(snapshot: ToolContextSnapshot): void { this.call('restore', [snapshot]); }
  commit(record: ToolContextRecord): void { this.call('commit', [record]); }
  normalize(call: ToolUseBlock): NormalizedToolCall {
    const result = this.call<NormalizedToolCall>('normalize', [call]);
    return result.origin ? result : { ...result, call };
  }
  settle(callId: string, result: ToolResult, envelope?: ToolDiscoveryEnvelope): { result: ToolResult; record?: ToolContextRecord } {
    const receipt = this.call<{ result: ToolResult; record?: ToolContextRecord; replaced: boolean }>('settle', [callId, result, envelope]);
    return { result: receipt.replaced ? receipt.result : result, ...(receipt.record ? { record: receipt.record } : {}) };
  }
  recoveryMessage(): Message { return this.call('recoveryMessage'); }
  finalizeResults(message: Message): void {
    if (!Array.isArray(message.content)) return;
    const receipt = this.call<{ message: Message; changedBlocks: number[] | null }>('finalizeResults', [message]);
    if (receipt.changedBlocks === null) return;
    const result = receipt.message;
    if (!Array.isArray(result.content)) return;
    for (const index of receipt.changedBlocks) {
      const block = message.content[index], updated = result.content[index];
      if (block.type !== 'tool_result' || updated?.type !== 'tool_result') continue;
      if (block.content !== updated.content) block.content = updated.content;
      if (updated.is_error !== undefined) block.is_error = updated.is_error;
    }
    if (result.toolContext) {
      const record = { ...message.toolContext, version: 1 as const };
      delete record.discoveries;
      delete record.presentations;
      if (result.toolContext.discoveries) record.discoveries = result.toolContext.discoveries;
      if (result.toolContext.presentations) record.presentations = result.toolContext.presentations;
      message.toolContext = record;
    } else delete message.toolContext;
  }
  clear(): void { this.call('clear'); }
  finishStep(): void { this.call('finishStep'); }
  hasSearchResult(callId: string): boolean { return this.call('hasSearchResult', [callId]); }
}
