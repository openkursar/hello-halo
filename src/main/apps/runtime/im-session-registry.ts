/**
 * apps/runtime -- IM Session Registry
 *
 * Manages all known IM channel sessions across digital humans (Apps).
 * Sessions are automatically registered when a user messages the bot.
 * The `proactive` flag is toggled per contact in the digital human
 * detail page and consumed by apps/runtime/im-auto-sync.ts.
 *
 * Persistence: JSON file on disk, loaded at startup, written on every mutation.
 * Data volume is small (a few to tens of sessions per app), so full-file
 * writes are acceptable.
 *
 * Thread safety: All mutations are synchronous (single Node.js event loop),
 * but disk writes are fire-and-forget async to avoid blocking.
 */

import { readFileSync, writeFile, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { classifySessionSource } from '../../../shared/types/im-channel'

// ============================================
// Types
// ============================================

/** Composite key for session lookup */
type SessionKey = string

// ============================================
// Bounds (HTTP sessions only)
// ============================================
//
// IM sessions are human-bounded and carry user intent, so they are never capped.
// HTTP sessions use a caller-supplied conversationId, so a high-volume backend
// can mint unbounded distinct sessions; these bounds apply to HTTP sessions ONLY.
//
// Eviction is safe: the registry holds only UI/notify metadata. The JSONL
// transcript is keyed by conversationId independently, so an evicted HTTP
// session still reads/writes via the API and re-registers on its next message.

/** Max retained HTTP sessions per app (most-recently-active are kept). */
const MAX_HTTP_SESSIONS_PER_APP = 500

/** HTTP sessions idle longer than this are pruned. */
const HTTP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Throttle window for activity-only updates (lastActiveAt / lastMessage). These
 * high-frequency writes are coalesced onto a timer rather than rewriting the
 * whole file per message; losing a few seconds of them on an abrupt exit is
 * harmless. Structural changes persist promptly via the microtask path instead.
 */
const SOFT_PERSIST_THROTTLE_MS = 5000

// ============================================
// Registry Implementation
// ============================================

export class ImSessionRegistry {
  /** In-memory session store, keyed by "{appId}:{channel}:{chatId}" */
  private sessions = new Map<SessionKey, ImSessionRecord>()

  /** File path for JSON persistence */
  private filePath: string

  /** There are in-memory changes not yet written to disk. */
  private dirty = false

  /** An immediate (microtask) flush is already queued. */
  private microtaskScheduled = false

  /** A throttled (soft) flush timer is pending, if any. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(filePath: string) {
    this.filePath = filePath
    this.load()
  }

  // ── Core Operations ──────────────────────────────────

  /**
   * Register or update a session.
   *
   * Called by dispatch-inbound after routing succeeds. Idempotent:
   * - New session: creates with proactive=false, sets displayName once
   * - Existing session: updates lastActiveAt, lastSender, lastMessage only
   *   (never overwrites displayName or customName)
   */
  register(
    appId: string,
    channel: string,
    chatId: string,
    chatType: 'direct' | 'group',
    instanceId: string,
    opts?: { displayName?: string; lastSender?: string; lastMessage?: string }
  ): void {
    const key = this.buildKey(appId, channel, chatId)
    const existing = this.sessions.get(key)

    if (existing) {
      // displayName is intentionally NOT updated — stable after first registration
      existing.lastActiveAt = Date.now()
      existing.instanceId = instanceId // Always update to latest instance
      if (opts?.lastSender !== undefined) existing.lastSender = opts.lastSender
      if (opts?.lastMessage !== undefined) existing.lastMessage = opts.lastMessage.slice(0, 50)
      // Activity-only update → throttled persist (high-frequency, low-value).
      this.requestPersist(false)
    } else {
      const source = classifySessionSource(channel)
      this.sessions.set(key, {
        appId,
        channel,
        source,
        instanceId,
        chatId,
        chatType,
        displayName: opts?.displayName || chatId,
        proactive: false,
        lastActiveAt: Date.now(),
        lastSender: opts?.lastSender,
        lastMessage: opts?.lastMessage?.slice(0, 50),
      })
      // Bound HTTP-source growth before the new record is durably persisted.
      if (source === 'http') {
        this.enforceHttpLimits(appId)
      }
      // New session is a structural change → persist promptly.
      this.requestPersist(true)
    }
  }

  /**
   * Set a user-defined custom name for a session.
   * customName has the highest display priority in the UI.
   *
   * @returns true if the session was found and updated
   */
  setCustomName(appId: string, channel: string, chatId: string, name: string): boolean {
    const key = this.buildKey(appId, channel, chatId)
    const session = this.sessions.get(key)
    if (!session) return false

    session.customName = name || undefined // empty string clears it
    this.requestPersist(true)
    return true
  }

  /**
   * Set the proactive flag for a session. When true, the assistant's final
   * text response is auto-pushed to this contact at run completion by
   * apps/runtime/im-auto-sync.ts. The AI is informed via a prompt fragment
   * (see prompt.ts buildAutoSyncAwareness) so it can avoid duplicate
   * notify_bot calls to the same contact.
   *
   * @returns true if the session was found and updated
   */
  setProactive(appId: string, channel: string, chatId: string, proactive: boolean): boolean {
    const key = this.buildKey(appId, channel, chatId)
    const session = this.sessions.get(key)
    if (!session) return false

    session.proactive = proactive
    this.requestPersist(true)
    return true
  }

  /**
   * Get all sessions with proactive=true for a given app.
   *
   * Consumed by apps/runtime/im-auto-sync.ts at run completion to dispatch
   * the assistant's final text response, and by apps/runtime/prompt.ts when
   * building the AI's auto-sync awareness fragment.
   */
  getProactiveSessions(appId: string): ImSessionRecord[] {
    const result: ImSessionRecord[] = []
    for (const session of this.sessions.values()) {
      // Only IM sessions have a channel adapter to push through.
      if (session.appId === appId && session.proactive && session.source === 'im') {
        result.push({ ...session })
      }
    }
    return result
  }

  /**
   * Get all pushable IM sessions for a given app (source==='im').
   *
   * Used to build the notify_bot contact directory: the AI can only push to
   * sessions backed by a live channel adapter. HTTP/API sessions are excluded
   * here so they never appear as push targets.
   */
  getPushableSessions(appId: string): ImSessionRecord[] {
    const result: ImSessionRecord[] = []
    for (const session of this.sessions.values()) {
      if (session.appId === appId && session.source === 'im') {
        result.push({ ...session })
      }
    }
    result.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return result
  }

  /**
   * Find a single session by app + channel + chatId.
   * Returns a copy, or undefined if not registered.
   */
  findSession(appId: string, channel: string, chatId: string): ImSessionRecord | undefined {
    const key = this.buildKey(appId, channel, chatId)
    const session = this.sessions.get(key)
    return session ? { ...session } : undefined
  }

  /**
   * Get all known sessions for a given app.
   * Used by the settings UI to display the session list.
   */
  getAllSessions(appId: string): ImSessionRecord[] {
    const result: ImSessionRecord[] = []
    for (const session of this.sessions.values()) {
      if (session.appId === appId) {
        result.push({ ...session })
      }
    }
    // Sort by lastActiveAt descending (most recent first)
    result.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return result
  }

  /**
   * Get ALL sessions across all apps.
   * Used by the global settings UI to display a complete session overview.
   */
  listAll(): ImSessionRecord[] {
    const result = Array.from(this.sessions.values()).map(s => ({ ...s }))
    result.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return result
  }

  /**
   * Remove a session from the registry.
   * Optional cleanup operation for the settings UI.
   *
   * @returns true if the session was found and removed
   */
  removeSession(appId: string, channel: string, chatId: string): boolean {
    const key = this.buildKey(appId, channel, chatId)
    const deleted = this.sessions.delete(key)
    if (deleted) {
      this.requestPersist(true)
    }
    return deleted
  }

  /**
   * Remove all sessions for a given app.
   * Called when an app is deleted.
   */
  removeAllForApp(appId: string): number {
    let count = 0
    for (const [key, session] of this.sessions) {
      if (session.appId === appId) {
        this.sessions.delete(key)
        count++
      }
    }
    if (count > 0) {
      this.requestPersist(true)
    }
    return count
  }

  // ── Bounds enforcement (HTTP sessions) ───────────────

  /**
   * Prune expired HTTP sessions and enforce the per-app HTTP cap.
   *
   * Only HTTP-source sessions are considered; IM sessions are never touched.
   * User-pinned HTTP sessions (those given a customName) are exempt from
   * eviction so an explicit user action is never silently undone. Runs only
   * when a *new* HTTP session is inserted, so the scan cost is bounded by the
   * cap and is off the per-message activity path.
   */
  private enforceHttpLimits(appId: string): void {
    const now = Date.now()
    const httpForApp: { key: SessionKey; rec: ImSessionRecord }[] = []
    for (const [key, rec] of this.sessions) {
      if (rec.appId === appId && rec.source === 'http') {
        httpForApp.push({ key, rec })
      }
    }

    let evicted = 0

    // 1. TTL prune (non-pinned, idle beyond TTL).
    const survivors: { key: SessionKey; rec: ImSessionRecord }[] = []
    for (const entry of httpForApp) {
      if (!entry.rec.customName && now - entry.rec.lastActiveAt > HTTP_SESSION_TTL_MS) {
        this.sessions.delete(entry.key)
        evicted++
      } else {
        survivors.push(entry)
      }
    }

    // 2. Cap enforce: drop oldest non-pinned survivors beyond the cap.
    if (survivors.length > MAX_HTTP_SESSIONS_PER_APP) {
      const overflow = survivors.length - MAX_HTTP_SESSIONS_PER_APP
      const evictable = survivors
        .filter(e => !e.rec.customName)
        .sort((a, b) => a.rec.lastActiveAt - b.rec.lastActiveAt) // oldest first
      for (let i = 0; i < overflow && i < evictable.length; i++) {
        this.sessions.delete(evictable[i].key)
        evicted++
      }
    }

    if (evicted > 0) {
      console.log(
        `[ImSessionRegistry] Evicted ${evicted} HTTP session(s) for app ${appId} ` +
        `(cap=${MAX_HTTP_SESSIONS_PER_APP}, ttl=${HTTP_SESSION_TTL_MS}ms)`
      )
    }
  }

  // ── Persistence ──────────────────────────────────────

  private buildKey(appId: string, channel: string, chatId: string): SessionKey {
    return `${appId}:${channel}:${chatId}`
  }

  /** Load sessions from disk. Silent on missing/corrupt file. */
  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const records: ImSessionRecord[] = JSON.parse(raw)
      if (!Array.isArray(records)) return

      for (const r of records) {
        if (r.appId && r.channel && r.chatId) {
          // Backward compat: old sessions may lack instanceId
          if (!r.instanceId) {
            r.instanceId = ''
          }
          // Backward compat: records persisted before `source` existed were
          // all IM sessions; derive from the channel value for correctness.
          if (!r.source) {
            r.source = classifySessionSource(r.channel)
          }
          const key = this.buildKey(r.appId, r.channel, r.chatId)
          this.sessions.set(key, r)
        }
      }
      console.log(`[ImSessionRegistry] Loaded ${this.sessions.size} sessions from disk`)
    } catch {
      // File doesn't exist or is corrupt — start fresh
      console.log('[ImSessionRegistry] No existing sessions file, starting fresh')
    }
  }

  /**
   * Request a write to disk, coalescing rapid mutations.
   *
   * @param immediate - true for structural changes (new session, rename,
   *   proactive, removal): flush on the next microtask. false for activity-only
   *   updates (lastActiveAt / lastMessage): flush on a throttled timer so a
   *   high-frequency message stream does not rewrite the whole file per
   *   message. An already-queued immediate flush supersedes the throttled one.
   */
  private requestPersist(immediate: boolean): void {
    this.dirty = true

    if (immediate) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      if (this.microtaskScheduled) return
      this.microtaskScheduled = true
      queueMicrotask(() => {
        this.microtaskScheduled = false
        this.flushIfDirty()
      })
      return
    }

    // Throttled (soft) path: skip if any flush is already pending.
    if (this.microtaskScheduled || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushIfDirty()
    }, SOFT_PERSIST_THROTTLE_MS)
    // Don't let a pending soft write keep the process alive at exit; losing a
    // few seconds of activity metadata on shutdown is acceptable.
    this.flushTimer.unref?.()
  }

  private flushIfDirty(): void {
    if (!this.dirty) return
    this.dirty = false
    this.persist()
  }

  /** Write all sessions to disk (fire-and-forget). */
  private persist(): void {
    const records = Array.from(this.sessions.values())
    const json = JSON.stringify(records, null, 2)

    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
    } catch {
      // Directory likely already exists
    }

    writeFile(this.filePath, json, 'utf8', (err) => {
      if (err) {
        console.error('[ImSessionRegistry] Failed to persist sessions:', err)
      }
    })
  }
}

// ============================================
// Module-level Singleton
// ============================================

let registryInstance: ImSessionRegistry | null = null

/** Set the global registry instance. Called during runtime initialization. */
export function setImSessionRegistry(registry: ImSessionRegistry): void {
  registryInstance = registry
}

/** Get the global registry instance. Returns null before initialization. */
export function getImSessionRegistry(): ImSessionRegistry | null {
  return registryInstance
}
