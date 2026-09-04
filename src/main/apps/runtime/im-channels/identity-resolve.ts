/**
 * apps/runtime/im-channels -- Identity Resolution (channel-agnostic)
 *
 * Resolves opaque platform-side chat IDs to human-readable display names,
 * for channels that expose the optional `identityCapability` (see
 * shared/types/im-channel.ts). Not all IM platforms need this — WeCom's
 * sender-anonymized bots (created after its April 2026 change) are the
 * motivating case, but this module never branches on channel type: it only
 * speaks the `identityCapability` interface, exactly like the existing
 * `fileCapability` opt-in pattern used for outbound file sends.
 *
 * Called from dispatch-inbound.ts on every inbound message (cheap no-op
 * when already resolved or the capability is absent). On a cache miss it
 * fetches the channel's identity directory and backfills every session the
 * directory covers, not just the one that triggered the call — a single
 * WeCom fetch returns up to 20 sessions, so this maximizes the value of
 * each API call while keeping the trigger dead simple.
 *
 * The caller supplies `identityCapability` directly (looked up from the
 * live instance) rather than this module looking it up itself via the
 * ImChannelManager accessor in `./index` — `./index` exists specifically to
 * let dispatch-inbound reach the manager without a circular import back
 * through `manager.ts` (see its header comment), and `manager.ts` itself
 * imports this module for status reporting; taking the manager dependency
 * here too would close that loop back on itself.
 */

import { getImSessionRegistry, type ImSessionRegistry } from '../im-session-registry'
import { sendToRenderer } from '../../../foundation/window.service'
import { broadcastToAll } from '../../../http/websocket'
import { ImIdentityAuthExpiredError, type ImIdentityCapability } from '../../../../shared/types/im-channel'

const LOG_TAG = '[ImIdentityResolve]'

/**
 * Minimum time between resolution attempts for the same instance, applied
 * after both success and failure. Bounds API calls when a burst of
 * cache-miss messages arrives (e.g. several new contacts at once).
 */
const RETRY_COOLDOWN_MS = 30_000

/**
 * Once a fetch has completed without resolving a specific chatId (it simply
 * wasn't in the directory — e.g. a contact outside the most-recent-20
 * window), don't retry that SAME chatId again until this much time has
 * passed, even though the instance-level cooldown above has expired. This is
 * a separate, longer window: without it, an id that will realistically never
 * appear in the directory (an inactive contact permanently crowded out by
 * more active ones) would still trigger a real network call every ~30s for
 * as long as that contact keeps messaging.
 */
const NOT_FOUND_COOLDOWN_MS = 5 * 60_000

export type IdentityResolutionStatus = 'ok' | 'expired' | 'error'

interface InstanceResolutionState {
  status: IdentityResolutionStatus
  lastCheckedAt: number
}

/** Last known resolution outcome per instance — surfaced via getIdentityResolutionStatus(). */
const stateByInstance = new Map<string, InstanceResolutionState>()
/** In-flight fetch per instance, so concurrent cache misses coalesce into one request. */
const inFlightByInstance = new Map<string, Promise<void>>()
/** Last "fetched but this id wasn't in the directory" timestamp, keyed by "instanceId:appId:channel:chatId". */
const notFoundAt = new Map<string, number>()

// ============================================
// Public API
// ============================================

/**
 * Read the last known identity-resolution outcome for an instance.
 * Used by ImChannelManager.toStatus() to populate
 * ImChannelInstanceStatus.identityResolution. Channel-agnostic — keyed
 * purely by instanceId, no knowledge of which provider owns it.
 *
 * Returns undefined when no attempt has been made yet (the manager treats
 * that as 'pending' when the instance exposes the capability at all,
 * distinguishing "never tried" from "tried and failed").
 */
export function getIdentityResolutionStatus(instanceId: string): InstanceResolutionState | undefined {
  return stateByInstance.get(instanceId)
}

/**
 * Drop all tracked state for an instance: outcome status, in-flight fetch
 * bookkeeping, and per-chatId not-found cooldowns. Called when an instance
 * is genuinely removed from config (not on a mere disable/reconnect, which
 * should keep showing the last known status) and when the member supplies a
 * fresh credential (so a stale 'expired' status doesn't linger past the fix).
 */
export function clearIdentityResolutionStatus(instanceId: string): void {
  stateByInstance.delete(instanceId)
  inFlightByInstance.delete(instanceId)
  const prefix = `${instanceId}:`
  for (const key of notFoundAt.keys()) {
    if (key.startsWith(prefix)) notFoundAt.delete(key)
  }
}

/**
 * Best-effort: resolve `chatId`'s real name for `appId`/`channel`, via the
 * caller-supplied identityCapability (looked up from the live instance —
 * see this module's header comment for why the caller does that lookup
 * rather than this module doing it).
 *
 * No-ops silently when:
 *   - the session registry isn't initialized yet
 *   - resolvedName is already set for this session
 *   - this specific chatId was fetched-but-not-found recently (see NOT_FOUND_COOLDOWN_MS)
 *   - a fetch for this instance is already in flight (coalesced into it)
 *   - the instance's last attempt was within the retry cooldown
 *
 * On success, backfills resolvedName for every directory entry that has a
 * matching local session record, and fires a single `app:im-session-updated`
 * notification (not one per entry) so open session lists refresh.
 *
 * Callers should not block a user-facing turn on this — it makes a real
 * network call with no hard timeout. dispatch-inbound fires it without
 * awaiting so a slow/unreachable directory never stalls a reply; the fetch
 * still completes in the background and benefits this sender's next message.
 */
export async function resolveInboundIdentity(
  instanceId: string,
  appId: string,
  channel: string,
  chatId: string,
  capability: ImIdentityCapability,
): Promise<void> {
  const registry = getImSessionRegistry()
  if (!registry) return

  const existing = registry.findSession(appId, channel, chatId)
  if (existing?.resolvedName) return

  const notFoundKey = `${instanceId}:${appId}:${channel}:${chatId}`
  const lastNotFound = notFoundAt.get(notFoundKey)
  if (lastNotFound && Date.now() - lastNotFound < NOT_FOUND_COOLDOWN_MS) {
    return
  }

  const inFlight = inFlightByInstance.get(instanceId)
  if (inFlight) {
    await inFlight
    return
  }

  const state = stateByInstance.get(instanceId)
  if (state && Date.now() - state.lastCheckedAt < RETRY_COOLDOWN_MS) {
    return
  }

  const attempt = performResolution(instanceId, appId, channel, chatId, capability, registry)
  inFlightByInstance.set(instanceId, attempt)
  try {
    await attempt
  } finally {
    inFlightByInstance.delete(instanceId)
  }
}

// ============================================
// Internal
// ============================================

async function performResolution(
  instanceId: string,
  appId: string,
  channel: string,
  requestedChatId: string,
  capability: ImIdentityCapability,
  registry: ImSessionRegistry,
): Promise<void> {
  const now = Date.now()
  try {
    const directory = await capability.fetchIdentityDirectory()
    stateByInstance.set(instanceId, { status: 'ok', lastCheckedAt: now })

    const updatedChatIds: string[] = []
    for (const [dirChatId, name] of directory) {
      if (registry.setResolvedName(appId, channel, dirChatId, name)) {
        updatedChatIds.push(dirChatId)
      }
    }

    // Always log the outcome, even a zero-match fetch — "called the API and
    // matched nothing" must stay distinguishable in the logs from "didn't
    // call at all", or a systemic mismatch (e.g. the directory's chatId
    // scheme drifting from the registry's) would silently look identical to
    // the normal quiet state.
    console.log(
      `${LOG_TAG} Fetch complete: instanceId=${instanceId}, directorySize=${directory.size}, ` +
      `matched=${updatedChatIds.length}`
    )

    if (!directory.has(requestedChatId)) {
      notFoundAt.set(`${instanceId}:${appId}:${channel}:${requestedChatId}`, now)
    } else {
      notFoundAt.delete(`${instanceId}:${appId}:${channel}:${requestedChatId}`)
    }

    if (updatedChatIds.length === 0) return

    // One event for the whole batch, not one per resolved id — a listener
    // reacting to this (e.g. ImSessionPanel) re-fetches its full session
    // list per event, so firing per-id would mean up to 20 redundant
    // full-list refetches for a single directory fetch.
    const payload = { appId, channel, instanceId }
    sendToRenderer('app:im-session-updated', payload)
    broadcastToAll('app:im-session-updated', payload)
  } catch (err) {
    const status: IdentityResolutionStatus =
      err instanceof ImIdentityAuthExpiredError ? 'expired' : 'error'
    stateByInstance.set(instanceId, { status, lastCheckedAt: now })
    console.error(`${LOG_TAG} Resolution failed: instanceId=${instanceId}, status=${status}`, err)
  }
}
