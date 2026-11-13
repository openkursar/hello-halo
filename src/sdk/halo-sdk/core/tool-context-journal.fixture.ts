import { readFile } from 'node:fs/promises';
import { getSessionMessages, readSessionToolContextMode, type SessionToolContextMode } from '../index.js';

interface Snapshot {
  discoveryEntries: boolean;
  definitions: { definition: { name: string }; version: string }[];
}
interface JournalRecord {
  baseline?: Snapshot;
  calls?: { id: string }[];
  discoveries?: { callId: string; definitions: { definition: { name: string }; version: string }[] }[];
  presentations?: { callId: string }[];
}
export interface JournalContext {
  /** The public entries accepted the journal, and the mode they report. */
  readable: boolean;
  mode: SessionToolContextMode;
  /** Baselines in journal order, the last one being the current snapshot. */
  baselines: Snapshot[];
  /** Discovered definitions in delivery order, matching the snapshot after the last baseline. */
  definitions: { name: string; version: string }[];
  calls: string[];
  discoveries: string[];
  presentations: string[];
}

/**
 * Tool context as the runtime persisted it. The public entries expose no private
 * metadata, so it is read from the same journal lines once the public view accepted the file.
 */
export async function journalContext(
  sessionId: string,
  path: string,
  options: { cwd: string; env: Record<string, string | undefined> },
): Promise<JournalContext> {
  const [messages, mode, raw] = await Promise.all([
    getSessionMessages(sessionId, options),
    readSessionToolContextMode(sessionId, options),
    readFile(path, 'utf8'),
  ]);
  return readJournalContext(raw, messages.length > 0, mode);
}

/** Context at a public message UUID: every record through that message, as the reader's anchor does. */
export function readJournalAnchor(raw: string, uuid: string): { anchorFound: boolean; context: JournalContext } {
  const lines = raw.split('\n').filter(Boolean);
  const index = lines.findIndex(line => (JSON.parse(line) as { uuid?: string }).uuid === uuid);
  if (index < 0) return { anchorFound: false, context: readJournalContext('', false, 'full') };
  return { anchorFound: true, context: readJournalContext(lines.slice(0, index + 1).join('\n'), true, 'full') };
}

export function readJournalContext(raw: string, readable: boolean, mode: SessionToolContextMode): JournalContext {
  const entries = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
    type?: string; message?: { toolContext?: JournalRecord }; messages?: { toolContext?: JournalRecord }[];
  });
  const baselines: Snapshot[] = [];
  const definitions = new Map<string, { name: string; version: string }>();
  const calls: string[] = [];
  const discoveries: string[] = [];
  const presentations: string[] = [];
  const apply = (record: JournalRecord) => {
    if (record.baseline) {
      // A baseline is a snapshot: it replaces everything recorded before it.
      baselines.push(record.baseline);
      definitions.clear(); calls.length = 0; discoveries.length = 0; presentations.length = 0;
      for (const item of record.baseline.definitions) definitions.set(item.definition.name, { name: item.definition.name, version: item.version });
    }
    for (const call of record.calls ?? []) calls.push(call.id);
    for (const discovery of record.discoveries ?? []) {
      discoveries.push(discovery.callId);
      for (const item of discovery.definitions) definitions.set(item.definition.name, { name: item.definition.name, version: item.version });
    }
    for (const presentation of record.presentations ?? []) presentations.push(presentation.callId);
  };
  for (const entry of entries) {
    // A checkpoint replaces the model history, so state before it no longer applies.
    if (entry.type === 'compact_checkpoint') {
      baselines.length = 0; definitions.clear(); calls.length = 0; discoveries.length = 0; presentations.length = 0;
      for (const message of entry.messages ?? []) if (message.toolContext) apply(message.toolContext);
      continue;
    }
    if (entry.message?.toolContext) apply(entry.message.toolContext);
  }
  return { readable, mode, baselines, definitions: [...definitions.values()], calls, discoveries, presentations };
}
