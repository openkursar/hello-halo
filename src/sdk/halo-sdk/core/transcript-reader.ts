import { promises as fs } from 'node:fs';
import { readJsonl } from '../utils/jsonl-reader.js';
import type { ContentBlock, Message } from '../types/provider.js';
import { getLogger } from '../utils/logger.js';
import { isToolContextRecord, mergeToolContextRecords, readToolContextSnapshot, type ToolContextRecord } from './tool-context/index.js';

const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
export const MAX_HISTORY_MESSAGES = 4096;
/** Kept below the JSONL reader's 32 MiB line limit and the retained-history byte budget. */
export const MAX_COMPACT_CHECKPOINT_BYTES = 16 * 1024 * 1024;

/** Private journal record, not an SDK chat event. */
export interface CompactCheckpointMessage {
  type: 'compact_checkpoint';
  checkpointVersion: 1 | 2;
  uuid: string;
  summary: string;
  messages: readonly Message[];
}

export function isCompactCheckpoint(entry: Record<string, unknown>): entry is Record<string, unknown> & CompactCheckpointMessage {
  const valid = entry.type === 'compact_checkpoint' && (entry.checkpointVersion === 1 || entry.checkpointVersion === 2) &&
    typeof entry.uuid === 'string' && typeof entry.summary === 'string' &&
    Array.isArray(entry.messages) && entry.messages.length > 0 && entry.messages.length <= MAX_HISTORY_MESSAGES &&
    entry.messages.every(message => message && (message.role === 'user' || message.role === 'assistant') &&
      (typeof message.content === 'string' || (Array.isArray(message.content) &&
        message.content.every((block: unknown) => block !== null && typeof block === 'object' &&
          typeof (block as { type?: unknown }).type === 'string'))) &&
      (message.toolContext === undefined || isToolContextRecord(message.toolContext)));
  if (!valid) return false;
  try {
    const snapshot = readToolContextSnapshot(entry.messages as Message[]);
    return entry.checkpointVersion === 2 ? snapshot !== undefined : snapshot === undefined;
  } catch { return false; }
}

const OMITTED_HISTORY_NOTICE =
  '[Earlier conversation was omitted from active memory to stay within the history size limit. The original transcript remains on disk. Do not assume missing details.]';

/** What a bounded history read kept, and what it could not use. */
export interface HistoryReadReport {
  messages: Message[];
  /** Records that could not be parsed. */
  damaged: number;
  /** Records left out to stay within the size bounds. */
  omitted: number;
  /** New-format tool context cannot be treated as readable legacy history. */
  toolContextDamaged?: true;
  /** Present only for an anchored read. */
  anchorFound?: boolean;
}

interface HistoryRecord {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  bytes: number;
  /** The reply an assistant record belongs to; one reply can span several records. */
  reply?: string;
  /** Belongs with the tool results before it rather than starting a new user turn. */
  attached: boolean;
  /** A checkpoint message is already grouped and retains internal model-history flags. */
  checkpoint?: Message;
  toolContext?: ToolContextRecord;
  isMeta?: boolean;
}

/**
 * Bounded records and retained history, including files with no newline.
 *
 * Accepts the transcript shapes Claude Code writes as well as this SDK's own.
 * Both record one reply over several lines: this SDK tags each streamed block
 * with a local `responseUuid`, Claude Code repeats the provider message id.
 * Claude Code also writes parallel tool results and the text attached to them
 * on separate user lines, and marks compaction with a `compact_boundary` record
 * followed by a summary. Records are regrouped into the reply / result shape
 * the model saw, and only the history after the last compaction boundary is
 * restored.
 */
export async function readHistoryReport(path: string, stopAtMessageUuid?: string, signal?: AbortSignal): Promise<HistoryReadReport> {
  signal?.throwIfAborted();
  let records: HistoryRecord[] = [];
  let head = 0;
  let retainedBytes = 0;
  let omitted = 0;
  let damaged = 0;
  let sawToolContext = false;
  let toolContextDamaged = false;
  let toolContextError: string | undefined;
  let anchorFound = false;
  const size = (await fs.stat(path)).size;
  const start = stopAtMessageUuid === undefined ? Math.max(0, size - MAX_HISTORY_BYTES) : 0;
  if (start > 0) omitted++;
  // A tail can start inside another conversation's sidechain. Inspect only the
  // first bounded record to distinguish a child journal from a main journal.
  let sidechain: boolean | undefined;
  if (start > 0) {
    sidechain = false;
    const file = await fs.open(path, 'r');
    try {
      const prefix = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
      const firstLine = prefix.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
      // SDK metadata records put their version first, even when the body exceeds this bounded header read.
      sawToolContext = firstLine.startsWith('{"toolContextVersion":');
      try {
        const first = JSON.parse(firstLine);
        sidechain = first?.type === 'agent_task' || first?.isSidechain === true;
        sawToolContext ||= first?.message?.toolContext !== undefined || first?.checkpointVersion === 2;
      } catch { /* An incomplete header cannot establish sidechain ownership. */ }
    } finally { await file.close(); }
  }
  for await (const record of readJsonl(path, { start, signal, onOversized: () => { omitted++; } })) {
    signal?.throwIfAborted();
    const entry = record.value;
    if (!entry) {
      damaged++;
      if (record.line.startsWith('{"toolContextVersion":')) {
        sawToolContext = true;
        toolContextDamaged = true;
      }
      continue;
    }
    if (sidechain !== undefined && (entry.isSidechain === true) !== sidechain) continue;
    if (stopAtMessageUuid !== undefined && entry.uuid === stopAtMessageUuid) anchorFound = true;
    if (entry.toolContextVersion !== undefined && !['user', 'assistant', 'assistant_metadata', 'compact_checkpoint'].includes(String(entry.type))) {
      sawToolContext = true;
      toolContextDamaged = true;
      damaged++;
      if (stopAtMessageUuid !== undefined && entry.uuid === stopAtMessageUuid) break;
      continue;
    }
    if (entry.type === 'compact_checkpoint') {
      const newFormat = entry.checkpointVersion !== 1;
      if (!isCompactCheckpoint(entry) || record.bytes > MAX_COMPACT_CHECKPOINT_BYTES || (sawToolContext && !newFormat)) {
        damaged++;
        toolContextDamaged ||= newFormat || sawToolContext;
      } else {
        sawToolContext = entry.checkpointVersion === 2;
        toolContextDamaged = false;
        sidechain ??= entry.isSidechain === true;
        records = entry.messages.map(message => ({
          role: message.role, content: message.content, attached: false, checkpoint: message,
          bytes: Buffer.byteLength(JSON.stringify(message), 'utf8') * 2,
        }));
        head = 0;
        retainedBytes = records.reduce((bytes, message) => bytes + message.bytes, 0);
        omitted = 0;
        damaged = 0;
      }
      if (stopAtMessageUuid !== undefined && entry.uuid === stopAtMessageUuid) break;
      continue;
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      if (sawToolContext) {
        damaged++;
        toolContextDamaged = true;
        continue;
      }
      // The summary that follows stands in for everything before it.
      records = [];
      head = 0;
      retainedBytes = 0;
      omitted = 0;
      damaged = 0;
    }
    const message = entry.message as Partial<Message> & { id?: unknown } | undefined;
    if ((entry.type === 'user' || entry.type === 'assistant') &&
        (entry.toolContextVersion !== undefined || message?.toolContext !== undefined)) {
      sawToolContext = true;
      const requiresRecord = message?.toolContext !== undefined || entry.toolContextRecord !== false;
      if ((entry.toolContextVersion !== undefined && entry.toolContextVersion !== 1) ||
          (entry.toolContextRecord !== undefined && typeof entry.toolContextRecord !== 'boolean') ||
          (message?.role !== 'user' && message?.role !== 'assistant') ||
          (typeof message?.content !== 'string' && !Array.isArray(message?.content)) ||
          (requiresRecord && !isToolContextRecord(message?.toolContext))) {
        damaged++;
        toolContextDamaged = true;
        if (stopAtMessageUuid !== undefined && entry.uuid === stopAtMessageUuid) break;
        continue;
      }
    }
    if ((entry.type === 'user' || entry.type === 'assistant') &&
        (message?.role === 'user' || message?.role === 'assistant') && message.content !== undefined) {
      sidechain ??= entry.isSidechain === true;
      const bytes = record.bytes * 2;
      while (records.length > head && (retainedBytes + bytes > MAX_HISTORY_BYTES || records.length - head >= MAX_HISTORY_MESSAGES)) {
        retainedBytes -= records[head++].bytes;
        omitted++;
      }
      if (head >= MAX_HISTORY_MESSAGES) { records = records.slice(head); head = 0; }
      const content = message.content;
      records.push({
        role: message.role,
        content,
        bytes,
        reply: message.role === 'assistant' ? replyKey(entry, message) : undefined,
        attached: message.role === 'user' && (entry.isMeta === true || isToolResultOnly(content)),
        ...(message.toolContext ? { toolContext: message.toolContext } : {}),
        ...(message.isMeta ? { isMeta: true } : {}),
      });
      retainedBytes += bytes;
    }
    if (stopAtMessageUuid !== undefined && entry.uuid === stopAtMessageUuid) break;
  }
  let messages: Message[];
  signal?.throwIfAborted();
  try { messages = groupRecords(records.slice(head)); }
  catch (error) {
    toolContextDamaged = true;
    damaged++;
    toolContextError = String(error);
    messages = records.slice(head).map(record => record.checkpoint ?? {
      role: record.role, content: record.content,
      ...(record.toolContext ? { toolContext: record.toolContext } : {}),
      ...(record.isMeta ? { isMeta: true } : {}),
    });
  }
  if (sawToolContext) {
    try {
      if (!readToolContextSnapshot(messages) || damaged > 0) toolContextDamaged = true;
    } catch (error) { toolContextDamaged = true; toolContextError = String(error); }
  }
  if (damaged || omitted || toolContextDamaged) {
    getLogger('Transcript').warn('history restored with bounded or incomplete records', {
      path, omitted, damaged, toolContextDamaged, ...(toolContextError ? { error: toolContextError } : {}), retained: records.length - head,
    });
  }
  if (omitted) messages.unshift({ role: 'user', content: OMITTED_HISTORY_NOTICE });
  return { messages, damaged, omitted, ...(toolContextDamaged ? { toolContextDamaged: true } : {}),
    ...(stopAtMessageUuid !== undefined ? { anchorFound } : {}) };
}

/** Bounded records and retained history, or null when nothing readable remains. */
export async function readHistory(path: string, stopAtMessageUuid?: string): Promise<Message[] | null> {
  const { messages } = await readHistoryReport(path, stopAtMessageUuid);
  return messages.length ? messages : null;
}

/**
 * The local response id wins over the provider's message id because providers
 * may reuse theirs across responses. Either only groups within one session scope.
 */
function replyKey(entry: Record<string, unknown>, message: { id?: unknown }): string | undefined {
  const local = typeof entry.responseUuid === 'string' && entry.responseUuid ? entry.responseUuid : undefined;
  const provider = typeof message.id === 'string' && message.id ? message.id : undefined;
  if (!local && !provider) return undefined;
  return JSON.stringify([local ? 'response' : 'message', local ?? provider, entry.sessionId ?? null, entry.parent_tool_use_id ?? null]);
}

function isToolResultOnly(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 &&
    content.every(block => (block as { type?: unknown } | null)?.type === 'tool_result');
}

function blocksOf(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content;
}

/**
 * Rebuild one assistant message per reply and one user message for its tool
 * results. A record of the same reply may follow some of its results (Claude
 * Code writes each block as it completes), so a reply stays open while only its
 * results and their attachments have followed it.
 */
function groupRecords(records: readonly HistoryRecord[]): Message[] {
  const messages: Message[] = [];
  let open: { key: string; reply: Message & { content: ContentBlock[] }; results?: Message & { content: ContentBlock[] } } | undefined;
  const isOpenTail = (): boolean => open !== undefined &&
    (messages[messages.length - 1] === open.reply || messages[messages.length - 1] === open.results);

  for (const record of records) {
    const privateFields = {
      ...(record.toolContext ? { toolContext: record.toolContext } : {}),
      ...(record.isMeta ? { isMeta: true } : {}),
    };
    if (record.checkpoint) {
      messages.push(record.checkpoint);
      open = undefined;
      continue;
    }
    if (record.role === 'assistant') {
      if (open && record.reply === open.key && isOpenTail()) {
        open.reply.content.push(...blocksOf(record.content));
        open.reply.toolContext = mergeToolContextRecords(open.reply.toolContext, record.toolContext);
        continue;
      }
      if (record.reply && Array.isArray(record.content)) {
        const reply = { role: 'assistant' as const, content: [...record.content], ...privateFields };
        messages.push(reply);
        open = { key: record.reply, reply };
      } else {
        messages.push({ role: 'assistant', content: record.content, ...privateFields });
        open = undefined;
      }
      continue;
    }
    if (open && record.attached && !record.isMeta && !record.toolContext?.baseline && isOpenTail()) {
      if (!open.results) {
        open.results = { role: 'user', content: [] };
        messages.push(open.results);
      }
      open.results.content.push(...blocksOf(record.content));
      open.results.toolContext = mergeToolContextRecords(open.results.toolContext, record.toolContext);
      continue;
    }
    messages.push({ role: 'user', content: record.content, ...privateFields });
    open = undefined;
  }

  // The API requires tool results ahead of any other content in their message.
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const results = message.content.filter(block => block.type === 'tool_result');
    if (results.length === 0 || results.length === message.content.length) continue;
    message.content = [...results, ...message.content.filter(block => block.type !== 'tool_result')];
  }
  return messages;
}

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

export async function readTranscriptPage(path: string, sessionId: string, options: {
  offset?: number; limit?: number; includeSystemMessages?: boolean;
} = {}): Promise<TranscriptMessage[]> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? MAX_HISTORY_MESSAGES;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > MAX_HISTORY_MESSAGES) {
    getLogger('Transcript').warn('invalid history pagination refused', { path });
    throw new RangeError('History pagination requires a nonnegative offset and a limit from 0 to 4096');
  }
  if (limit === 0) return [];
  const messages: TranscriptMessage[] = [];
  const responseTargets = new Map<string, TranscriptMessage>();
  const responseKey = (entry: Record<string, unknown>): string | undefined =>
    typeof entry.responseUuid === 'string' ? JSON.stringify([
      entry.responseUuid, entry.sessionId ?? sessionId, entry.parent_tool_use_id ?? null, entry.isSidechain ?? false,
    ]) : undefined;
  let skipped = 0;
  let bytes = 0;
  let damaged = 0;
  try {
    for await (const record of readJsonl(path)) {
      const entry = record.value;
      if (!entry) { damaged++; continue; }
      const internalMessage = entry.message as Partial<Message> | undefined;
      const internalContext = internalMessage?.isMeta === true && internalMessage.toolContext?.baselineAttachment === true;
      const visible = !internalContext && (entry.type === 'user' || entry.type === 'assistant' ||
        (options.includeSystemMessages && entry.type === 'system'));
      if (visible && skipped++ < offset) continue;
      if (skipped < offset) continue;
      if (visible && messages.length === limit) {
        if (options.limit === undefined) throw new RangeError('History exceeds the default page limit. Supply limit and offset.');
        break;
      }
      bytes += record.bytes;
      if (bytes > MAX_HISTORY_BYTES) throw new RangeError('History page exceeds 64 MiB. Request a smaller limit.');
      if (entry.type === 'assistant_metadata') {
        const key = responseKey(entry);
        const target = key ? responseTargets.get(key) : undefined;
        const metadata = entry.message;
        if (target?.message && typeof target.message === 'object' && metadata && typeof metadata === 'object') {
          const enriched = { ...target.message } as Record<string, unknown>;
          for (const field of ['id', 'model', 'stop_reason', 'stop_sequence', 'usage']) {
            if (field in metadata) enriched[field] = (metadata as Record<string, unknown>)[field];
          }
          target.message = enriched;
          if (options.limit !== undefined && messages.length === limit) break;
        }
        continue;
      }
      if (!visible) continue;
      const message: TranscriptMessage = { type: entry.type as TranscriptMessage['type'], uuid: (entry.uuid as string) ?? '',
        session_id: (entry.sessionId as string) ?? sessionId, message: entry.message ?? null,
        parent_tool_use_id: (entry.parent_tool_use_id as string | null) ?? null };
      if (message.message && typeof message.message === 'object' && !Array.isArray(message.message)) {
        const { toolContext: _toolContext, ...publicMessage } = message.message as Record<string, unknown>;
        message.message = publicMessage;
      }
      messages.push(message);
      const key = entry.type === 'assistant' ? responseKey(entry) : undefined;
      if (key) responseTargets.set(key, message);
      if (options.limit !== undefined && messages.length === limit && !key) break;
    }
  } catch (error) {
    if (options.limit !== undefined && messages.length === limit) {
      getLogger('Transcript').warn('history page returned without final response metadata', { path, offset, limit, error: String(error) });
      return messages;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    getLogger('Transcript').warn('history page could not be read', { path, offset, limit, error: String(error) });
    throw error;
  } finally {
    if (damaged) getLogger('Transcript').warn('malformed history records skipped', { path, count: damaged });
  }
  return messages;
}
