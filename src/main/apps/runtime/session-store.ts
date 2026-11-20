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

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, fstatSync, statSync, copyFileSync, linkSync, readdirSync, readSync, rmSync, renameSync } from 'fs'
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
import type { TranscriptUpdate, TranscriptUpdateMessage } from '../../../shared/transcript-update'
import { createStampedLru } from '../../platform/file-cache'
import { convertEventsToTranscript, type ConvertedTranscript, type ConvertOptions, type StoredEvent, type TranscriptChanges, type TranscriptCheckpoint, type TranscriptSeed } from './session-transcript'
import { LineIndex, scanJsonlLines, withFileDescriptor } from './session-file-reader'
import { withToolResultImageFiles } from '../../services/agent/tool-result-images'

// ============================================
// Writer
// ============================================

export interface SessionWriter {
  /**
   * Append a raw SDK stream event. Images in its tool results are stored as
   * files beside the transcript (`transcriptImagesDir`) and referenced from the
   * line; the event itself is not changed.
   */
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
 * The folder beside a transcript that holds the images its tool results
 * returned. It belongs to the transcript: deleted, cleared and copied with it.
 */
function imagesDirOf(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '.images')
}

/**
 * Where a transcript's tool-result images are saved. The chat entry hands the
 * same folder to the live stream, so the step on screen and the stored line
 * refer to one file.
 */
export function transcriptImagesDir(spacePath: string, appId: string, runId: string): string {
  return imagesDirOf(getSessionFilePath(spacePath, appId, runId))
}

/** Remove a transcript's saved images, when its record is emptied. Throws when they could not all be removed. */
export function deleteTranscriptImages(spacePath: string, appId: string, runId: string): void {
  rmSync(transcriptImagesDir(spacePath, appId, runId), { recursive: true, force: true })
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
  const imagesDir = imagesDirOf(filePath)

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
      appendLine({ _ts: new Date().toISOString(), ...withToolResultImageFiles(event, imagesDir) } as StoredEvent)
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
  /** When each message and thought last changed (see `readSessionUpdate`). */
  changes?: TranscriptChanges
  /**
   * Identity of the history this parse continues. A parse that starts over
   * (the file was rewritten, or the cache dropped it) gets a new one, so a
   * reader's cursor from before never applies to it.
   */
  lineage: string
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

function toTranscript(events: StoredEvent[], lines: number[], trailing: { event: StoredEvent; line: number } | null, options?: ConvertOptions): ConvertedTranscript {
  return trailing
    ? convertEventsToTranscript([...events, trailing.event], [...lines, trailing.line], options)
    : convertEventsToTranscript(events, lines, options)
}

/**
 * Parse a whole file, continuing from `previous` when the file only grew since.
 * `track` keeps change lines (see `readSessionUpdate`); only readers that ask
 * what changed pay for them.
 */
function parseSessionFile(filePath: string, previous: ParsedSession | undefined, track: boolean): ParsedSession | null {
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
      const { messages, openTurnFrom, changes } = toTranscript(events, lines, parsed.trailingEvent, { track, imagesDir: imagesDirOf(filePath) })
      return {
        messages,
        ...(openTurnFrom ? { openTurnFrom } : {}),
        ...(changes ? { changes } : {}),
        lineage: resume?.lineage ?? randomUUID().slice(0, 8),
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

/** The cached parse; with `track`, one that keeps change lines, which it then keeps while cached. */
function loadParsedSession(filePath: string, track = false): ParsedSession | null {
  const parsed = parsedSessions.get(filePath, (previous) => parseSessionFile(filePath, previous, track || Boolean(previous?.changes)))
  if (!parsed || !track || parsed.changes) return parsed
  // Converted again from the events already held; the bytes are not read again.
  parsedSessions.delete(filePath)
  return parsedSessions.get(filePath, () => parseSessionFile(filePath, parsed, true))
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
      const { messages, openTurnFrom } = toTranscript(parsed.events, parsed.lines, trailing, { imagesDir: imagesDirOf(filePath) })
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
 * Where a large file's tail can be converted on its own: a native-turn
 * boundary (`TranscriptCheckpoint`) placed in the file. Valid while the bytes
 * before it are unchanged (`probe`), i.e. the file was only appended to.
 */
interface TailCheckpoint {
  byte: number
  line: number
  probe: string
  messageCount: number
  lastMessageId?: string
  seed: TranscriptSeed
}

/**
 * The newest boundaries of large files, per file; a reader asks for a tail
 * starting at or after one of them. `lineage` names the history they belong
 * to: a rewritten file starts a new one, so a reader's cursor from before
 * never applies to it.
 */
interface KnownTail {
  ino: number
  /** File size at the last read; a smaller file was rewritten. */
  size: number
  lineage: string
  checkpoints: TailCheckpoint[]
}

const tailCheckpoints = new Map<string, KnownTail>()
const TAIL_FILES = 16
const CHECKPOINTS_PER_FILE = 8

/** The file's remembered boundaries, while it has only been appended to since; otherwise they are forgotten. */
function knownTail(filePath: string, fd: number, ino: number, size: number): KnownTail | undefined {
  const known = tailCheckpoints.get(filePath)
  if (!known) return undefined
  if (known.ino !== ino || size < known.size || known.checkpoints.some(cp => cp.byte > size || readProbe(fd, cp.byte) !== cp.probe)) {
    tailCheckpoints.delete(filePath)
    return undefined
  }
  return known
}

function rememberCheckpoints(
  filePath: string,
  fd: number,
  known: KnownTail | undefined,
  ino: number,
  base: { messageCount: number; lastMessageId?: string },
  converted: TranscriptCheckpoint[],
  lines: readonly number[],
  completeEvents: number,
): KnownTail {
  const usable = converted.filter(cp => cp.eventIndex <= completeEvents).slice(-CHECKPOINTS_PER_FILE)
  const placed: TailCheckpoint[] = []
  if (usable.length > 0) {
    const index = LineIndex.open(lineIndexPath(filePath), fd)
    for (const cp of usable) {
      const line = lines[cp.eventIndex - 1] + 1
      const byte = index.offsetOfLine(fd, line)
      if (byte === null) continue
      const lastMessageId = cp.messageCount > 0 ? cp.lastMessageId : base.lastMessageId
      placed.push({
        byte, line, probe: readProbe(fd, byte), messageCount: base.messageCount + cp.messageCount,
        ...(lastMessageId ? { lastMessageId } : {}), seed: cp.seed,
      })
    }
  }
  const kept = known ? known.checkpoints.filter(cp => !placed.length || cp.byte < placed[0].byte) : []
  const entry: KnownTail = { ino, size: fstatSync(fd).size, lineage: known?.lineage ?? randomUUID().slice(0, 8), checkpoints: [...kept, ...placed].slice(-CHECKPOINTS_PER_FILE) }
  tailCheckpoints.delete(filePath)
  tailCheckpoints.set(filePath, entry)
  while (tailCheckpoints.size > TAIL_FILES) tailCheckpoints.delete(tailCheckpoints.keys().next().value as string)
  return entry
}

/**
 * Convert a large file from `start` (a remembered boundary) or from its
 * beginning, remembering the newest boundaries it passes. The cursor names
 * the history and the first line not yet complete.
 */
function convertLargeFrom(
  filePath: string,
  fd: number,
  ino: number,
  size: number,
  known: KnownTail | undefined,
  start: TailCheckpoint | undefined,
  track: boolean,
) {
  const parsed = parseRange(fd, filePath, start?.byte ?? 0, size, start?.line ?? 1)
  const events = parsed.trailingEvent ? [...parsed.events, parsed.trailingEvent.event] : parsed.events
  const lines = parsed.trailingEvent ? [...parsed.lines, parsed.trailingEvent.line] : parsed.lines
  const converted = convertEventsToTranscript(events, lines, {
    track, checkpoints: { latest: CHECKPOINTS_PER_FILE + 1 }, imagesDir: imagesDirOf(filePath), ...(start ? { seed: start.seed } : {}),
  })
  const entry = rememberCheckpoints(filePath, fd, known, ino, { messageCount: start?.messageCount ?? 0, lastMessageId: start?.lastMessageId }, converted.checkpoints ?? [], lines, parsed.events.length)
  return { converted, base: start?.messageCount ?? 0, cursor: `${entry.lineage}:${parsed.nextLine}` }
}

/**
 * The transcript from its `from`-th message (0-based) on — exactly
 * `readSessionMessages(…).slice(from)`. A large file is not read whole when
 * the last read left a turn boundary at or before that message: only the
 * bytes from that boundary on are parsed and converted.
 */
export function readSessionMessagesFrom(spacePath: string, appId: string, runId: string, from: number): TranscriptMessage[] {
  if (!(from > 0)) return readSessionMessages(spacePath, appId, runId)
  const filePath = getSessionFilePath(spacePath, appId, runId)
  const size = sessionFileSize(filePath)
  if (size === null) return []
  if (size <= FULL_PARSE_MAX_BYTES) {
    // Under the limit now, so it was rewritten since it was large: its boundaries no longer apply.
    tailCheckpoints.delete(filePath)
    return (loadParsedSession(filePath)?.messages ?? []).slice(from)
  }
  try {
    return withFileDescriptor(filePath, (fd) => {
      const { ino } = fstatSync(fd)
      const known = knownTail(filePath, fd, ino, size)
      const start = known?.checkpoints.filter(cp => cp.messageCount <= from).at(-1)
      const { converted, base } = convertLargeFrom(filePath, fd, ino, size, known, start, false)
      return converted.messages.slice(from - base)
    })
  } catch (error) {
    reportUnreadable(filePath, error)
    return []
  }
}

/**
 * The whole transcript as `readSessionMessages` returns it, or — given the
 * `cursor` of an earlier read of this file — only what changed since then
 * (`shared/transcript-update.ts`). A watcher of a live run receives the steps
 * the run added, not the run again. An unknown cursor answers with the whole
 * transcript. A large file (read uncached) is converted from the remembered
 * turn start at or before the cursor; it answers whole when there is none, or
 * when a stop marked a message from before that start.
 */
export function readSessionUpdate(
  spacePath: string,
  appId: string,
  runId: string,
  since?: string
): TranscriptUpdate {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  const size = sessionFileSize(filePath)
  if (size === null) return { cursor: '', messages: [] }
  if (size > FULL_PARSE_MAX_BYTES) return readLargeSessionUpdate(filePath, size, since)
  tailCheckpoints.delete(filePath)
  const parsed = loadParsedSession(filePath, true)
  if (!parsed) return { cursor: '', messages: [] }
  const cursor = `${parsed.lineage}:${parsed.nextLine}`
  const sinceLine = cursorLine(since, parsed.lineage)
  if (sinceLine === null || !parsed.changes) return { cursor, messages: [...parsed.messages] }
  return { cursor, ...changedSince(parsed.messages, parsed.changes, sinceLine) }
}

function readLargeSessionUpdate(filePath: string, size: number, since: string | undefined): TranscriptUpdate {
  try {
    return withFileDescriptor(filePath, (fd) => {
      const { ino } = fstatSync(fd)
      const known = knownTail(filePath, fd, ino, size)
      const sinceLine = known ? cursorLine(since, known.lineage) : null
      const start = sinceLine !== null ? known!.checkpoints.filter(cp => cp.line <= sinceLine).at(-1) : undefined
      if (start && sinceLine !== null) {
        const tail = convertLargeFrom(filePath, fd, ino, size, known, start, true)
        const { changes, marksBeforeStart, messages } = tail.converted
        if (changes && !marksBeforeStart?.some(line => line >= sinceLine)) {
          const update = changedSince(messages, changes, sinceLine)
          const keep = tail.base + (update.keep ?? 0)
          const keepThrough = update.keepThrough ?? start.lastMessageId
          return { cursor: tail.cursor, keep, ...(keep > 0 && keepThrough ? { keepThrough } : {}), messages: update.messages }
        }
      }
      const whole = convertLargeFrom(filePath, fd, ino, size, knownTail(filePath, fd, ino, size), undefined, false)
      return { cursor: whole.cursor, messages: whole.converted.messages }
    })
  } catch (error) {
    reportUnreadable(filePath, error)
    return { cursor: '', messages: [] }
  }
}

function cursorLine(cursor: string | undefined, lineage: string): number | null {
  const match = cursor ? /^([^:]+):(\d+)$/.exec(cursor) : null
  return match && match[1] === lineage ? Number(match[2]) : null
}

/** Everything changed by the events from `line` on: the messages from the first one changed, with only their changed thoughts. */
function changedSince(messages: TranscriptMessage[], changes: TranscriptChanges, line: number): Omit<TranscriptUpdate, 'cursor'> {
  let keep = messages.findIndex(message => changes.lineOf(message) >= line)
  if (keep < 0) keep = messages.length
  const tail = messages.slice(keep).map((message): TranscriptUpdateMessage => {
    const thoughts = message.thoughts
    if (!thoughts?.length) return message
    const at: number[] = []
    const sent: Thought[] = []
    thoughts.forEach((thought, index) => {
      if (changes.lineOf(thought) < line) return
      at.push(index)
      sent.push(thought)
    })
    if (sent.length === thoughts.length) return message
    return { ...message, thoughts: sent, thoughtPatch: { total: thoughts.length, at } }
  })
  return { keep, ...(keep > 0 ? { keepThrough: messages[keep - 1].id } : {}), messages: tail }
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
 * Delete a run's transcript, its line index and its saved images. Only that
 * run's files: the same folder holds the person's chat transcripts.
 */
export function deleteRunTranscript(spacePath: string, appId: string, runId: string): void {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  rmSync(filePath, { force: true })
  rmSync(lineIndexPath(filePath), { force: true })
  rmSync(imagesDirOf(filePath), { recursive: true, force: true })
  parsedSessions.delete(filePath)
  tailCheckpoints.delete(filePath)
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
 * read via convertEventsToMessages. Its saved images are copied too; the copy
 * reads them from its own folder. No-op (returns false) when the source file
 * is absent or the copy fails; the caller treats an empty transcript as a
 * fresh window, which is an acceptable degradation. Images that cannot be
 * copied leave the copy showing those steps as a line naming the image.
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
  } catch (err) {
    console.error(`[SessionStore] Failed to copy transcript ${fromRunId} → ${toRunId}:`, err)
    return false
  }
  const fromImages = imagesDirOf(fromPath)
  if (existsSync(fromImages)) {
    try {
      shareSavedImages(fromImages, imagesDirOf(toPath))
    } catch (err) {
      console.warn(`[SessionStore] Saved images of ${fromRunId} were not copied to ${toRunId}:`, err)
    }
  }
  return true
}

const SAVED_IMAGE_FILE_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/

/**
 * Give a copied transcript its own names for the saved images. A saved image
 * never changes once written, so a hard link serves (no bytes copied, however
 * many images); a filesystem without links gets a copy.
 */
function shareSavedImages(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (!SAVED_IMAGE_FILE_NAME.test(name)) continue
    const target = join(to, name)
    if (existsSync(target)) continue
    try {
      linkSync(join(from, name), target)
    } catch {
      copyFileSync(join(from, name), target)
    }
  }
}

// ============================================
// Chat Session ID Persistence
// ============================================

export interface ChatEngineBinding extends EngineSessionBinding {
  /** An explicit reload bypasses CC's saved prompt and tool-definition snapshot. */
  useCurrentInstructions?: true
}

export interface ChatEngineState extends EngineSessionState {
  binding?: ChatEngineBinding
  useCurrentInstructions?: true
}

interface ReloadedLegacySession {
  version: 1
  legacySessionId: string
  useCurrentInstructions: true
}

/** Legacy strings, first-start routing, and acknowledged native bindings share one atomic record. */
type SessionIdMap = Record<string, string | ChatEngineBinding | EngineSessionRouting | ReloadedLegacySession>

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

function engineStateOf(value: SessionIdMap[string] | undefined): ChatEngineState {
  if (value === undefined) return {}
  if (typeof value === 'string') return { sessionId: value }
  if (isEngineSessionBinding(value)) {
    const binding = value as ChatEngineBinding
    if (binding.useCurrentInstructions !== undefined && (binding.useCurrentInstructions !== true || binding.engineId !== 'anthropic')) {
      throw new Error('Stored instruction reload state is invalid')
    }
    return { sessionId: binding.sessionId, binding: { ...binding },
      ...(binding.useCurrentInstructions ? { useCurrentInstructions: true } : {}) }
  }
  if (value && typeof value === 'object' && value.version === 1 && 'legacySessionId' in value &&
      typeof value.legacySessionId === 'string' && value.legacySessionId.length > 0 && value.legacySessionId.length <= 512 &&
      value.useCurrentInstructions === true && !('engineId' in value) && !('sessionId' in value)) {
    return { sessionId: value.legacySessionId, useCurrentInstructions: true }
  }
  if (value && typeof value === 'object' && ('useCurrentInstructions' in value || 'legacySessionId' in value)) {
    throw new Error('Stored instruction reload state is invalid')
  }
  if (isEngineSessionRouting(value)) return { routingEngine: value.engineId }
  throw new Error('Stored engine binding is invalid')
}

function sameChatEngineState(left: ChatEngineState, right: ChatEngineState): boolean {
  return sameEngineSessionState(left, right) && left.useCurrentInstructions === right.useCurrentInstructions
}

export function loadChatEngineState(spacePath: string, appId: string, runId: string): ChatEngineState {
  const map = readSessionIdMap(spacePath, appId, true)
  try {
    return engineStateOf(map[runId])
  } catch (error) {
    console.warn(`[SessionStore] Cannot load engine binding: app=${appId}, run=${runId}`, error)
    throw error
  }
}

export function loadChatEngineBinding(spacePath: string, appId: string, runId: string): ChatEngineBinding | undefined {
  return loadChatEngineState(spacePath, appId, runId).binding
}

/** Copy native ownership or explicit legacy reload intent into a fresh fork without inferring an engine. */
export function copyChatEngineState(spacePath: string, appId: string, fromRunId: string, toRunId: string): void {
  try {
    if (fromRunId === toRunId) throw new Error('Source and destination conversations must differ')
    const map = readSessionIdMap(spacePath, appId, true)
    const source = engineStateOf(map[fromRunId])
    if (!source.sessionId || !source.binding && !source.useCurrentInstructions) return
    if (map[toRunId] !== undefined) throw new Error('The destination conversation already has engine state')
    map[toRunId] = source.binding
      ? { ...source.binding }
      : { version: 1, legacySessionId: source.sessionId, useCurrentInstructions: true }
    writeSessionIdMap(spacePath, appId, map)
  } catch (error) {
    console.error(`[SessionStore] Could not copy fork engine state: app=${appId}, from=${fromRunId}, to=${toRunId}, code=${(error as NodeJS.ErrnoException).code ?? 'unknown'}`, error)
    throw new Error('Could not preserve the conversation instructions while continuing in the client', { cause: error })
  }
}

/** Only a fresh slot is pinned; an acknowledged owner or an earlier first-start choice stays intact. */
export function saveChatEngineRouting(
  spacePath: string, appId: string, runId: string, engineId: EngineId, expected?: ChatEngineState,
): ChatEngineState {
  if (!isEngineId(engineId)) throw new Error('Invalid engine routing choice')
  const map = readSessionIdMap(spacePath, appId, true)
  const current = engineStateOf(map[runId])
  if (expected && !sameChatEngineState(current, expected)) {
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

/** Persist an explicit reload without touching transcripts, routing or other engines. */
export function reloadChatInstructions(spacePath: string, appId: string): number {
  try {
    const map = readSessionIdMap(spacePath, appId, true)
    let changed = 0
    for (const [runId, value] of Object.entries(map)) {
      if (runId !== 'chat' && !runId.startsWith('chat-')) continue
      const current = engineStateOf(value)
      if (!current.sessionId || current.useCurrentInstructions || current.binding?.engineId && current.binding.engineId !== 'anthropic') continue
      map[runId] = current.binding
        ? { ...current.binding, useCurrentInstructions: true }
        : { version: 1, legacySessionId: current.sessionId, useCurrentInstructions: true }
      changed++
    }
    if (changed) writeSessionIdMap(spacePath, appId, map)
    return changed
  } catch (error) {
    console.error(`[SessionStore] Could not persist instruction reload: app=${appId}, code=${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
    throw new Error('Could not reload the saved conversation instructions')
  }
}

/** Commit only after preparation succeeds, using the state captured before preparation. */
export function saveChatEngineBinding(
  spacePath: string, appId: string, runId: string,
  binding: ChatEngineBinding, expected?: ChatEngineState,
): boolean {
  if (!isEngineSessionBinding(binding)) throw new Error('Invalid engine session binding')
  const next = engineStateOf(binding)
  const map = readSessionIdMap(spacePath, appId, true)
  if (expected && !sameChatEngineState(engineStateOf(map[runId]), expected)) {
    console.warn(`[SessionStore] Rejected stale engine binding: app=${appId}, run=${runId}`)
    return false
  }
  if (sameChatEngineState(engineStateOf(map[runId]), next)) return true
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
    if (current.binding || current.routingEngine || current.useCurrentInstructions) {
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
      const converted = convertEventsToTranscript(events, positions, { imagesDir: imagesDirOf(filePath) }).messages.filter(message => !excludedRecords.has(message.id))
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
