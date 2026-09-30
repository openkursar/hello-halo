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

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import type { ImageAttachment } from '../../../shared/types/image-attachment'
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
   * to show, not any framed text the model was given.
   */
  writeTrigger(
    content: string,
    images?: ImageAttachment[],
    teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'>,
    provenance?: TranscriptProvenance
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

    writeTrigger(content, images, teamOrigin, provenance): void {
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
        message: { role: 'user', content: blocks },
      })
    },
  }
}

// ============================================
// Reader
// ============================================

/**
 * A session file parsed into messages, thoughts included. Cached per file
 * (see `parsedSessions`) so paging and on-demand thought loads do not re-parse a
 * long transcript on every call. Treat as immutable — it is shared.
 */
interface ParsedSession {
  messages: TranscriptMessage[]
}

// Bounded by file bytes; parsed messages cost 2-3x that on the heap.
const parsedSessions = createStampedLru<ParsedSession>({ maxEntries: 8, maxWeight: 32 * 1024 * 1024 })

/** Files already reported unreadable: every read retries, the log says it once. */
const reportedUnreadable = new Set<string>()

function parseSessionFile(filePath: string): ParsedSession | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !reportedUnreadable.has(filePath)) {
      reportedUnreadable.add(filePath)
      console.warn(`[SessionStore] Cannot read session file ${filePath}; showing it as empty:`, error)
    }
    return null
  }

  // Physical line numbers (blank and malformed lines included) are what message
  // ids derive from, so they must not shift when a line is skipped.
  const events: StoredEvent[] = []
  const lines: number[] = []
  const rawLines = raw.split('\n')
  let lastNonBlank = rawLines.length - 1
  while (lastNonBlank > 0 && !rawLines[lastNonBlank].trim()) lastNonBlank--
  const corrupt: number[] = []
  for (let i = 0; i < rawLines.length; i++) {
    if (!rawLines[i].trim()) continue
    try {
      events.push(JSON.parse(rawLines[i]))
      lines.push(i + 1)
    } catch {
      // A torn final line is a write still in progress; anywhere else it is damage.
      if (i !== lastNonBlank) corrupt.push(i + 1)
    }
  }
  if (corrupt.length > 0) {
    console.warn(`[SessionStore] Skipped ${corrupt.length} unreadable line(s) in ${filePath} (first: line ${corrupt[0]})`)
  }
  return { messages: convertEventsToMessages(events, lines) }
}

function loadParsedSession(spacePath: string, appId: string, runId: string): ParsedSession | null {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  return parsedSessions.get(filePath, () => parseSessionFile(filePath))
}

/**
 * Read a run's session JSONL and convert to renderer-compatible messages, each
 * with its full thought process.
 *
 * Returns an empty array if the file doesn't exist or is unreadable.
 */
export function readSessionMessages(spacePath: string, appId: string, runId: string): TranscriptMessage[] {
  return [...(loadParsedSession(spacePath, appId, runId)?.messages ?? [])]
}

/**
 * One page of a session's transcript, newest first (see `pageTranscript`).
 * Messages carry `thoughts: null` plus `thoughtsSummary`; load a message's
 * thought process with `readSessionMessageThoughts`.
 */
export function readSessionTranscript(
  spacePath: string,
  appId: string,
  runId: string,
  request: TranscriptPageRequest = {}
): TranscriptPage {
  const page = pageTranscript(loadParsedSession(spacePath, appId, runId)?.messages ?? [], request)
  return { ...page, messages: page.messages.map(withThoughtsUnloaded) }
}

/** The thought process of one message; empty when the message is unknown or has none. */
export function readSessionMessageThoughts(
  spacePath: string,
  appId: string,
  runId: string,
  messageId: string
): Thought[] {
  const message = loadParsedSession(spacePath, appId, runId)?.messages.find(m => m.id === messageId)
  return message?.thoughts ? [...message.thoughts] : []
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
    writeFileSync(toPath, readFileSync(fromPath, 'utf8'), 'utf8')
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
