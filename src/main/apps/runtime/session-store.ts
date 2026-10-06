/**
 * Session Detail Storage
 *
 * Persists App run execution messages as JSONL for the "View process" drill-down.
 * Files are stored at: {spacePath}/.halo/apps/{appId}/runs/{runId}.jsonl
 *
 * Completely separate from the conversation storage system — no pollution
 * of the user's conversation list.
 *
 * Format: one JSON object per line (JSONL), each representing a SDK stream event.
 * On read, events are converted to the shared `TranscriptMessage` format by
 * session-transcript.ts, and the result is cached per file. The file is
 * append-only; every read rebuilds messages from it, so a message id must be
 * derived from file content (see convertEventsToMessages).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, fstatSync, statSync, copyFileSync, readSync, rmSync } from 'fs'
import { join } from 'path'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import type { ImageAttachment } from '../../../shared/types/image-attachment'
import type { ContentReference } from '../../../shared/types/content-reference'
import type {
  Thought,
  TranscriptMessage,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptProvenance,
} from '../../../shared/types/transcript'
import { pageTranscript, withThoughtsUnloaded } from '../../../shared/transcript'
import { createStampedLru } from '../../platform/file-cache'
import { convertEventsToMessages, type StoredEvent } from './session-transcript'
import { LineIndex, scanJsonlLines, withFileDescriptor } from './session-file-reader'

// ============================================
// Writer
// ============================================

export interface SessionWriter {
  /** Append a raw SDK stream event */
  writeEvent(event: Record<string, unknown>): void
  /**
   * Write the initial trigger message (before stream starts). Images are
   * stored as base64 image blocks in the trigger content (same trade-off as
   * main-chat conversation JSON) so chat bubbles survive the JSONL reload.
   *
   * `provenance` marks a message that did not come from the owner typing into
   * this conversation (an injection, another conversation, ...). Write the text
   * to show, not any framed text the model was given. `references` are the
   * places the user pointed at, kept as records; the expanded block the model
   * read is not stored.
   */
  writeTrigger(
    content: string,
    images?: ImageAttachment[],
    teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'>,
    provenance?: TranscriptProvenance,
    references?: ContentReference[]
  ): void
}

/** Get the directory for run session files */
function getRunsDir(spacePath: string, appId: string): string {
  return join(spacePath, '.halo', 'apps', appId, 'runs')
}

/** Get the JSONL file path for a specific run */
function getSessionFilePath(spacePath: string, appId: string, runId: string): string {
  // Reject path traversal — both segments are joined into a filesystem path below.
  if (appId.includes('..') || runId.includes('..')) {
    throw new Error('Invalid path parameter')
  }
  return join(getRunsDir(spacePath, appId), `${runId}.jsonl`)
}

/**
 * Create a session writer that appends events to a JSONL file.
 * Automatically creates the runs directory if missing.
 */
export function openSessionWriter(spacePath: string, appId: string, runId: string): SessionWriter {
  const dir = getRunsDir(spacePath, appId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const filePath = getSessionFilePath(spacePath, appId, runId)

  function appendLine(event: StoredEvent): void {
    try {
      appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8')
    } catch (err) {
      console.error(`[SessionStore] Failed to write event to ${filePath}:`, err)
    }
  }

  return {
    writeEvent(event: Record<string, unknown>): void {
      appendLine({ _ts: new Date().toISOString(), ...event } as StoredEvent)
    },

    writeTrigger(content, images, teamOrigin, provenance, references): void {
      const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: content }]
      for (const img of images ?? []) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
          ...(img.name ? { _name: img.name } : {}),
        })
      }
      appendLine({
        _ts: new Date().toISOString(),
        type: 'user',
        _isTrigger: true,
        ...(teamOrigin ? { _teamOrigin: teamOrigin } : {}),
        ...(provenance ? { _source: provenance.source } : {}),
        ...(provenance?.metadata ? { _metadata: provenance.metadata } : {}),
        ...(references && references.length > 0 ? { _references: references } : {}),
        message: { role: 'user', content: blocks },
      })
    },
  }
}

// ============================================
// Reader
// ============================================

/**
 * A session file parsed into messages, thoughts included, plus the parse
 * position so an append is parsed from where the last read stopped. Cached per
 * file (see `parsedSessions`) so paging and on-demand thought loads do not
 * re-parse a long transcript on every call. Treat as immutable — it is shared.
 */
interface ParsedSession {
  messages: TranscriptMessage[]
  ino: number
  /** Bytes consumed, through the last complete line. */
  endByte: number
  nextLine: number
  /** The bytes just before `endByte`; a resume requires them unchanged (the file was appended to, not rewritten). */
  probe: string
  events: StoredEvent[]
  lines: number[]
}

const PROBE_BYTES = 64

function readProbe(fd: number, endByte: number): string {
  const start = Math.max(0, endByte - PROBE_BYTES)
  const buffer = Buffer.alloc(endByte - start)
  readSync(fd, buffer, 0, buffer.length, start)
  return buffer.toString('base64')
}

/**
 * Files up to this size are parsed whole and cached; larger ones are read in
 * windows through a line index (see `readSessionTranscript`). Also the cache's
 * weight budget, so a larger file is never retained whole.
 */
export const FULL_PARSE_MAX_BYTES = 32 * 1024 * 1024
/** Bytes read per window of a large file. */
export const SESSION_WINDOW_BYTES = 8 * 1024 * 1024

// Bounded by file bytes; parsed messages cost 2-3x that on the heap.
const parsedSessions = createStampedLru<ParsedSession>({ maxEntries: 8, maxWeight: FULL_PARSE_MAX_BYTES })

/** Files already reported unreadable: every read retries, the log says it once. */
const reportedUnreadable = new Set<string>()
/** Large files already reported as read whole by a non-paged caller. */
const reportedWholeReads = new Set<string>()

function reportUnreadable(filePath: string, error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !reportedUnreadable.has(filePath)) {
    reportedUnreadable.add(filePath)
    console.warn(`[SessionStore] Cannot read session file ${filePath}; showing it as empty:`, error)
  }
}

/**
 * Parse [start, end) of `fd` into events. Physical line numbers (blank and
 * malformed lines included) are what message ids derive from, so they never
 * shift when a line is skipped. A torn final line is a write in progress;
 * anywhere else an unparsable line is damage.
 */
function parseRange(fd: number, filePath: string, start: number, end: number, startLine: number) {
  const events: StoredEvent[] = []
  const lines: number[] = []
  const corrupt: number[] = []
  const scan = scanJsonlLines(fd, start, end, startLine, (text, line) => {
    if (!text.trim()) return
    try {
      events.push(JSON.parse(text))
      lines.push(line)
    } catch {
      corrupt.push(line)
    }
  })
  let trailingEvent: { event: StoredEvent; line: number } | null = null
  if (scan.trailing && scan.trailing.text.trim()) {
    try {
      trailingEvent = { event: JSON.parse(scan.trailing.text), line: scan.trailing.line }
    } catch {
      // In progress; read again once its newline lands.
    }
  }
  if (corrupt.length > 0) {
    console.warn(`[SessionStore] Skipped ${corrupt.length} unreadable line(s) in ${filePath} (first: line ${corrupt[0]})`)
  }
  return { events, lines, trailingEvent, endByte: scan.endByte, nextLine: scan.nextLine }
}

function toMessages(events: StoredEvent[], lines: number[], trailing: { event: StoredEvent; line: number } | null) {
  return trailing
    ? convertEventsToMessages([...events, trailing.event], [...lines, trailing.line])
    : convertEventsToMessages(events, lines)
}

/** Parse a whole file, continuing from `previous` when the file only grew since. */
function parseSessionFile(filePath: string, previous?: ParsedSession): ParsedSession | null {
  try {
    return withFileDescriptor(filePath, (fd) => {
      const { size, ino } = fstatSync(fd)
      const resume = previous && previous.ino === ino && previous.endByte <= size
        && readProbe(fd, previous.endByte) === previous.probe
        ? previous
        : undefined
      const parsed = parseRange(fd, filePath, resume?.endByte ?? 0, size, resume?.nextLine ?? 1)
      const events = resume ? resume.events.concat(parsed.events) : parsed.events
      const lines = resume ? resume.lines.concat(parsed.lines) : parsed.lines
      return {
        messages: toMessages(events, lines, parsed.trailingEvent),
        ino,
        endByte: parsed.endByte,
        nextLine: parsed.nextLine,
        probe: readProbe(fd, parsed.endByte),
        events,
        lines,
      }
    })
  } catch (error) {
    reportUnreadable(filePath, error)
    return null
  }
}

function sessionFileSize(filePath: string): number | null {
  try {
    return statSync(filePath).size
  } catch (error) {
    reportUnreadable(filePath, error)
    return null
  }
}

function loadParsedSession(filePath: string): ParsedSession | null {
  return parsedSessions.get(filePath, (previous) => parseSessionFile(filePath, previous))
}

function lineIndexPath(filePath: string): string {
  return filePath.replace(/\.jsonl$/, '.lineidx.json')
}

/**
 * Messages of one window of a large file: [start, end) widened to line starts.
 *
 * A window that does not begin at the file start may open in the middle of a
 * turn, so its first message is dropped — the next older window reads it whole.
 * One turn can be larger than a window, so when dropping it would leave no
 * complete message the window doubles backwards until one fits (or reaches the
 * file start): a page is never empty while messages exist. A window placed on a
 * message's first line (`startsAtMessage`) instead grows forwards until that
 * message ends inside it.
 */
function readWindow(
  filePath: string,
  choose: (fd: number, index: LineIndex) => { start: number; end: number; startsAtMessage?: boolean },
) {
  return withFileDescriptor(filePath, (fd) => {
    const index = LineIndex.open(lineIndexPath(filePath), fd)
    const fileSize = fstatSync(fd).size
    const chosen = choose(fd, index)
    let rawStart = chosen.start
    let end = chosen.end
    let span = Math.max(1, end - rawStart)
    for (;;) {
      const { byte: start, line } = index.lineStartingAtOrAfter(fd, rawStart)
      const parsed = parseRange(fd, filePath, start, end, line)
      const trailing = end >= index.indexedBytes ? parsed.trailingEvent : null
      const messages = toMessages(parsed.events, parsed.lines, trailing)
      if (chosen.startsAtMessage) {
        if (messages.length >= 2 || end >= fileSize) return { messages, truncated: start > 0, end }
        span *= 2
        end = Math.min(fileSize, start + span)
        continue
      }
      if (start === 0) return { messages, truncated: false, end }
      if (messages.length >= 2) return { messages: messages.slice(1), truncated: true, end }
      span *= 2
      rawStart = Math.max(0, end - span)
    }
  })
}

function lineOfMessageId(messageId: string | undefined): number | null {
  const match = messageId ? /^session-msg-(\d+)$/.exec(messageId) : null
  return match ? Number(match[1]) : null
}

/**
 * Read a run's session JSONL and convert to renderer-compatible messages, each
 * with its full thought process.
 *
 * Whole-transcript readers belong to small files; a caller that only needs the
 * recent part passes `limit` (newest `limit` messages) and never pays for the
 * rest of a large file. Returns an empty array if the file doesn't exist or is
 * unreadable.
 */
export function readSessionMessages(
  spacePath: string,
  appId: string,
  runId: string,
  options: { limit?: number } = {}
): TranscriptMessage[] {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  const size = sessionFileSize(filePath)
  if (size === null) return []
  if (size > FULL_PARSE_MAX_BYTES) {
    if (options.limit !== undefined) {
      try {
        return readWindow(filePath, (_fd, index) => ({
          start: Math.max(0, index.indexedBytes - SESSION_WINDOW_BYTES),
          end: size,
        })).messages.slice(-options.limit)
      } catch (error) {
        reportUnreadable(filePath, error)
        return []
      }
    }
    if (!reportedWholeReads.has(filePath)) {
      reportedWholeReads.add(filePath)
      console.warn(`[SessionStore] Whole read of a large transcript (${Math.round(size / 1048576)} MB, not cached): ${filePath}`)
    }
  }
  const messages = loadParsedSession(filePath)?.messages ?? []
  return options.limit !== undefined ? messages.slice(-options.limit) : [...messages]
}

/**
 * One page of a session's transcript, newest first (see `pageTranscript`).
 * Messages carry `thoughts: null` plus `thoughtsSummary`; load a message's
 * thought process with `readSessionMessageThoughts`.
 *
 * A large file is read one window at a time: the newest window for the first
 * page, the window ending at `before` for older pages. `total` then counts the
 * messages read so far, not the whole file.
 */
export function readSessionTranscript(
  spacePath: string,
  appId: string,
  runId: string,
  request: TranscriptPageRequest = {}
): TranscriptPage {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  const size = sessionFileSize(filePath)
  if (size !== null && size > FULL_PARSE_MAX_BYTES) {
    try {
      const beforeLine = lineOfMessageId(request.before)
      const window = readWindow(filePath, (fd, index) => {
        const end = beforeLine !== null ? index.offsetOfLine(fd, beforeLine) ?? size : size
        return { start: Math.max(0, end - SESSION_WINDOW_BYTES), end }
      })
      const page = pageTranscript(window.messages, { limit: request.limit, through: request.through })
      return {
        ...page,
        hasMoreBefore: page.hasMoreBefore || window.truncated,
        messages: page.messages.map(withThoughtsUnloaded),
      }
    } catch (error) {
      reportUnreadable(filePath, error)
      return pageTranscript([], request)
    }
  }
  const page = pageTranscript(size === null ? [] : loadParsedSession(filePath)?.messages ?? [], request)
  return { ...page, messages: page.messages.map(withThoughtsUnloaded) }
}

/** The thought process of one message; empty when the message is unknown or has none. */
export function readSessionMessageThoughts(
  spacePath: string,
  appId: string,
  runId: string,
  messageId: string
): Thought[] {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  const size = sessionFileSize(filePath)
  if (size === null) return []
  let message: TranscriptMessage | undefined
  if (size > FULL_PARSE_MAX_BYTES) {
    const line = lineOfMessageId(messageId)
    if (line === null) return []
    try {
      // The window starts exactly at the message, so it is read whole.
      message = readWindow(filePath, (fd, index) => {
        const start = index.offsetOfLine(fd, line) ?? size
        return { start, end: Math.min(size, start + SESSION_WINDOW_BYTES), startsAtMessage: true }
      }).messages.find(m => m.id === messageId)
    } catch (error) {
      reportUnreadable(filePath, error)
      return []
    }
  } else {
    message = loadParsedSession(filePath)?.messages.find(m => m.id === messageId)
  }
  return message?.thoughts ? [...message.thoughts] : []
}

/**
 * Delete a run's transcript and its line index. Only that run's files: the
 * same folder holds the person's chat transcripts.
 */
export function deleteRunTranscript(spacePath: string, appId: string, runId: string): void {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  rmSync(filePath, { force: true })
  rmSync(lineIndexPath(filePath), { force: true })
  parsedSessions.delete(filePath)
}

/**
 * Check if a session file exists for a given run.
 */
export function sessionExists(spacePath: string, appId: string, runId: string): boolean {
  return existsSync(getSessionFilePath(spacePath, appId, runId))
}

/**
 * Resolve the on-disk transcript path for a run, or undefined when no
 * transcript exists yet.
 *
 * This is the only sanctioned way for other modules to obtain a transcript
 * location — the directory layout is this module's private rule. Callers must
 * resolve at use time, never persist the returned path.
 */
export function resolveTranscriptPath(
  spacePath: string,
  appId: string,
  runId: string
): string | undefined {
  try {
    const filePath = getSessionFilePath(spacePath, appId, runId)
    return existsSync(filePath) ? filePath : undefined
  } catch {
    // Invalid path parameters — treat as no transcript
    return undefined
  }
}

/**
 * Copy a run's JSONL transcript to a new runId.
 *
 * Used when forking a session into a new native client session so the forked
 * window shows the full prior history immediately. Copies the raw JSONL bytes
 * verbatim (no re-serialization) — the display messages are reconstructed on
 * read via convertEventsToMessages. No-op (returns false) when the source file
 * is absent or the copy fails; the caller treats an empty transcript as a
 * fresh window, which is an acceptable degradation.
 *
 * @returns true if the transcript was copied, false otherwise
 */
export function copySessionJsonl(
  spacePath: string,
  appId: string,
  fromRunId: string,
  toRunId: string
): boolean {
  const fromPath = getSessionFilePath(spacePath, appId, fromRunId)
  if (!existsSync(fromPath)) return false
  const toPath = getSessionFilePath(spacePath, appId, toRunId)
  try {
    const dir = getRunsDir(spacePath, appId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    copyFileSync(fromPath, toPath)
    return true
  } catch (err) {
    console.error(`[SessionStore] Failed to copy transcript ${fromRunId} → ${toRunId}:`, err)
    return false
  }
}

// ============================================
// Chat Session ID Persistence
// ============================================

/**
 * Persists Claude SDK session IDs for app-chat conversations.
 *
 * When a V2 session is rebuilt (idle timeout, process crash, config change),
 * the saved sessionId allows the SDK to restore conversation history from
 * its on-disk session file — same mechanism as the main conversation
 * (conversation.service.saveSessionId).
 *
 * Storage: {spacePath}/.halo/apps/{appId}/runs/_session-ids.json
 * Format: { [runId]: sessionId }
 */

/** Path to the session-id map file for an app */
function getSessionIdMapPath(spacePath: string, appId: string): string {
  return join(getRunsDir(spacePath, appId), '_session-ids.json')
}

/** Read the full session-id map. Returns empty object on missing/corrupt file. */
function readSessionIdMap(spacePath: string, appId: string): Record<string, string> {
  const filePath = getSessionIdMapPath(spacePath, appId)
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // File missing or corrupt — start fresh
  }
  return {}
}

/** Write the full session-id map to disk. */
function writeSessionIdMap(spacePath: string, appId: string, map: Record<string, string>): void {
  const dir = getRunsDir(spacePath, appId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const filePath = getSessionIdMapPath(spacePath, appId)
  try {
    writeFileSync(filePath, JSON.stringify(map), 'utf8')
  } catch (err) {
    console.error(`[SessionStore] Failed to write session-id map:`, err)
  }
}

/**
 * Save a Claude SDK sessionId for a chat session.
 * Called after stream completion to enable session resume on V2 rebuild.
 */
export function saveChatSessionId(spacePath: string, appId: string, runId: string, sessionId: string): void {
  const map = readSessionIdMap(spacePath, appId)
  map[runId] = sessionId
  writeSessionIdMap(spacePath, appId, map)
}

/**
 * Load a previously saved Claude SDK sessionId.
 * Returns undefined if no sessionId is saved for this chat session.
 */
export function loadChatSessionId(spacePath: string, appId: string, runId: string): string | undefined {
  const map = readSessionIdMap(spacePath, appId)
  return map[runId]
}

/**
 * Delete a saved sessionId for a chat session.
 * Called when clearing chat history to ensure a truly fresh start.
 */
export function deleteChatSessionId(spacePath: string, appId: string, runId: string): void {
  const map = readSessionIdMap(spacePath, appId)
  if (!(runId in map)) return
  delete map[runId]
  writeSessionIdMap(spacePath, appId, map)
}
