/**
 * apps/runtime -- Pending Relay Spool
 *
 * Cross-session awareness for notify_bot pushes and private owner questions.
 * When a message reaches an IM contact outside a turn, its AI context knows
 * nothing about it — the push is pure SDK transport. This spool records each
 * push against the target sessionKey; dispatch-inbound appends a
 * <relay-context> block to the target's next inbound message text, which is
 * the only engine-agnostic way into an engine's history.
 *
 * Design constraints (see DESIGN.md §2.14):
 * - Engine-agnostic: never touches any engine's history storage. The rendered
 *   block rides an ordinary user message into whatever history the engine keeps.
 * - Peek/commit, never drain-and-hope: events are removed only after the engine
 *   confirms it accepted the message. Any failure before that leaves them
 *   queued, so a failed run can never lose relay context.
 * - No TTL: staleness is conveyed via the `at` timestamp and judged by the
 *   model. Ordinary pushes use a per-target cap with oldest-event collapse;
 *   private question actions are retained for the owner's next accepted turn.
 * - Durable: persisted as a small JSON file (im-session-registry write-behind
 *   pattern) so pushes survive app restarts. This is IM runtime scheduling
 *   state, not conversation storage.
 */

import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { truncateUtf16Safe } from './text-truncate'
import { AtomicFileWriter } from './atomic-file-writer'
import { parseAppChatKey } from '../../../shared/apps/im-keys'

// ============================================
// Types
// ============================================

/** Where a relay originated — enough to re-address and to locate the transcript. */
export interface RelaySource {
  /** Source conversationId (sessionKey) — the existing key system, no new IDs */
  key: string
  /** App the source session belongs to */
  appId: string
  /** Transcript runId under {space}/.halo/apps/{appId}/runs/ (session-store) */
  runId: string
  /** Human-readable origin label (app display name) */
  label?: string
}

/** The person whose request the relayed message is about (absent for automation). */
export interface RelaySubject {
  id: string
  name: string
}

/** A pushed message or private question awaiting injection into the target session. */
export interface RelayPushEvent {
  kind: 'push'
  /** Unique event id — the commit handle, also used for log correlation */
  id: string
  /** Push success timestamp (epoch ms) */
  at: number
  source: RelaySource
  subject?: RelaySubject
  /**
   * `instanceId:chatId` of the origin chat — the exact `to` value the recipient
   * AI needs to report an outcome back. Without it the AI can only guess from
   * the contact directory. Absent for automation runs (no origin chat).
   */
  originContact?: string
  /**
   * Whether the source run was owner-triggered, frozen at push time.
   * One half of the transcript-exposure gate (see {@link RelayRenderOptions}).
   */
  sourceOwner: boolean
  /** Pushed text (truncated copy — the full text lives in the source transcript) */
  message?: string
  /** Pushed file, display name only (temp paths are stale by consumption time) */
  file?: { name: string }
  /** Source-context snapshot captured by the runtime at push time (plain text) */
  quote?: string
  /** An invited action, not a credential; authority is issued only on an owner's turn. */
  action?: { kind: 'answer-question'; appId: string; entryId: string }
}

/**
 * Placeholder for pushes dropped by the per-target bound. Deliberately carries
 * no source or subject: attribution must never be merged across pushes, and a
 * collapsed range has no single origin. The content remains recoverable from
 * the source transcripts.
 */
export interface RelayCollapsedEvent {
  kind: 'collapsed'
  id: string
  /** Timestamp of the oldest collapsed push */
  at: number
  /** How many pushes this placeholder stands for */
  count: number
}

export type RelayEvent = RelayPushEvent | RelayCollapsedEvent

/** On-disk shape. Versioned — unknown versions are rejected, never guessed. */
interface PendingRelaysFile {
  version: 2
  pending: Record<string, RelayEvent[]>
}

const FILE_VERSION = 2

// ============================================
// Bounds
// ============================================

/** Ordinary pushes are bounded; question actions survive until the owner's next accepted turn. */
const MAX_ORDINARY_EVENTS_PER_TARGET = 10

/** Cap for stored push text — full text is always available in the source transcript. */
const MESSAGE_CAP = 2000

/** Cap for the source-context snapshot. */
const QUOTE_CAP = 1500

/**
 * A target whose newest event is this old is dropped. Pushes may legitimately
 * wait weeks for the next inbound message, so this is far longer than that; it
 * only bounds how many targets a spool can accumulate (chats that never speak
 * again).
 */
export const TARGET_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** At most one expiry sweep per this interval. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

// ============================================
// Store
// ============================================

/**
 * Persistent spool of pending relay events, keyed by target sessionKey.
 *
 * Persistence follows the im-session-registry pattern: load once at startup,
 * mutate in memory, coalesced fire-and-forget full-file writes, plus a
 * synchronous {@link flush} at shutdown. Ordinary traffic is capped per target;
 * question actions track the decisions not yet handed to that chat's owner.
 */
export class PendingRelayStore {
  private pending = new Map<string, RelayEvent[]>()
  private filePath: string
  private readonly writer: AtomicFileWriter
  private dirty = false
  private flushScheduled = false
  private readonly now: () => number
  private lastSweepAt = 0

  constructor(filePath: string, options: { now?: () => number } = {}) {
    this.filePath = filePath
    this.writer = new AtomicFileWriter(filePath, '[PendingRelays]')
    this.now = options.now ?? Date.now
    this.load()
    this.sweepExpired()
  }

  /**
   * Record a push against a target session. Caps stored text sizes and
   * enforces the per-target bound.
   */
  append(targetKey: string, event: RelayPushEvent): void {
    const capped: RelayPushEvent = {
      ...event,
      message: event.message !== undefined
        ? truncateUtf16Safe(event.message, MESSAGE_CAP)
        : undefined,
      quote: event.quote !== undefined
        ? truncateUtf16Safe(event.quote, QUOTE_CAP)
        : undefined,
    }

    const events = this.pending.get(targetKey) ?? []
    events.push(capped)
    this.collapseOverflow(targetKey, events)
    this.pending.set(targetKey, events)
    if (this.now() - this.lastSweepAt >= SWEEP_INTERVAL_MS) this.sweepExpired()
    this.requestPersist()

    console.log(
      `[PendingRelays] Recorded: id=${event.id}, target=${targetKey}, ` +
      `source=${event.source.key}, pending=${events.length}`
    )
  }

  /**
   * Read pending events for a target, oldest first, WITHOUT removing them.
   *
   * The caller renders them into the outgoing message text and calls
   * {@link commit} only once the engine has accepted that message. Anything
   * that fails in between (render error, session creation failure, model
   * error, crash) leaves the events queued for the next inbound message.
   */
  peek(targetKey: string): RelayEvent[] {
    const events = this.pending.get(targetKey)
    return events ? [...events] : []
  }

  /**
   * Drop the given event ids from a target — the engine has accepted the
   * message carrying them, so they now live in its history permanently.
   * Idempotent: unknown ids are ignored, so a double-commit is harmless.
   */
  commit(targetKey: string, eventIds: string[]): void {
    const events = this.pending.get(targetKey)
    if (!events || eventIds.length === 0) return

    const committed = new Set(eventIds)
    const kept = events.filter(e => !committed.has(e.id))
    if (kept.length === events.length) return

    if (kept.length === 0) {
      this.pending.delete(targetKey)
    } else {
      this.pending.set(targetKey, kept)
    }
    this.requestPersist()
    console.log(
      `[PendingRelays] Committed ${events.length - kept.length} event(s) for ${targetKey}`
    )
  }

  /** Drop all pending events for a target (context reset, session removal). */
  clear(targetKey: string): void {
    if (!this.pending.delete(targetKey)) return
    this.requestPersist()
    console.log(`[PendingRelays] Cleared pending events for ${targetKey}`)
  }

  /**
   * Drop pending events for a chat regardless of chat type — the session
   * registry removes sessions by (appId, channel, chatId) and must not leave
   * relay records that a re-registered session with the same chatId would
   * inherit.
   */
  clearForChat(appId: string, channel: string, chatId: string): void {
    for (const key of Array.from(this.pending.keys())) {
      const parsed = parseAppChatKey(key)
      if (parsed?.appId === appId && parsed.channel === channel && parsed.chatId === chatId) {
        this.clear(key)
      }
    }
  }

  /** Number of pending events for a target (diagnostics + tests). */
  count(targetKey: string): number {
    return this.pending.get(targetKey)?.length ?? 0
  }

  /**
   * Write pending state synchronously. Called at shutdown so events recorded
   * in the final moments are not lost with the coalescing timer.
   */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      this.writer.writeSync(this.serialize())
    } catch (err) {
      console.error('[PendingRelays] Failed to flush spool:', err)
    }
  }

  /** Drop targets whose newest event is past {@link TARGET_IDLE_TTL_MS}. */
  private sweepExpired(): void {
    const now = this.now()
    this.lastSweepAt = now
    let dropped = 0
    for (const [key, events] of this.pending) {
      const newest = events.reduce((max, e) => Math.max(max, e.at), 0)
      if (now - newest < TARGET_IDLE_TTL_MS) continue
      this.pending.delete(key)
      dropped += events.length
    }
    if (dropped === 0) return
    this.requestPersist()
    console.log(`[PendingRelays] Dropped ${dropped} event(s) of targets idle for over ${TARGET_IDLE_TTL_MS / 86_400_000} days`)
  }

  // ── Overflow collapse ────────────────────────────────

  /** Ordinary pushes must not evict a question the owner has not had a turn to answer. */
  private collapseOverflow(targetKey: string, events: RelayEvent[]): void {
    if (events.length <= MAX_ORDINARY_EVENTS_PER_TARGET) return
    const ordinary = events.filter(event => event.kind !== 'push' || !event.action)
    if (ordinary.length <= MAX_ORDINARY_EVENTS_PER_TARGET) return

    const overflow = ordinary.slice(0, ordinary.length - (MAX_ORDINARY_EVENTS_PER_TARGET - 1))
    const dropped = new Set(overflow.map(event => event.id))
    const count = overflow.reduce((n, event) => n + (event.kind === 'collapsed' ? event.count : 1), 0)
    const kept = events.filter(event => !dropped.has(event.id))
    kept.splice(events.indexOf(overflow[0]), 0, { kind: 'collapsed', id: randomUUID(), at: overflow[0].at, count })
    events.splice(0, events.length, ...kept)
    console.warn(`[PendingRelays] Collapsed ${overflow.length} ordinary event(s): target=${targetKey}, questionActions=${events.length - MAX_ORDINARY_EVENTS_PER_TARGET}`)
  }

  // ── Persistence ──────────────────────────────────────

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as PendingRelaysFile
      if (parsed.version !== FILE_VERSION || typeof parsed.pending !== 'object' || parsed.pending === null) {
        console.warn(
          `[PendingRelays] Unsupported spool version (${parsed.version}), starting fresh: ${this.filePath}`
        )
        return
      }
      let total = 0
      for (const [key, events] of Object.entries(parsed.pending)) {
        if (!Array.isArray(events)) continue
        const valid = events.filter(isValidEvent)
        if (valid.length !== events.length) {
          console.warn(`[PendingRelays] Dropped ${events.length - valid.length} malformed event(s): target=${key}`)
        }
        if (valid.length === 0) continue
        this.pending.set(key, valid)
        total += valid.length
      }
      if (total > 0) {
        console.log(
          `[PendingRelays] Loaded ${total} pending event(s) across ${this.pending.size} target(s)`
        )
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  /** Coalesce rapid mutations into one microtask-deferred write. */
  private requestPersist(): void {
    this.dirty = true
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      if (!this.dirty) return
      this.dirty = false
      this.persist()
    })
  }

  private serialize(): string {
    const file: PendingRelaysFile = {
      version: FILE_VERSION,
      pending: Object.fromEntries(this.pending),
    }
    return JSON.stringify(file)
  }

  /** Write the full spool to disk (fire-and-forget). */
  private persist(): void {
    this.writer.write(this.serialize())
  }
}

/**
 * Reject events that would break rendering. `at` is fed to `new Date(...)`,
 * where a missing value throws while formatting — inside the message-assembly
 * path, that would drop the user's message entirely.
 */
function isValidEvent(event: unknown): event is RelayEvent {
  if (!event || typeof event !== 'object') return false
  const e = event as Partial<RelayPushEvent> & Partial<RelayCollapsedEvent>
  if (typeof e.id !== 'string' || !Number.isFinite(e.at)) return false
  if (e.kind === 'push') {
    return typeof e.source?.key === 'string' && (e.action === undefined || (
      e.action?.kind === 'answer-question' &&
      typeof e.action.appId === 'string' && e.action.appId.length > 0 &&
      typeof e.action.entryId === 'string' && e.action.entryId.length > 0
    ))
  }
  if (e.kind === 'collapsed') return Number.isFinite(e.count)
  return false
}

// ============================================
// Runtime Tag Namespace
// ============================================

/**
 * Tags the runtime injects into message text. They are system-authoritative,
 * so untrusted text (inbound bodies, relayed content) must never be able to
 * emit them — see {@link sanitizeRuntimeTags}.
 */
const RUNTIME_TAGS = [
  'msg-sender',
  'relay-context',
  'relay-from',
  'relay-collapsed',
  'relay-action',
  'pushed',
  'pushed-file',
  'quote',
]

const RUNTIME_TAG_PATTERN = new RegExp(`<(/?)(${RUNTIME_TAGS.join('|')})\\b`, 'gi')

/**
 * Neutralize runtime tag openings in untrusted text so it cannot forge or
 * close a system tag. Applied to inbound message bodies and to relayed
 * content, both of which are attacker-influencable.
 */
export function sanitizeRuntimeTags(text: string): string {
  return text.replace(RUNTIME_TAG_PATTERN, '&lt;$1$2')
}

// ============================================
// Rendering
// ============================================

/** Disclosure controls for {@link renderRelayContext}. */
export interface RelayRenderOptions {
  /**
   * Reveal origin identity and source content (`from_session`, `subject_*`,
   * `reply_to`, `<quote>`). Follows the platform's IM trust model: only
   * senders treated as owners see who and what a push came from. Guests get
   * the delivered text alone, which was already sent to their chat anyway.
   */
  includeOrigin: boolean
  /**
   * Reveal source transcript paths. Requires an EXPLICITLY configured owner
   * roster, not merely the permissive default where every sender counts as an
   * owner: a transcript path grants bulk read access to another session's full
   * history, so it is opt-in rather than on-by-default. Its absence costs
   * nothing structural — subject and quote already carry the working context.
   */
  allowTranscript: boolean
  /**
   * Resolve a source transcript path at render time. Paths are never persisted
   * in relay events — directory rules belong to session-store and may change
   * between push and consumption.
   */
  resolveTranscriptPath?: (event: RelayPushEvent) => string | undefined
  /** Already prepared instructions, present only for the owner's invited actions. */
  actions?: ReadonlyMap<string, string>
}

/** Escape a string for use inside a double-quoted XML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Format a timestamp defensively — a bad value must never break assembly. */
function formatAt(at: number): string {
  return Number.isFinite(at) ? new Date(at).toISOString() : 'unknown'
}

function renderPushEvent(event: RelayPushEvent, options: RelayRenderOptions): string {
  const attrs = [`at="${formatAt(event.at)}"`]

  if (options.includeOrigin) {
    attrs.push(`from_session="${escapeAttr(event.source.key)}"`)
    if (event.source.label) {
      attrs.push(`source_label="${escapeAttr(event.source.label)}"`)
    }
    if (event.subject) {
      attrs.push(`subject_id="${escapeAttr(event.subject.id)}"`)
      attrs.push(`subject_name="${escapeAttr(event.subject.name)}"`)
    }
    if (event.originContact) {
      attrs.push(`reply_to="${escapeAttr(event.originContact)}"`)
    }
    if (event.sourceOwner && options.allowTranscript && options.resolveTranscriptPath) {
      const transcript = options.resolveTranscriptPath(event)
      if (transcript) {
        attrs.push(`transcript="${escapeAttr(transcript)}"`)
      }
    }
  }

  const body: string[] = []
  if (event.message !== undefined) {
    body.push(`<pushed>${sanitizeRuntimeTags(event.message)}</pushed>`)
  }
  if (event.file) {
    body.push(`<pushed-file name="${escapeAttr(event.file.name)}" />`)
  }
  if (options.includeOrigin && event.quote !== undefined) {
    body.push(`<quote>${sanitizeRuntimeTags(event.quote)}</quote>`)
  }

  const action = options.includeOrigin && event.action ? options.actions?.get(event.id) : undefined
  if (action) body.push(`<relay-action>\n${sanitizeRuntimeTags(action)}\n</relay-action>`)

  return `<relay-from ${attrs.join(' ')}>\n${body.join('\n')}\n</relay-from>`
}

/**
 * Render pending relay events as the block appended to the inbound message
 * text. Events render as independent, self-contained elements in chronological
 * order — attribution never merges across pushes.
 *
 * Returns an empty string when there is nothing to render, so callers can
 * append unconditionally.
 */
export function renderRelayContext(events: RelayEvent[], options: RelayRenderOptions): string {
  if (events.length === 0) return ''

  const blocks = events.map((event) =>
    event.kind === 'collapsed'
      ? `<relay-collapsed count="${event.count}" oldest_at="${formatAt(event.at)}" />`
      : renderPushEvent(event, options)
  )

  return `<relay-context>\n${blocks.join('\n')}\n</relay-context>`
}

// ============================================
// Quote Capture
// ============================================

/** Cap applied when capturing the triggering message as a relay quote. */
const QUOTE_CAPTURE_CAP = 300

/**
 * Build a relay quote from the message that triggered the pushing run.
 *
 * Must be fed the raw inbound body, never assembled message text: assembled
 * text carries runtime tags and, for a run that itself consumed a relay, the
 * previous hop's relay block — quoting that would propagate boilerplate
 * instead of the user's actual request. Any leading tag line is stripped as a
 * defensive measure for callers that only have assembled text.
 */
export function buildQuoteFromMessage(message: string, senderName?: string): string | undefined {
  let text = message
  const relayStart = text.indexOf('<relay-context>')
  if (relayStart !== -1) {
    text = text.slice(0, relayStart)
  }
  text = text.trim()
  while (text.startsWith('<')) {
    const newline = text.indexOf('\n')
    if (newline === -1) return undefined
    text = text.slice(newline + 1).trim()
  }
  if (!text) return undefined
  const capped = truncateUtf16Safe(text, QUOTE_CAPTURE_CAP)
  return senderName ? `${senderName}: ${capped}` : capped
}

// ============================================
// Module-level Singleton
// ============================================

let storeInstance: PendingRelayStore | null = null

/** Set the global spool instance. Called during runtime initialization. */
export function setPendingRelayStore(store: PendingRelayStore | null): void {
  storeInstance = store
}

/** Get the global spool instance. Returns null before initialization. */
export function getPendingRelayStore(): PendingRelayStore | null {
  return storeInstance
}
