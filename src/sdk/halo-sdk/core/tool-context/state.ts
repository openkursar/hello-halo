import type { ToolDiscoveryOptions } from '../../types/config.js';
import type { Message, ToolDefinition, ToolUseBlock, ToolResultBlock } from '../../types/provider.js';
import type { Tool, ToolResult } from '../../types/tool.js';
import { toToolDefinition } from '../../types/tool.js';
import { estimateTokens } from '../../utils/tokens.js';
import { truncateToolResult } from '../../utils/truncate.js';
import { getLogger } from '../../utils/logger.js';
import { createToolCatalog, stableJson, TOOL_CONTEXT_LIMITS, type ToolCatalog } from './catalog.js';
import type { NormalizedToolCall, ToolContextRecord, ToolContextSnapshot, ToolDefinitionSnapshot, ToolDiscoveryEnvelope } from './types.js';
import { isToolContextRecord } from './history.js';

const log = getLogger('ToolContext');

export const SEARCH_DEFINITION: ToolDefinition = {
  name: 'ToolSearch',
  description: 'Find tools in the available services and read their complete definitions before using CallTool. ' +
    'Search by purpose or use select:<full tool name> to display an exact definition again.',
  input_schema: { type: 'object', properties: {
    query: { type: 'string', minLength: 1, maxLength: TOOL_CONTEXT_LIMITS.queryCharacters }, server: { type: 'string' },
    max_results: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
  }, required: ['query'], additionalProperties: false },
};

export const CALL_DEFINITION: ToolDefinition = {
  name: 'CallTool',
  description: 'Call a tool whose complete definition was returned by ToolSearch in an earlier model step. ' +
    'Use its exact name and encode its argument object as a JSON string. Tools already declared directly must be called directly.',
  input_schema: { type: 'object', properties: {
    tool: { type: 'string' }, arguments: { type: 'string' },
  }, required: ['tool', 'arguments'], additionalProperties: false },
};

interface PendingDiscovery {
  content: string;
  rendered: string;
  envelope?: ToolDiscoveryEnvelope;
  explicit: boolean;
  settled: boolean;
  definitions: ToolDefinitionSnapshot[];
  payload: { tools: Record<string, unknown>[]; notice?: string };
}

function payloadSpan(envelope: ToolDiscoveryEnvelope | undefined, payload: string) {
  return envelope && (envelope.prefix || envelope.suffix)
    ? { payloadOffset: envelope.prefix.length, payloadLength: payload.length } : {};
}

export class ToolDiscoveryState {
  readonly catalog: ToolCatalog;
  readonly searchTool: Tool;
  readonly modelDefinitions: ToolDefinition[];
  readonly discoveryEntries: boolean;
  private readonly discovered = new Map<string, ToolDefinitionSnapshot>();
  private readonly pending = new Map<string, PendingDiscovery>();
  private recoveryTokens: number;
  private baselinePending = true;

  constructor(
    tools: readonly Tool[], options: ToolDiscoveryOptions,
    private readonly resultCharacters: number,
    recoveryTokens: number,
    disallowedTools: readonly string[] = [],
    historicalRepresentation = false,
  ) {
    this.catalog = createToolCatalog(tools, options);
    this.discoveryEntries = this.catalog.deferred.size > 0 || historicalRepresentation;
    this.recoveryTokens = recoveryTokens;
    if (this.discoveryEntries) {
      if (tools.some(tool => tool.name === 'ToolSearch' || tool.name === 'CallTool')) {
        throw new Error('ToolSearch and CallTool are reserved while tool discovery is enabled');
      }
      if (this.catalog.deferred.size && (disallowedTools.includes('ToolSearch') || disallowedTools.includes('CallTool'))) {
        throw new Error('Deferred tools require both ToolSearch and CallTool; a required entry is disabled');
      }
    }
    this.searchTool = {
      name: SEARCH_DEFINITION.name, description: SEARCH_DEFINITION.description,
      inputSchema: SEARCH_DEFINITION.input_schema, permissionLevel: 'readonly',
      isConcurrencySafe: () => true,
      execute: async (input, ctx) => this.search(input, ctx.toolUseId),
    };
    this.modelDefinitions = structuredClone([
      ...this.catalog.eager.map(toToolDefinition),
      ...(this.discoveryEntries ? [SEARCH_DEFINITION, CALL_DEFINITION] : []),
    ]);
  }

  get enabled(): boolean { return this.catalog.deferred.size > 0; }
  get needsBaseline(): boolean { return this.baselinePending; }
  baselineCommitted(): void { this.baselinePending = false; }

  setRecoveryBudget(tokens: number): void { this.recoveryTokens = Math.max(0, tokens); }

  snapshot(): ToolContextSnapshot {
    return structuredClone({ version: 1, generation: this.catalog.generation,
      discoveryEntries: this.discoveryEntries,
      directory: this.catalog.directory, definitions: [...this.discovered.values()] });
  }

  directoryMessage(): Message {
    return { role: 'user', content: this.catalog.directory, isMeta: true,
      toolContext: { version: 1, baseline: this.snapshot(), baselineAttachment: true } };
  }

  restore(snapshot: ToolContextSnapshot): void {
    this.baselinePending = snapshot.generation !== this.catalog.generation;
    this.discovered.clear();
    for (const definition of snapshot.definitions) {
      const current = this.catalog.deferred.get(definition.definition.name);
      if (current?.version === definition.version && current.identity === definition.identity) {
        this.discovered.set(definition.definition.name, structuredClone(definition));
      }
    }
    this.pending.clear();
  }

  /** Called only after the record containing this delta was durably appended. */
  commit(record: ToolContextRecord): void {
    if (!isToolContextRecord(record)) throw new Error('Cannot commit invalid tool discovery metadata');
    for (const discovery of record.discoveries ?? []) {
      for (const definition of discovery.definitions) {
        const current = this.catalog.deferred.get(definition.definition.name);
        if (current?.version !== definition.version || current.identity !== definition.identity) {
          throw new Error('Cannot commit discovery for an unavailable tool definition');
        }
      }
    }
    for (const discovery of record.discoveries ?? []) {
      for (const definition of discovery.definitions) {
        this.discovered.set(definition.definition.name, structuredClone(definition));
      }
      this.pending.delete(discovery.callId);
    }
  }

  normalize(call: ToolUseBlock): NormalizedToolCall {
    if (call.name !== 'CallTool' || !this.discoveryEntries) {
      return { call, ...(this.catalog.deferred.has(call.name)
        ? { error: 'This tool is not declared for direct calls. Use ToolSearch, then CallTool in a later step.' } : {}) };
    }
    const input = call.input;
    if (!input || typeof input.tool !== 'string' || typeof input.arguments !== 'string' ||
        Object.keys(input).length !== 2) {
      return { call, error: 'CallTool requires exactly two strings: tool and arguments (a JSON object encoded as a string).' };
    }
    const definition = this.catalog.deferred.get(input.tool);
    if (!definition) return { call, error: 'This target is unavailable through CallTool. Call declared tools directly; use ToolSearch for other available tools.' };
    if (this.discovered.get(input.tool)?.version !== definition.version) {
      return { call, error: 'This tool definition has not been discovered in this context. Use ToolSearch and wait for its result before calling it.' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(input.arguments); }
    catch { return { call, error: 'CallTool arguments must contain complete, valid JSON. The tool did not run.' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { call, error: 'CallTool arguments must encode a JSON object, not an array, null, or a primitive.' };
    }
    return {
      call: { type: 'tool_use', id: call.id, name: input.tool, input: parsed as Record<string, unknown> },
      origin: { id: call.id, definitionVersion: definition.version, input: { tool: input.tool, arguments: input.arguments } },
    };
  }

  private search(input: Record<string, unknown>, callId?: string): ToolResult {
    if (!callId) return { content: 'ToolSearch requires a tracked call ID.', isError: true };
    const prior = this.pending.get(callId);
    if (prior) return { content: prior.content, isError: false };
    if (typeof input.query === 'string' && (input.query.length > TOOL_CONTEXT_LIMITS.queryCharacters * 2 ||
        Array.from(input.query).length > TOOL_CONTEXT_LIMITS.queryCharacters)) {
      log.warn('Tool search query exceeds its input bound', { callId, limit: TOOL_CONTEXT_LIMITS.queryCharacters });
      return { content: `ToolSearch queries are limited to ${TOOL_CONTEXT_LIMITS.queryCharacters} characters. Use a shorter purpose or an exact tool name.`, isError: true };
    }
    if (typeof input.query !== 'string' || !input.query.trim() ||
        (input.server !== undefined && typeof input.server !== 'string') ||
        (input.max_results !== undefined && (!Number.isInteger(input.max_results) ||
          Number(input.max_results) < 1 || Number(input.max_results) > TOOL_CONTEXT_LIMITS.maxResults))) {
      return { content: 'Provide a nonempty query, an optional server, and max_results between 1 and 10.', isError: true };
    }
    const matches = this.catalog.search(input.query, input.server as string | undefined);
    const selected: ToolDefinitionSnapshot[] = [];
    const display: Record<string, unknown>[] = [];
    const seenGuides = new Set([...this.discovered.values()].map(item => stableJson([item.identity, item.usageGuide])));
    let omitted = 0;
    const payload = (items: Record<string, unknown>[], skipped: number) => ({ tools: items,
      ...(skipped ? { notice: 'Some complete definitions did not fit. Narrow the query or select a specific tool.' }
        : items.length === 0 ? { notice: 'No matching tools. Try a service name, purpose, or exact tool name.' } : {}) });
    for (const match of matches.slice(0, Number(input.max_results ?? 5))) {
      const known = this.discovered.has(match.definition.name);
      const guideKey = stableJson([match.identity, match.usageGuide]);
      const item = known && !input.query.startsWith('select:')
        ? { name: match.definition.name, version: match.version, already_loaded: true }
        : { ...match.definition, version: match.version,
          ...(match.usageGuide && !seenGuides.has(guideKey) ? { usage_guide: match.usageGuide } : {}) };
      const candidate = JSON.stringify(payload([...display, item], 1));
      const reserved = new Map([...this.discovered.values(),
        ...[...this.pending.values()].flatMap(pending => pending.definitions), ...selected, ...(!known ? [match] : [])]
        .map(item => [item.definition.name, item]));
      const definitions = [...reserved.values()];
      const recovery = this.renderRecovery(definitions);
      if (candidate.length > this.resultCharacters || Buffer.byteLength(candidate, 'utf8') > TOOL_CONTEXT_LIMITS.searchBytes ||
          Buffer.byteLength(stableJson(definitions), 'utf8') > TOOL_CONTEXT_LIMITS.stateBytes ||
          estimateTokens(recovery) > this.recoveryTokens) {
        omitted++;
        continue;
      }
      display.push(item);
      seenGuides.add(guideKey);
      if (!known) selected.push(match);
    }
    const body = payload(display, omitted);
    const content = JSON.stringify(body);
    if (omitted) log.warn('Complete tool definitions did not fit the discovery budget', {
      callId, omitted, resultCharacters: this.resultCharacters, recoveryTokens: this.recoveryTokens,
    });
    if (content.length > this.resultCharacters) {
      return { content: 'ToolSearch result budget is too small.', isError: true };
    }
    this.pending.set(callId, { content, rendered: content, explicit: input.query.startsWith('select:'), settled: false,
      definitions: structuredClone(selected), payload: body });
    return { content, isError: false };
  }

  /** Verify the controlled result after all hooks and truncation, without trusting ToolResult.metadata. */
  settle(callId: string, result: ToolResult, envelope?: ToolDiscoveryEnvelope): { result: ToolResult; record?: ToolContextRecord } {
    const pending = this.pending.get(callId);
    if (!pending) return { result };
    const prefix = envelope?.prefix ?? '';
    const suffix = envelope?.suffix ?? '';
    const expectedLength = prefix.length + pending.content.length + suffix.length;
    const reason = result.isError ? 'tool-error' : expectedLength > this.resultCharacters ? 'character-budget'
      : result.content.length !== expectedLength ? 'payload-changed'
      : Buffer.byteLength(result.content, 'utf8') > TOOL_CONTEXT_LIMITS.searchBytes ? 'byte-budget'
      : result.content !== prefix + pending.content + suffix ? 'payload-changed' : undefined;
    if (reason) {
      this.pending.delete(callId);
      log.warn('Tool discovery result was rejected; definitions were not committed', { callId, reason });
      return { result: { content: truncateToolResult(
        'ToolSearch output was changed, truncated or exceeded its result budget. No new definitions were loaded. Retry the search.',
        Math.min(this.resultCharacters, TOOL_CONTEXT_LIMITS.searchBytes)), isError: true } };
    }
    const shown = pending.payload.tools.filter(item => item.input_schema !== undefined);
    pending.settled = true;
    pending.rendered = result.content;
    pending.envelope = prefix || suffix ? { prefix, suffix } : undefined;
    const presentation = { callId, definitions: shown.map(item => String(item.version)),
      guides: shown.filter(item => item.usage_guide !== undefined).map(item => String(item.version)),
      ...payloadSpan(pending.envelope, pending.content) };
    return { result, ...(pending.definitions.length || shown.length ? {
      record: { version: 1 as const,
        ...(pending.definitions.length ? { discoveries: [{ callId, definitions: structuredClone(pending.definitions) }] } : {}),
        ...(shown.length ? { presentations: [presentation] } : {}),
      },
    } : {}) };
  }

  recoveryMessage(): Message {
    return { role: 'user', content: this.renderRecovery([...this.discovered.values()]), isMeta: true,
      toolContext: { version: 1, baseline: this.snapshot(), baselineAttachment: true } };
  }

  /** Resolve duplicate discoveries only after hooks, in the order the model receives results. */
  finalizeResults(message: Message): void {
    if (!Array.isArray(message.content)) return;
    if (!message.content.some(block => block.type === 'tool_result' && this.pending.has(block.tool_use_id))) return;
    const known = new Set([...this.discovered.values()].map(item => item.version));
    const guides = new Set([...this.discovered.values()].map(item => stableJson([item.identity, item.usageGuide])));
    const discoveries: NonNullable<ToolContextRecord['discoveries']> = [];
    const presentations: NonNullable<ToolContextRecord['presentations']> = [];
    const updates: Array<{ block: ToolResultBlock; pending: PendingDiscovery;
      content: string; payloadText: string; payload: PendingDiscovery['payload']; definitions: ToolDefinitionSnapshot[] }> = [];
    const interrupted: Array<{ block: ToolResultBlock; callId: string; content: string }> = [];
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.is_error) continue;
      const pending = this.pending.get(block.tool_use_id);
      if (!pending) continue;
      if (!pending.settled) {
        interrupted.push({ block, callId: block.tool_use_id, content: truncateToolResult(
          'ToolSearch was interrupted before its result was accepted. No new definitions were loaded; search again.',
          Math.min(this.resultCharacters, TOOL_CONTEXT_LIMITS.searchBytes,
            typeof block.content === 'string' ? block.content.length : this.resultCharacters)) });
        continue;
      }
      if (block.content !== pending.rendered) continue;
      const candidates = new Map(pending.definitions.map(item => [item.version, item]));
      const definitions: ToolDefinitionSnapshot[] = [];
      const tools: Record<string, unknown>[] = pending.payload.tools.map(item => {
        const definition = this.catalog.deferred.get(String(item.name));
        if (!definition || definition.version !== item.version || item.input_schema === undefined) return item;
        if (known.has(definition.version) && !pending.explicit) {
          return { name: definition.definition.name, version: definition.version, already_loaded: true };
        }
        if (!known.has(definition.version)) {
          const candidate = candidates.get(definition.version);
          if (!candidate) throw new Error('Tool discovery result has no matching definition snapshot');
          definitions.push(candidate);
          known.add(definition.version);
        }
        if (!item.usage_guide) return item;
        const key = stableJson([definition.identity, definition.usageGuide]);
        if (!guides.has(key)) { guides.add(key); return item; }
        const { usage_guide: _usageGuide, ...withoutGuide } = item;
        return withoutGuide;
      });
      const payload = { ...pending.payload, tools };
      const payloadText = JSON.stringify(payload);
      const content = (pending.envelope?.prefix ?? '') + payloadText + (pending.envelope?.suffix ?? '');
      if (content.length > pending.rendered.length || Buffer.byteLength(content, 'utf8') > Buffer.byteLength(pending.rendered, 'utf8')) {
        throw new Error('Tool discovery finalization exceeded its delivered result budget');
      }
      if (definitions.length) discoveries.push({ callId: block.tool_use_id, definitions: structuredClone(definitions) });
      const shown = tools.filter(item => item.input_schema !== undefined);
      if (shown.length) presentations.push({ callId: block.tool_use_id, definitions: shown.map(item => String(item.version)),
        guides: shown.filter(item => item.usage_guide !== undefined).map(item => String(item.version)),
        ...payloadSpan(pending.envelope, payloadText) });
      updates.push({ block, pending, content, payloadText, payload, definitions });
    }
    const record: ToolContextRecord = { ...message.toolContext, version: 1 };
    delete record.discoveries;
    delete record.presentations;
    if (discoveries.length) record.discoveries = discoveries;
    if (presentations.length) record.presentations = presentations;
    for (const item of interrupted) {
      item.block.content = item.content;
      item.block.is_error = true;
      this.pending.delete(item.callId);
      log.warn('Unsettled tool discovery result was discarded', { callId: item.callId });
    }
    for (const update of updates) {
      update.block.content = update.content;
      update.pending.content = update.payloadText;
      update.pending.rendered = update.content;
      update.pending.payload = update.payload;
      update.pending.definitions = update.definitions;
    }
    if (Object.keys(record).length > 1) message.toolContext = record;
    else delete message.toolContext;
  }

  private renderRecovery(definitions: ToolDefinitionSnapshot[]): string {
    if (!this.catalog.directory && definitions.length === 0) return this.discoveryEntries
      ? 'No services currently require discovery. Previously discovered tools must still satisfy the current tool configuration.' : '';
    const guides = new Set<string>();
    return this.catalog.directory + '\nPreviously discovered tool definitions:\n' + JSON.stringify(definitions.map(item => {
      const key = stableJson([item.identity, item.usageGuide]);
      const include = item.usageGuide && !guides.has(key);
      guides.add(key);
      return { ...item.definition, version: item.version, ...(include ? { usage_guide: item.usageGuide } : {}) };
    }));
  }

  clear(): void { this.discovered.clear(); this.pending.clear(); this.baselinePending = true; }

  finishStep(): void { this.pending.clear(); }
  hasSearchResult(callId: string): boolean { return this.pending.has(callId); }
}
