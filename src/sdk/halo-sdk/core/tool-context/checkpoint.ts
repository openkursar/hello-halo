import type { Message } from '../../types/provider.js';
import { compareText, stableJson, TOOL_CONTEXT_LIMITS } from './catalog.js';
import { isToolContextRecord, readToolContextSnapshot } from './history.js';
import type { ToolContextSnapshot, ToolDefinitionSnapshot } from './types.js';

function guideKey(definition: ToolDefinitionSnapshot): string {
  return stableJson([definition.identity, definition.usageGuide]);
}

/** Text can avoid repeating a definition, but only journal metadata can establish discovery. */
function deliveredDefinitions(messages: readonly Message[], current: ReadonlyMap<string, ToolDefinitionSnapshot>) {
  const definitions = new Set<string>();
  const guides = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const presentation of message.toolContext?.presentations ?? []) {
      const block = message.content.find(block => block.type === 'tool_result' &&
        block.tool_use_id === presentation.callId && !block.is_error);
      if (!block || block.type !== 'tool_result' || typeof block.content !== 'string' ||
          Buffer.byteLength(block.content, 'utf8') > TOOL_CONTEXT_LIMITS.searchBytes) continue;
      let payload: unknown;
      const offset = presentation.payloadOffset ?? 0;
      const length = presentation.payloadLength ?? block.content.length;
      try { payload = JSON.parse(block.content.slice(offset, offset + length)); } catch { continue; }
      if (!payload || typeof payload !== 'object' || !('tools' in payload) || !Array.isArray(payload.tools)) continue;
      for (const version of presentation.definitions) {
        const definition = current.get(version);
        if (!definition) continue;
        const item = payload.tools.find(item => item && typeof item === 'object' &&
          item.version === definition.version && item.name === definition.definition.name &&
          stableJson({ name: item.name, description: item.description, input_schema: item.input_schema }) === stableJson(definition.definition));
        if (!item) continue;
        definitions.add(definition.version);
        if (presentation.guides.includes(version) && definition.usageGuide && item.usage_guide === definition.usageGuide) {
          guides.add(guideKey(definition));
        }
      }
    }
  }
  return { definitions, guides };
}

function renderRecovery(snapshot: ToolContextSnapshot, delivered: ReturnType<typeof deliveredDefinitions>): string {
  const guides = new Set(delivered.guides);
  const definitions = [...snapshot.definitions].sort((a, b) => compareText(a.definition.name, b.definition.name));
  const missing = definitions.filter(definition => !delivered.definitions.has(definition.version)).map(definition => {
    const key = guideKey(definition);
    const includeGuide = definition.usageGuide && !guides.has(key);
    if (includeGuide) guides.add(key);
    return { ...definition.definition, version: definition.version, ...(includeGuide ? { usage_guide: definition.usageGuide } : {}) };
  });
  const missingGuides = definitions.flatMap(definition => {
    const key = guideKey(definition);
    if (!definition.usageGuide || guides.has(key)) return [];
    guides.add(key);
    return [{ server: definition.server, usage_guide: definition.usageGuide }];
  });
  return [snapshot.directory,
    ...(missing.length ? ['Previously discovered tool definitions:\n' + JSON.stringify(missing)] : []),
    ...(missingGuides.length ? ['Service usage guides:\n' + JSON.stringify(missingGuides)] : []),
  ].filter(Boolean).join('\n');
}

/** Reconcile retained history with one current snapshot before measuring and saving a checkpoint. */
export function prepareToolContextCheckpoint(
  candidate: readonly Message[], sourceHistory: readonly Message[], currentSnapshot?: ToolContextSnapshot,
): Message[] {
  const cloned = structuredClone(candidate) as Message[];
  const baselineIndex = cloned.findIndex(message => message.toolContext?.baseline);
  const snapshot = structuredClone(currentSnapshot ?? cloned[baselineIndex]?.toolContext?.baseline);
  if (!snapshot || baselineIndex < 0) {
    if (currentSnapshot || sourceHistory.some(message => message.toolContext)) throw new Error('Tool context checkpoint is missing its baseline');
    return cloned;
  }
  if (!isToolContextRecord({ version: 1, baseline: snapshot })) throw new Error('Invalid current tool context snapshot');

  const versions = new Map<string, ToolDefinitionSnapshot>();
  for (const message of [...sourceHistory, ...cloned]) {
    const record = message.toolContext;
    if (!record) continue;
    if (!isToolContextRecord(record)) throw new Error('Invalid tool context journal metadata');
    for (const item of [...record.baseline?.definitions ?? [], ...record.baseline?.historicalDefinitions ?? [],
      ...record.discoveries?.flatMap(delta => delta.definitions) ?? []]) versions.set(item.version, item);
  }
  for (const item of [...snapshot.definitions, ...snapshot.historicalDefinitions ?? []]) versions.set(item.version, item);
  const current = new Map(snapshot.definitions.map(definition => [definition.version, definition]));
  const baselineMessage = cloned[baselineIndex];
  const messages = cloned.flatMap((message, index) => {
    const record = message.toolContext;
    if (!record) return [message];
    if (record.baseline) {
      if (index === baselineIndex) record.baseline = snapshot;
      else {
        const attachment = record.baselineAttachment === true;
        delete record.baseline;
        delete record.baselineAttachment;
        if (attachment && message.isMeta && typeof message.content === 'string' && Object.keys(record).length === 1) return [];
      }
    }
    if (record.discoveries) {
      record.discoveries = record.discoveries.flatMap(discovery => {
        const definitions = discovery.definitions.filter(definition => current.get(definition.version)?.identity === definition.identity);
        return definitions.length ? [{ ...discovery, definitions }] : [];
      });
      if (!record.discoveries.length) delete record.discoveries;
    }
    if (Object.keys(record).length === 1) delete message.toolContext;
    return [message];
  });

  const historical = new Map<string, ToolDefinitionSnapshot>();
  for (const message of messages) {
    const referenced = [...message.toolContext?.calls?.map(call => call.definitionVersion) ?? [],
      ...message.toolContext?.presentations?.flatMap(item => item.definitions) ?? []];
    for (const version of referenced) {
      if (current.has(version)) continue;
      const original = versions.get(version);
      if (!original) throw new Error('Retained tool call definition is missing from checkpoint source');
      historical.set(original.version, original);
    }
  }
  delete snapshot.historicalDefinitions;
  if (historical.size) snapshot.historicalDefinitions = [...historical.values()].sort((a, b) => compareText(a.version, b.version));
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > TOOL_CONTEXT_LIMITS.stateBytes * 2) {
    throw new Error('Tool context checkpoint state exceeds its restoration limit');
  }
  readToolContextSnapshot(messages);
  if (baselineMessage.isMeta && baselineMessage.toolContext?.baselineAttachment === true) {
    baselineMessage.content = renderRecovery(snapshot, deliveredDefinitions(messages, current));
    const summary = messages[0];
    if (!baselineMessage.content && summary !== baselineMessage && summary.role === 'user' &&
        typeof summary.content === 'string' && summary.content && !summary.toolContext?.baseline) {
      summary.toolContext = { ...summary.toolContext, version: 1, baseline: snapshot, baselineAttachment: false };
      if (snapshot.discoveryEntries || snapshot.directory || snapshot.definitions.length) summary.isMeta = true;
      messages.splice(messages.indexOf(baselineMessage), 1);
    }
  }
  readToolContextSnapshot(messages);
  return messages;
}
