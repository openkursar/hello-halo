import type { Message, ContentBlock } from '../../types/provider.js';
import { fingerprint, stableJson, TOOL_CONTEXT_LIMITS } from './catalog.js';
import type { ToolContextRecord, ToolContextSnapshot, ToolDefinitionSnapshot } from './types.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function definition(value: unknown): value is ToolDefinitionSnapshot {
  if (!object(value) || typeof value.server !== 'string' || typeof value.identity !== 'string' ||
      typeof value.originalName !== 'string' || typeof value.version !== 'string' ||
      (value.usageGuide !== undefined && typeof value.usageGuide !== 'string') || !object(value.definition)) return false;
  if (Object.keys(value).some(key => !['server', 'identity', 'originalName', 'version', 'definition', 'usageGuide'].includes(key))) return false;
  const tool = value.definition;
  if (typeof tool.name !== 'string' || typeof tool.description !== 'string' || !object(tool.input_schema)) return false;
  if (Object.keys(tool).some(key => !['name', 'description', 'input_schema'].includes(key))) return false;
  const { version, ...content } = value;
  return version === fingerprint(content);
}

function snapshot(value: unknown): value is ToolContextSnapshot {
  return object(value) && value.version === 1 && typeof value.generation === 'string' && typeof value.discoveryEntries === 'boolean' &&
    !Object.keys(value).some(key => !['version', 'discoveryEntries', 'generation', 'directory', 'definitions', 'historicalDefinitions'].includes(key)) &&
    typeof value.directory === 'string' && Array.isArray(value.definitions) && value.definitions.every(definition) &&
    new Set(value.definitions.map(item => item.definition.name)).size === value.definitions.length &&
    (value.historicalDefinitions === undefined || (Array.isArray(value.historicalDefinitions) &&
      value.historicalDefinitions.every(definition) &&
      new Set(value.historicalDefinitions.map(item => item.version)).size === value.historicalDefinitions.length));
}

/** Reject partial or future metadata instead of treating a new journal as legacy history. */
export function isToolContextRecord(value: unknown): value is ToolContextRecord {
  if (!object(value) || value.version !== 1 || Buffer.byteLength(JSON.stringify(value), 'utf8') > TOOL_CONTEXT_LIMITS.stateBytes * 2) return false;
  if (Object.keys(value).some(key => !['version', 'baseline', 'baselineAttachment', 'calls', 'discoveries', 'rejectedCalls', 'directCalls', 'presentations'].includes(key))) return false;
  if (value.baseline !== undefined && !snapshot(value.baseline)) return false;
  if (value.baselineAttachment !== undefined && (typeof value.baselineAttachment !== 'boolean' || value.baseline === undefined)) return false;
  if (value.discoveries !== undefined && (!Array.isArray(value.discoveries) || !value.discoveries.every(item =>
    object(item) && Object.keys(item).length === 2 && typeof item.callId === 'string' && Array.isArray(item.definitions) && item.definitions.every(definition)))) return false;
  if (value.calls !== undefined && (!Array.isArray(value.calls) || !value.calls.every(item => object(item) &&
    Object.keys(item).length === 3 && typeof item.id === 'string' && typeof item.definitionVersion === 'string' && object(item.input) &&
    typeof item.input.tool === 'string' && typeof item.input.arguments === 'string' && Object.keys(item.input).length === 2))) return false;
  if (value.rejectedCalls !== undefined && (!Array.isArray(value.rejectedCalls) || !value.rejectedCalls.every(item =>
    object(item) && typeof item.id === 'string' && typeof item.name === 'string' && Object.keys(item).length === 2))) return false;
  if (value.directCalls !== undefined && (!Array.isArray(value.directCalls) || !value.directCalls.every(item =>
    object(item) && typeof item.id === 'string' && typeof item.name === 'string' && Object.keys(item).length === 2))) return false;
  if (value.presentations !== undefined && (!Array.isArray(value.presentations) || !value.presentations.every(item =>
    object(item) && Object.keys(item).every(key => ['callId', 'definitions', 'guides', 'payloadOffset', 'payloadLength'].includes(key)) &&
    typeof item.callId === 'string' &&
    ((!Object.hasOwn(item, 'payloadOffset') && !Object.hasOwn(item, 'payloadLength')) ||
      (Number.isSafeInteger(item.payloadOffset) && (item.payloadOffset as number) >= 0 &&
        Number.isSafeInteger(item.payloadLength) && (item.payloadLength as number) > 0)) &&
    Array.isArray(item.definitions) && item.definitions.every(version => typeof version === 'string') &&
    new Set(item.definitions).size === item.definitions.length && Array.isArray(item.guides) &&
    item.guides.every(version => typeof version === 'string' && (item.definitions as unknown[]).includes(version)) &&
    new Set(item.guides).size === item.guides.length))) return false;
  const calls = [...(value.calls as { id: string }[] | undefined) ?? [], ...(value.rejectedCalls as { id: string }[] | undefined) ?? [],
    ...(value.directCalls as { id: string }[] | undefined) ?? []];
  if (new Set(calls.map(call => call.id)).size !== calls.length) return false;
  return value.baseline !== undefined || value.calls !== undefined || value.discoveries !== undefined || value.rejectedCalls !== undefined ||
    value.directCalls !== undefined || value.presentations !== undefined;
}

export function mergeToolContextRecords(a?: ToolContextRecord, b?: ToolContextRecord): ToolContextRecord | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.baseline && b.baseline) throw new Error('Cannot merge two tool context baselines');
  return { version: 1, ...(a.baseline || b.baseline ? { baseline: a.baseline ?? b.baseline } : {}),
    ...(a.baselineAttachment !== undefined || b.baselineAttachment !== undefined ? { baselineAttachment: a.baselineAttachment ?? b.baselineAttachment } : {}),
    ...(a.calls || b.calls ? { calls: [...a.calls ?? [], ...b.calls ?? []] } : {}),
    ...(a.rejectedCalls || b.rejectedCalls ? { rejectedCalls: [...a.rejectedCalls ?? [], ...b.rejectedCalls ?? []] } : {}),
    ...(a.directCalls || b.directCalls ? { directCalls: [...a.directCalls ?? [], ...b.directCalls ?? []] } : {}),
    ...(a.presentations || b.presentations ? { presentations: [...a.presentations ?? [], ...b.presentations ?? []] } : {}),
    ...(a.discoveries || b.discoveries ? { discoveries: [...a.discoveries ?? [], ...b.discoveries ?? []] } : {}) };
}

/** Only structured, SDK-authored journal fields can establish discovery. */
export function readToolContextSnapshot(messages: readonly Message[]): ToolContextSnapshot | undefined {
  let current: ToolContextSnapshot | undefined;
  const known = new Map<string, ToolDefinitionSnapshot>();
  const versions = new Map<string, ToolDefinitionSnapshot>();
  const issued = new Set<string>();
  const rejected = new Set<string>();
  for (const message of messages) {
    const record = message.toolContext;
    if (record !== undefined && !isToolContextRecord(record)) throw new Error('Invalid tool context journal metadata');
    if (record?.baseline) {
      if (message.role !== 'user' || (!message.isMeta && (record.baseline.discoveryEntries || record.baseline.directory ||
          record.baseline.definitions.length))) throw new Error('Tool context baseline is not an internal user attachment');
      current = structuredClone(record.baseline);
      known.clear();
      for (const item of current.definitions) {
        known.set(item.definition.name, item);
        versions.set(item.version, item);
      }
      for (const item of current.historicalDefinitions ?? []) versions.set(item.version, item);
    }
    if (!current) {
      if (record !== undefined) throw new Error('Tool context journal is missing its baseline');
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const calls = blocks.filter(block => block.type === 'tool_use');
      const origins = new Map(record?.calls?.map(call => [call.id, call]));
      const refused = new Map(record?.rejectedCalls?.map(call => [call.id, call]));
      const direct = new Map(record?.directCalls?.map(call => [call.id, call]));
      for (const call of calls) {
        if (issued.has(call.id)) throw new Error('Duplicate tool call in tool context history');
        issued.add(call.id);
        const origin = origins.get(call.id);
        const refusal = refused.get(call.id);
        const directCall = direct.get(call.id);
        if (origin) {
          const original = versions.get(origin.definitionVersion);
          if (!original || original.definition.name !== call.name || call.name !== origin.input.tool) {
            throw new Error('Tool call origin does not match its discovered definition');
          }
          let input: unknown;
          try { input = JSON.parse(origin.input.arguments); }
          catch { throw new Error('Tool call origin contains invalid JSON arguments'); }
          if (!object(input)) throw new Error('Tool call origin arguments are not an object');
          if (stableJson(input) !== stableJson(call.input)) throw new Error('Tool call origin arguments do not match the recorded canonical input');
          origins.delete(call.id);
        } else if (refusal) {
          if (refusal.name !== call.name) throw new Error('Rejected tool call identity does not match its block');
          refused.delete(call.id);
          rejected.add(call.id);
        } else if (directCall) {
          if (directCall.name !== call.name) throw new Error('Direct tool call identity does not match its block');
          direct.delete(call.id);
        } else if (known.has(call.name)) {
          throw new Error('Discovered tool call is missing its original representation');
        }
      }
      if (origins.size || refused.size || direct.size) throw new Error('Tool call metadata has no matching assistant block');
    } else if (record?.calls?.length || record?.rejectedCalls?.length || record?.directCalls?.length) {
      throw new Error('Tool call metadata is not attached to an assistant message');
    }
    for (const block of blocks) {
      if (block.type === 'tool_result' && rejected.has(block.tool_use_id) && !block.is_error) {
        throw new Error('Rejected tool call has a successful result');
      }
    }
    for (const delta of record?.discoveries ?? []) {
      if (message.role !== 'user' || !blocks.some(block =>
        block.type === 'tool_result' && block.tool_use_id === delta.callId && !block.is_error)) {
        throw new Error('Tool discovery journal has no matching successful result');
      }
      for (const item of delta.definitions) {
        known.set(item.definition.name, structuredClone(item));
        versions.set(item.version, item);
      }
    }
    for (const presentation of record?.presentations ?? []) {
      const result = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === presentation.callId && !block.is_error);
      if (message.role !== 'user' || !result || result.type !== 'tool_result') {
        throw new Error('Tool presentation has no matching successful result');
      }
      if (presentation.payloadOffset !== undefined && (typeof result.content !== 'string' ||
          presentation.payloadOffset + presentation.payloadLength! > result.content.length)) {
        throw new Error('Tool presentation payload span is outside its result');
      }
      if (presentation.definitions.some(version => !versions.has(version)) ||
          presentation.guides.some(version => !versions.get(version)?.usageGuide)) {
        throw new Error('Tool presentation references an unknown definition or guide');
      }
    }
  }
  return current ? { ...current, definitions: [...known.values()] } : undefined;
}

/** Model history keeps the exact wrapper and JSON string emitted before execution hooks ran. */
export function projectToolContextMessages(messages: readonly Message[]): Message[] {
  return messages.map(projectMessage);
}

function projectMessage(message: Message): Message {
  if (!Object.hasOwn(message, 'toolContext')) return message;
  const origins = new Map(message.toolContext?.calls?.map(call => [call.id, call]));
  const content: string | ContentBlock[] = typeof message.content === 'string' ? message.content
    : message.content.map(block => {
      if (block.type !== 'tool_use') return block;
      const origin = origins.get(block.id);
      return origin ? { type: 'tool_use', id: block.id, name: 'CallTool', input: { ...origin.input } } : block;
    });
  return { role: message.role, content, ...(message.isMeta ? { isMeta: true } : {}) };
}

/** Reuse immutable history views so TokenBudget does not recount old discovery payloads each step. */
export function createToolContextProjector(): (messages: readonly Message[]) => Message[] {
  const cache = new WeakMap<Message, {
    content: Message['content']; record: Message['toolContext']; role: Message['role'];
    isMeta: Message['isMeta']; projected: Message;
  }>();
  return messages => messages.map(message => {
    if (!Object.hasOwn(message, 'toolContext')) return message;
    const previous = cache.get(message);
    if (previous && previous.content === message.content && previous.record === message.toolContext &&
        previous.role === message.role && previous.isMeta === message.isMeta) return previous.projected;
    const projected = projectMessage(message);
    cache.set(message, { content: message.content, record: message.toolContext, role: message.role,
      isMeta: message.isMeta, projected });
    return projected;
  });
}
