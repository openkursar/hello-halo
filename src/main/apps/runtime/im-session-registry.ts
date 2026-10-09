/**
 * apps/runtime -- IM Session Registry
 *
 * Manages all known IM channel sessions across digital humans (Apps).
 * Sessions are automatically registered when a user messages the bot.
 * The `proactive` flag is toggled per contact in the digital human
 * detail page and consumed by apps/runtime/im-auto-sync.ts. Another digital
 * human can be linked to a session as an extra push target (`pushLinks`); the
 * link lives on the session, so it goes when the session does.
 *
 * Persistence: JSON file on disk, loaded at startup, written on every mutation.
 * Data volume is small (a few to tens of sessions per app), so full-file
 * writes are acceptable. Every conversation list reads this file, so a write
 * replaces it atomically and never overlaps another, and a file that cannot
 * be read is set aside rather than overwritten.
 *
 * Thread safety: All mutations are synchronous (single Node.js event loop),
 * but disk writes are fire-and-forget async to avoid blocking.
 */

import { readFileSync, renameSync } from 'fs'
import type { ImPushLink, ImSessionRecord } from '../../../shared/types/im-channel'
import { classifySessionSource, LOCAL_SESSION_CHANNEL } from '../../../shared/types/im-channel'
import { buildTeamSessionKey } from '../../../shared/apps/im-keys'
import { truncateUtf16Safe } from './text-truncate'
import { getPendingRelayStore } from './pending-relays'
import { getConversationReminders } from './reminders'
import { AtomicFileWriter } from './atomic-file-writer'

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

/** The push link `appId` holds on another digital human's IM session, if any. */
function pushLinkOf(session: ImSessionRecord, appId: string): ImPushLink | undefined {
  if (session.source !== 'im' || session.appId === appId) return undefined
  return session.pushLinks?.find(link => link.appId === appId)
}

/** Links as read from disk: well-formed, one per app, never the session's own. */
function readPushLinks(value: unknown, ownAppId: string): ImPushLink[] {
  if (!Array.isArray(value)) return []
  const links = new Map<string, ImPushLink>()
  for (const entry of value as Array<Partial<ImPushLink> | null>) {
    if (typeof entry?.appId !== 'string' || !entry.appId || entry.appId === ownAppId) continue
    links.set(entry.appId, { appId: entry.appId, autoSync: entry.autoSync === true })
  }
  return [...links.values()]
}

// ============================================
// Registry Implementation
// ============================================

export class ImSessionRegistry {
  /** In-memory session store, keyed by "{appId}:{channel}:{chatId}" */
  private sessions = new Map<SessionKey, ImSessionRecord>()
  private sessionRevisions = new WeakMap<ImSessionRecord, object>()

  /** File path for JSON persistence */
  private filePath: string

  private readonly writer: AtomicFileWriter

  /** There are in-memory changes not yet written to disk. */
  private dirty = false

  /** An immediate (microtask) flush is already queued. */
  private microtaskScheduled = false

  /** A throttled (soft) flush timer is pending, if any. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(filePath: string) {
    this.filePath = filePath
    this.writer = new AtomicFileWriter(filePath, '[ImSessionRegistry]')
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
    opts?: {
      displayName?: string
      lastSender?: string
      lastMessage?: string
      teamContext?: ImSessionRecord['teamContext']
      contactId?: string
    }
  ): void {
    const key = this.buildKey(appId, channel, chatId)
    const existing = this.sessions.get(key)

    if (existing) {
      const archiveChanged = existing.teamContext?.epochId !== opts?.teamContext?.epochId || existing.teamContext?.teamId !== opts?.teamContext?.teamId
      const contactChanged = !!opts?.contactId && existing.contactId !== opts.contactId
      if (existing.instanceId !== instanceId || archiveChanged || contactChanged) {
        this.sessionRevisions.delete(existing)
      }
      // displayName is intentionally NOT updated — stable after first registration
      existing.lastActiveAt = Date.now()
      existing.instanceId = instanceId // Always update to latest instance
      existing.teamContext = opts?.teamContext
      existing.messageCount = (existing.messageCount ?? 0) + 1
      if (opts?.lastSender !== undefined) existing.lastSender = opts.lastSender
      if (opts?.lastMessage !== undefined) existing.lastMessage = truncateUtf16Safe(opts.lastMessage, 50)
      if (contactChanged) existing.contactId = opts!.contactId
      this.requestPersist(archiveChanged || contactChanged)
    } else {
      const source = classifySessionSource(channel)
      this.sessions.set(key, {
        appId,
        channel,
        teamContext: opts?.teamContext,
        source,
        instanceId,
        chatId,
        chatType,
        ...(opts?.contactId ? { contactId: opts.contactId } : {}),
        displayName: opts?.displayName || chatId,
        proactive: false,
        lastActiveAt: Date.now(),
        lastSender: opts?.lastSender,
        lastMessage: opts?.lastMessage !== undefined ? truncateUtf16Safe(opts.lastMessage, 50) : undefined,
        messageCount: 1,
      })
      // Bound HTTP-source growth before the new record is durably persisted.
      if (source === 'http') {
        this.enforceHttpLimits(appId)
      }
      // New session is a structural change → persist promptly.
      this.requestPersist(true)
    }
  }

  /** Refresh a push destination without pretending an inbound message arrived. */
  setTeamContext(appId: string, channel: string, chatId: string, teamContext: ImSessionRecord['teamContext']): void {
    const session = this.sessions.get(this.buildKey(appId, channel, chatId))
    if (!session) {
      console.warn(`[ImSessionRegistry] Cannot refresh missing chat destination: appId=${appId}, channel=${channel}, chatId=${chatId}`)
      return
    }
    if (session.teamContext?.teamId === teamContext?.teamId && session.teamContext?.epochId === teamContext?.epochId) return
    this.sessionRevisions.delete(session)
    session.teamContext = teamContext ? { ...teamContext } : undefined
    this.requestPersist(true)
  }

  // ── Native local sessions (source === 'local') ───────

  /**
   * Create a native client-side chat session record.
   *
   * These are the desktop user's extra chat windows for a digital human,
   * addressed by "app-chat:{appId}:local:direct:{sessionUuid}". Idempotent:
   * returns the existing record if the uuid is already registered.
   *
   * `displayName` is left empty by default so the renderer can localize the
   * fallback label (first-message preview / "New chat") without a backend
   * English string leaking into the UI.
   */
  createLocalSession(
    appId: string,
    sessionUuid: string,
    opts?: { displayName?: string; forkOrigin?: string; pendingResumeSessionId?: string }
  ): ImSessionRecord {
    const key = this.buildKey(appId, LOCAL_SESSION_CHANNEL, sessionUuid)
    const existing = this.sessions.get(key)
    if (existing) return { ...existing }

    const record: ImSessionRecord = {
      appId,
      channel: LOCAL_SESSION_CHANNEL,
      source: 'local',
      instanceId: '',
      chatId: sessionUuid,
      chatType: 'direct',
      displayName: opts?.displayName ?? '',
      proactive: false,
      lastActiveAt: Date.now(),
      forkOrigin: opts?.forkOrigin,
      pendingResumeSessionId: opts?.pendingResumeSessionId,
      messageCount: 0,
    }
    this.sessions.set(key, record)
    this.requestPersist(true)
    return { ...record }
  }

  /**
   * Peek the pending resume-and-fork source SDK session id for a session, if
   * any. Consumed on the session's first message to branch a new SDK session
   * from the source context. Peek (not consume) so a failed first attempt can
   * retry; cleared via {@link clearPendingResume} only after the new forked
   * session id is captured.
   */
  getPendingResume(appId: string, channel: string, chatId: string): string | undefined {
    const session = this.sessions.get(this.buildKey(appId, channel, chatId))
    return session?.pendingResumeSessionId
  }

  /**
   * Clear a session's pending resume-and-fork marker once the fork has been
   * established (new forked session id captured).
   */
  clearPendingResume(appId: string, channel: string, chatId: string): void {
    const session = this.sessions.get(this.buildKey(appId, channel, chatId))
    if (session?.pendingResumeSessionId) {
      delete session.pendingResumeSessionId
      this.requestPersist(true)
    }
  }

  /**
   * Note a message the digital human pushed to a chat (chat-record): it is the
   * chat's latest message now, so the chat moves to the top of the list. No-op
   * for unknown sessions.
   */
  notePush(appId: string, channel: string, chatId: string, opts: { lastSender?: string; lastMessage: string }): void {
    const session = this.sessions.get(this.buildKey(appId, channel, chatId))
    if (!session) return
    session.lastActiveAt = Date.now()
    session.messageCount = (session.messageCount ?? 0) + 1
    if (opts.lastSender !== undefined) session.lastSender = opts.lastSender
    session.lastMessage = truncateUtf16Safe(opts.lastMessage, 50)
    this.requestPersist(false)
  }

  /**
   * Reset a session's message-activity summary after its transcript has been
   * wiped (see app-chat.ts's clearSessionByConversationId, shared by
   * clearAppChat/clearImSession/deleteNativeChatSession's own removal path).
   * Identity fields (displayName/customName/proactive/forkOrigin/...) are left
   * untouched — only lastMessage/messageCount are zeroed so a conversation-list
   * preview matches the now-empty transcript. No-op for unknown sessions.
   */
  resetActivity(appId: string, channel: string, chatId: string): void {
    const session = this.sessions.get(this.buildKey(appId, channel, chatId))
    if (!session) return
    this.sessionRevisions.delete(session)
    session.lastMessage = undefined
    session.messageCount = 0
    this.requestPersist(true)
  }

  /**
   * Add a record rebuilt from data kept elsewhere (a transcript older than the
   * registry's tracking of it). Never replaces a registered session.
   *
   * @returns true if the record was added
   */
  restoreSession(record: ImSessionRecord): boolean {
    const key = this.buildKey(record.appId, record.channel, record.chatId)
    if (this.sessions.has(key)) return false
    this.sessions.set(key, { ...record })
    this.requestPersist(true)
    return true
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
   * Set the automatically-resolved real name for a session, sourced from a
   * channel's optional identity-resolution capability (e.g. WeCom's message
   * capability, for bots whose sender IDs are otherwise opaque).
   *
   * Distinct from customName/displayName: unlike displayName, this is
   * overwritten as fresher lookups succeed; unlike customName, callers must
   * never let this override a user's own choice — see the UI's display
   * priority (customName > resolvedName > displayName > chatId).
   *
   * No-ops for sessions not yet known — an identity directory can return
   * entries with no local session record (e.g. a contact who hasn't
   * messaged this app), which are simply not applicable here.
   *
   * @returns true if the session was found and updated
   */
  setResolvedName(appId: string, channel: string, chatId: string, name: string): boolean {
    const key = this.buildKey(appId, channel, chatId)
    const session = this.sessions.get(key)
    if (!session) return false
    if (session.resolvedName === name) return false
    session.resolvedName = name
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

    if (session.proactive !== proactive) this.sessionRevisions.delete(session)
    session.proactive = proactive
    this.requestPersist(true)
    return true
  }

  /**
   * Get all sessions with proactive=true for a given app, and the sessions it
   * is linked to with auto-sync on.
   *
   * Consumed by apps/runtime/im-auto-sync.ts at run completion to dispatch
   * the assistant's final text response, and by apps/runtime/prompt.ts when
   * building the AI's auto-sync awareness fragment.
   */
  getProactiveSessions(appId: string): ImSessionRecord[] {
    return this.pushTargets(appId, session => session.proactive, link => link.autoSync)
  }

  /**
   * Get all pushable IM sessions for a given app (source==='im'): its own and
   * those it is linked to.
   *
   * Used to build the notify_bot contact directory: the AI can only push to
   * sessions backed by a live channel adapter. HTTP/API sessions are excluded
   * here so they never appear as push targets.
   */
  getPushableSessions(appId: string): ImSessionRecord[] {
    const result = this.pushTargets(appId, () => true, () => true)
    result.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return result
  }

  /**
   * Another digital human's IM sessions this app is linked to, most recently
   * active first. Each copy is the session as its own app holds it.
   */
  getLinkedSessions(appId: string): ImSessionRecord[] {
    const result: ImSessionRecord[] = []
    for (const session of this.sessions.values()) {
      if (pushLinkOf(session, appId)) result.push({ ...session })
    }
    result.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return result
  }

  /**
   * Add, update or (`link` null) remove `appId`'s push link on another digital
   * human's IM session, named by that session's own keys.
   *
   * @returns false when there is no such session, it is not an IM session, or
   *   it is `appId`'s own
   */
  setPushLink(
    appId: string,
    target: { appId: string; channel: string; chatId: string },
    link: { autoSync: boolean } | null
  ): boolean {
    const session = this.sessions.get(this.buildKey(target.appId, target.channel, target.chatId))
    if (!session || session.source !== 'im' || session.appId === appId) return false
    const others = (session.pushLinks ?? []).filter(existing => existing.appId !== appId)
    const next = link ? [...others, { appId, autoSync: link.autoSync }] : others
    if (next.length > 0) session.pushLinks = next
    else delete session.pushLinks
    this.requestPersist(true)
    return true
  }

  /**
   * The IM sessions `appId` reaches: its own that pass `own`, then those it is
   * linked to whose link passes `linked`. A bot chat it reaches both ways is
   * listed once, as its own.
   */
  private pushTargets(
    appId: string,
    own: (session: ImSessionRecord) => boolean,
    linked: (link: ImPushLink) => boolean
  ): ImSessionRecord[] {
    const result: ImSessionRecord[] = []
    const routes = new Set<string>()
    for (const session of this.sessions.values()) {
      // Only IM sessions have a channel adapter to push through.
      if (session.appId !== appId || session.source !== 'im') continue
      routes.add(`${session.instanceId}:${session.chatId}`)
      if (own(session)) result.push({ ...session })
    }
    for (const session of this.sessions.values()) {
      const link = pushLinkOf(session, appId)
      const route = `${session.instanceId}:${session.chatId}`
      if (!link || !linked(link) || routes.has(route)) continue
      routes.add(route)
      result.push({ ...session })
    }
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

  /** Memory-only identity invalidated by recipient changes, selection changes or chat clearing. */
  getSessionRevision(appId: string, channel: string, chatId: string): object | undefined {
    const session = this.sessions.get(this.buildKey(appId, channel, chatId))
    if (!session) return undefined
    let revision = this.sessionRevisions.get(session)
    if (!revision) {
      revision = {}
      this.sessionRevisions.set(session, revision)
    }
    return revision
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
    const session = this.sessions.get(key)
    if (!session) return false
    this.sessions.delete(key)
    this.requestPersist(true)
    // Re-registering the chat must not inherit its pending context or reminders.
    this.clearPendingRelays(session)
    getConversationReminders()?.removeForChat(appId, channel, chatId)
    return true
  }

  /**
   * Remove all sessions for a given app.
   * Called when an app is deleted.
   */
  removeAllForApp(appId: string): number {
    let count = 0
    let unlinked = false
    for (const [key, session] of this.sessions) {
      if (session.appId === appId) {
        this.sessions.delete(key)
        this.clearPendingRelays(session)
        getConversationReminders()?.removeForChat(session.appId, session.channel, session.chatId)
        count++
      } else if (pushLinkOf(session, appId)) {
        // Its links on other apps' sessions go with it.
        const others = session.pushLinks!.filter(link => link.appId !== appId)
        if (others.length > 0) session.pushLinks = others
        else delete session.pushLinks
        unlinked = true
      }
    }
    if (count > 0 || unlinked) {
      this.requestPersist(true)
    }
    return count
  }

  private clearPendingRelays(session: ImSessionRecord): void {
    const spool = getPendingRelayStore()
    if (!spool) {
      console.warn(`[ImSessionRegistry] Pending relay cleanup unavailable: appId=${session.appId}, channel=${session.channel}, chatId=${session.chatId}, reason=relay spool unavailable`)
      return
    }
    spool.clearForChat(session.appId, session.channel, session.chatId)
    if (session.teamContext) {
      spool.clear(buildTeamSessionKey(session.appId, session.teamContext.teamId, session.teamContext.epochId))
    }
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
        this.evictHttpSession(entry.key, entry.rec)
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
        this.evictHttpSession(evictable[i].key, evictable[i].rec)
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

  /** An evicted session's reminders go with it, as they do on removal. */
  private evictHttpSession(key: SessionKey, rec: ImSessionRecord): void {
    this.sessions.delete(key)
    getConversationReminders()?.removeForChat(rec.appId, rec.channel, rec.chatId)
  }

  // ── Persistence ──────────────────────────────────────

  private buildKey(appId: string, channel: string, chatId: string): SessionKey {
    return `${appId}:${channel}:${chatId}`
  }

  /** Load sessions from disk; a missing file starts empty, an unreadable one is set aside first. */
  private load(): void {
    let records: ImSessionRecord[]
    try {
      records = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[ImSessionRegistry] No existing sessions file, starting fresh')
      } else {
        this.setAside(error)
      }
      return
    }
    if (!Array.isArray(records)) {
      this.setAside(new Error('not a session list'))
      return
    }

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
        if (r.pushLinks !== undefined) {
          const links = r.source === 'im' ? readPushLinks(r.pushLinks, r.appId) : []
          if (links.length > 0) r.pushLinks = links
          else delete r.pushLinks
        }
        const key = this.buildKey(r.appId, r.channel, r.chatId)
        this.sessions.set(key, r)
      }
    }
    console.log(`[ImSessionRegistry] Loaded ${this.sessions.size} sessions from disk`)
  }

  /** Move an unreadable file out of the way, so starting empty never overwrites it. */
  private setAside(reason: unknown): void {
    const asidePath = `${this.filePath}.unreadable-${Date.now()}`
    try {
      renameSync(this.filePath, asidePath)
      console.error(`[ImSessionRegistry] Sessions file unreadable, kept as ${asidePath}; starting empty:`, reason)
    } catch (error) {
      console.error(`[ImSessionRegistry] Sessions file unreadable and could not be set aside (${String(error)}); starting empty:`, reason)
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
    this.writer.write(JSON.stringify(Array.from(this.sessions.values()), null, 2))
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
