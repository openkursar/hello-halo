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

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, fstatSync, statSync, copyFileSync, readSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import type { LiveInputOutcome } from '../../../shared/types/agent-input'
import { isEngineSessionBinding, isEngineSessionRouting, sameEngineSessionState, type EngineSessionBinding, type EngineSessionRouting, type EngineSessionState, type EngineHandoffHistory } from '../../../shared/types/engine-session'
import { isEngineId, type EngineId } from '../../../shared/types/engine'
import type { ImageAttachment } from '../../../shared/types/image-attachment'
import type { ContentReference } from '../../../shared/types/content-reference'
import type {
  ChatPushVia,
  Thought,
  TranscriptMessage,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptProvenance,
} from '../../../shared/types/transcript'
import { pageTranscript, withThoughtsUnloaded } from '../../../shared/transcript'
import { createStampedLru } from '../../platform/file-cache'
import { convertEventsToTranscript, type ConvertedTranscript, type StoredEvent } from './session-transcript'
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
   * read is not stored. Returns the original timestamp and the record's input id
   * after a successful append.
   */
  writeTrigger(
    content: string,
    images?: ImageAttachment[],
    teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'>,
    provenance?: TranscriptProvenance,
    references?: ContentReference[]
  ): WrittenTrigger | void
  /** Mark an earlier trigger record by its input id; the file is append-only, so this is a line of its own. */
  writeInputOutcome(inputId: string, outcome: LiveInputOutcome): void
  /**
   * Record a proactively sent message at arrival, including during active work.
   * Its timestamp and source are independent of the surrounding native turn.
   */
  writePush(push: RecordedPush): void
}

export interface WrittenTrigger {
  timestamp: string
  inputId: string
}

/** A message sent to a chat outside its turns, as the chat's record keeps it. */
export interface RecordedPush {
  text: string
  via: ChatPushVia
  /** When it was sent (ISO); now when omitted */
  at?: string
  /** The digital human that sent it, when it is not the chat's own (one linked to the chat) */
  by?: { appId: string; name: string }
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

  function appendLine(event: StoredEvent): boolean {
    try {
      appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8')
      return true
    } catch (err) {
      console.error(`[SessionStore] Failed to write event to ${filePath}:`, err)
      return false
    }
  }

  return {
    writeEvent(event: Record<string, unknown>): void {
      appendLine({ _ts: new Date().toISOString(), ...event } as StoredEvent)
    },

    writeTrigger(content, images, teamOrigin, provenance, references) {
      const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: content }]
      for (const img of images ?? []) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
          ...(img.name ? { _name: img.name } : {}),
        })
      }
      const timestamp = new Date().toISOString()
      const inputId = randomUUID()
      const written = appendLine({
        _ts: timestamp,
        type: 'user',
        _isTrigger: true,
        _inputId: inputId,
        ...(teamOrigin ? { _teamOrigin: teamOrigin } : {}),
        ...(provenance ? { _source: provenance.source } : {}),
        ...(provenance?.metadata ? { _metadata: provenance.metadata } : {}),
        ...(references && references.length > 0 ? { _references: references } : {}),
        message: { role: 'user', content: blocks },
      })
      return written ? { timestamp, inputId } : undefined
    },

    writeInputOutcome(inputId, outcome): void {
      appendLine({ _ts: new Date().toISOString(), type: 'input_outcome', _inputId: inputId, outcome })
    },

    writePush({ text, via, at, by }): void {
      appendLine({
        _ts: at ?? new Date().toISOString(),
        type: 'push',
        _pushVia: via,
        ...(by ? { _pushedBy: by } : {}),
        message: { role: 'assistant', content: [{ type: 'text', text }] },
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
  openTurnFrom?: string
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

function toTranscript(events: StoredEvent[], lines: number[], trailing: { event: StoredEvent; line: number } | null): ConvertedTranscript {
  return trailing
    ? convertEventsToTranscript([...events, trailing.event], [...lines, trailing.line])
    : convertEventsToTranscript(events, lines)
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
        ...toTranscript(events, lines, parsed.trailingEvent),
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
      const { messages, openTurnFrom } = toTranscript(parsed.events, parsed.lines, trailing)
      if (chosen.startsAtMessage) {
        if (messages.length >= 2 || end >= fileSize) return { messages, truncated: start > 0, end }
        span *= 2
        end = Math.min(fileSize, start + span)
        continue
      }
      // A window that opened mid-turn cannot tell where that turn began.
      const open = end >= fileSize ? openTurnFrom : undefined
      if (start === 0) return { messages, truncated: false, end, openTurnFrom: open }
      if (messages.length >= 2) {
        const kept = messages.slice(1)
        return { messages: kept, truncated: true, end, openTurnFrom: open && kept.some(m => m.id === open) ? open : undefined }
      }
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
      const page = pageTranscript(window.messages, { limit: request.limit, through: request.through }, window.openTurnFrom)
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
  const parsed = size === null ? null : loadParsedSession(filePath)
  const page = pageTranscript(parsed?.messages ?? [], request, parsed?.openTurnFrom)
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
  deleteChatSessionId(spacePath, appId, runId)
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

/** Legacy strings, first-start routing, and acknowledged native bindings share one atomic record. */
type SessionIdMap = Record<string, string | EngineSessionBinding | EngineSessionRouting>

function getSessionIdMapPath(spacePath: string, appId: string): string {
  if (appId.includes('..')) throw new Error('Invalid path parameter')
  return join(getRunsDir(spacePath, appId), '_session-ids.json')
}

function readSessionIdMap(spacePath: string, appId: string, strict = false): SessionIdMap {
  const filePath = getSessionIdMapPath(spacePath, appId)
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Possibly transient (locked, unreadable for now): fail this turn, keep the file.
    console.warn(`[SessionStore] Cannot read session bindings: app=${appId}, code=${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
    if (strict) throw new Error('Stored engine binding is unavailable')
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SessionIdMap
  quarantineSessionIdMap(filePath, appId, raw.length)
  return {}
}

/**
 * A map that is not a JSON object can only be a torn write from an older
 * release (this one replaces it atomically). Every chat of the digital human
 * would otherwise fail on it, so it is set aside — never deleted — and each
 * chat continues from its own transcript.
 */
function quarantineSessionIdMap(filePath: string, appId: string, bytes: number): void {
  const aside = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    renameSync(filePath, aside)
    console.warn(`[SessionStore] Session bindings unreadable; set aside and continuing from transcripts: app=${appId}, bytes=${bytes}, file=${aside}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    console.error(`[SessionStore] Unreadable session bindings could not be set aside: app=${appId}, code=${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
    throw new Error('Stored engine binding is unavailable')
  }
}

function writeSessionIdMap(spacePath: string, appId: string, map: SessionIdMap): void {
  mkdirSync(getRunsDir(spacePath, appId), { recursive: true })
  const filePath = getSessionIdMapPath(spacePath, appId)
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(map), 'utf8')
    renameSync(temporaryPath, filePath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function engineStateOf(value: string | EngineSessionBinding | EngineSessionRouting | undefined): EngineSessionState {
  if (value === undefined) return {}
  if (typeof value === 'string') return { sessionId: value }
  if (isEngineSessionBinding(value)) return { sessionId: value.sessionId, binding: { ...value } }
  if (isEngineSessionRouting(value)) return { routingEngine: value.engineId }
  throw new Error('Stored engine binding is invalid')
}

export function loadChatEngineState(spacePath: string, appId: string, runId: string): EngineSessionState {
  const map = readSessionIdMap(spacePath, appId, true)
  try {
    return engineStateOf(map[runId])
  } catch (error) {
    console.warn(`[SessionStore] Cannot load engine binding: app=${appId}, run=${runId}`, error)
    throw error
  }
}

export function loadChatEngineBinding(spacePath: string, appId: string, runId: string): EngineSessionBinding | undefined {
  return loadChatEngineState(spacePath, appId, runId).binding
}

/** Only a fresh slot is pinned; an acknowledged owner or an earlier first-start choice stays intact. */
export function saveChatEngineRouting(
  spacePath: string, appId: string, runId: string, engineId: EngineId, expected?: EngineSessionState,
): EngineSessionState {
  if (!isEngineId(engineId)) throw new Error('Invalid engine routing choice')
  const map = readSessionIdMap(spacePath, appId, true)
  const current = engineStateOf(map[runId])
  if (expected && !sameEngineSessionState(current, expected)) {
    if (current.routingEngine === engineId && !current.sessionId && !current.binding) return current
    console.warn(`[SessionStore] Rejected stale first-start routing: app=${appId}, run=${runId}`)
    throw new Error('The conversation engine changed while it was being prepared. Please try again.')
  }
  if (current.sessionId || current.binding || current.routingEngine) return current
  map[runId] = { version: 1, engineId }
  try {
    writeSessionIdMap(spacePath, appId, map)
    return { routingEngine: engineId }
  } catch (error) {
    console.error(`[SessionStore] Could not save first-start engine routing: app=${appId}, run=${runId}`, error)
    throw new Error('Could not save the conversation engine choice')
  }
}

/** Commit only after preparation succeeds, using the state captured before preparation. */
export function saveChatEngineBinding(
  spacePath: string, appId: string, runId: string,
  binding: EngineSessionBinding, expected?: EngineSessionState,
): boolean {
  if (!isEngineSessionBinding(binding)) throw new Error('Invalid engine session binding')
  const map = readSessionIdMap(spacePath, appId, true)
  if (expected && !sameEngineSessionState(engineStateOf(map[runId]), expected)) {
    console.warn(`[SessionStore] Rejected stale engine binding: app=${appId}, run=${runId}`)
    return false
  }
  if (sameEngineSessionState(engineStateOf(map[runId]), { sessionId: binding.sessionId, binding })) return true
  map[runId] = { ...binding }
  try {
    writeSessionIdMap(spacePath, appId, map)
    return true
  } catch (error) {
    console.error(`[SessionStore] Could not save engine binding: app=${appId}, run=${runId}`, error)
    throw new Error('Could not save the engine session binding')
  }
}

export function saveChatSessionId(spacePath: string, appId: string, runId: string, sessionId: string): void {
  try {
    const map = readSessionIdMap(spacePath, appId, true)
    const current = engineStateOf(map[runId])
    if (current.binding || current.routingEngine) {
      if (current.sessionId !== sessionId) console.warn(`[SessionStore] Ignored unbound session update: app=${appId}, run=${runId}`)
      return
    }
    map[runId] = sessionId
    writeSessionIdMap(spacePath, appId, map)
  } catch (error) {
    console.error(`[SessionStore] Could not save session ID: app=${appId}, run=${runId}`, error)
  }
}

export function loadChatSessionId(spacePath: string, appId: string, runId: string): string | undefined {
  return engineStateOf(readSessionIdMap(spacePath, appId)[runId]).sessionId
}

export function deleteChatSessionId(spacePath: string, appId: string, runId: string): void {
  try {
    const map = readSessionIdMap(spacePath, appId, true)
    if (!(runId in map)) return
    delete map[runId]
    writeSessionIdMap(spacePath, appId, map)
  } catch (error) {
    console.error(`[SessionStore] Could not delete session binding: app=${appId}, run=${runId}`, error)
  }
}

/** A bounded tail read used only for engine changes; it never builds a whole-file line index. */
export function readChatHandoffHistory(
  spacePath: string, appId: string, runId: string,
  options: { limit?: number; maxBytes?: number; excludeInputIds?: readonly string[] } = {},
): EngineHandoffHistory {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  const maxBytes = Math.max(2048, Math.min(options.maxBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024))
  const limit = Math.max(1, Math.min(options.limit ?? 128, 256))
  try {
    return withFileDescriptor(filePath, fd => {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - maxBytes)
      const buffer = Buffer.alloc(size - start)
      const read = readSync(fd, buffer, 0, buffer.length, start)
      const data = buffer.subarray(0, read)
      let truncated = start > 0 || read < size - start
      let cursor = start > 0 ? data.indexOf(10) + 1 : 0
      if (start > 0 && cursor === 0) cursor = data.length
      let lineCount = 0
      for (let offset = data.length - 1; offset >= cursor; offset--) {
        if (data[offset] !== 10) continue
        lineCount++
        if (lineCount > 4096) {
          cursor = offset + 1
          truncated = true
          break
        }
      }
      const events: StoredEvent[] = []
      const positions: number[] = []
      let malformed = 0
      while (cursor < data.length) {
        const newline = data.indexOf(10, cursor)
        const end = newline < 0 ? data.length : newline
        const text = data.toString('utf8', cursor, end).trim()
        if (text) {
          try {
            const event: unknown = JSON.parse(text)
            if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event')
            events.push(event as StoredEvent)
            positions.push(start + cursor)
          } catch {
            malformed++
            truncated = true
          }
        }
        cursor = end + 1
      }
      const excludedIds = new Set(options.excludeInputIds ?? [])
      const excludedRecords = new Set(events.flatMap((event, index) =>
        event.type === 'user' && event._isTrigger && typeof event._inputId === 'string' && excludedIds.has(event._inputId)
          ? [`session-msg-${positions[index]}`] : []))
      // Keep decoder boundaries and tool-result grouping intact; omit only the matching visible input records.
      const converted = convertEventsToTranscript(events, positions).messages.filter(message => !excludedRecords.has(message.id))
      truncated ||= converted.length > limit
      const messages = converted.slice(-limit).map(message => ({
        ...message,
        // Byte positions are audit references, not the UI reader's physical-line cursors.
        id: message.id.replace('session-msg-', 'session-byte-'),
        thoughts: message.thoughts?.filter(thought => thought.type === 'tool_use' || thought.type === 'tool_result'),
      }))
      if (malformed) console.warn(`[SessionStore] Handoff history contains unreadable records: app=${appId}, run=${runId}, count=${malformed}`)
      return { messages, truncated, transcriptPath: filePath, latestMessageId: messages.at(-1)?.id }
    })
  } catch (error) {
    console.warn(`[SessionStore] Cannot read engine handoff history: app=${appId}, run=${runId}`, error)
    throw new Error('Conversation history is unavailable for the engine change')
  }
}
