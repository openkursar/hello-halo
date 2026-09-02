/**
 * Unit tests for apps/runtime/im-channels/identity-resolve.
 *
 * Validates the channel-agnostic identity resolution contract:
 *
 *   1. No-op paths: registry uninitialized, already resolved, in-flight
 *      coalescing, per-instance retry cooldown, per-chatId not-found cooldown.
 *   2. Happy path: fetch succeeds -> backfills every returned id that has a
 *      local session record (not just the requested one), fires a SINGLE
 *      batched update event (not one per backfilled session), records
 *      status 'ok'.
 *   3. Failure classification: ImIdentityAuthExpiredError -> 'expired',
 *      any other error -> 'error'.
 *   4. getIdentityResolutionStatus / clearIdentityResolutionStatus, the
 *      latter also resetting the per-chatId not-found cooldown.
 *
 * The capability is passed directly into resolveInboundIdentity() by the
 * caller (this module no longer looks it up via the ImChannelManager
 * accessor — see the module header comment for why), so these tests don't
 * need to mock im-channels/index at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ImIdentityAuthExpiredError } from '../../../../../src/shared/types/im-channel'

// Hoisted mocks — vi.mock is hoisted above imports, so the factories must not
// close over module-scope variables that aren't themselves hoisted.
const sendToRendererMock = vi.fn()
vi.mock('../../../../../src/main/foundation/window.service', () => ({
  sendToRenderer: (channel: string, data: unknown) => sendToRendererMock(channel, data),
}))

const broadcastToAllMock = vi.fn()
vi.mock('../../../../../src/main/http/websocket', () => ({
  broadcastToAll: (channel: string, data: unknown) => broadcastToAllMock(channel, data),
}))

const registryState: { current: unknown } = { current: null }
vi.mock('../../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => registryState.current,
}))

import {
  resolveInboundIdentity,
  getIdentityResolutionStatus,
  clearIdentityResolutionStatus,
} from '../../../../../src/main/apps/runtime/im-channels/identity-resolve'

// ============================================
// Fakes
// ============================================

interface FakeSession {
  chatType: 'direct' | 'group'
  resolvedName?: string
}

class FakeRegistry {
  private sessions = new Map<string, FakeSession>()

  seed(chatId: string, session: FakeSession): void {
    this.sessions.set(chatId, session)
  }

  findSession(_appId: string, _channel: string, chatId: string): FakeSession | undefined {
    const s = this.sessions.get(chatId)
    return s ? { ...s } : undefined
  }

  setResolvedName(_appId: string, _channel: string, chatId: string, name: string): boolean {
    const s = this.sessions.get(chatId)
    if (!s) return false
    if (s.resolvedName === name) return false
    s.resolvedName = name
    return true
  }
}

function capabilityReturning(fetchIdentityDirectory: () => Promise<Map<string, string>>) {
  return { fetchIdentityDirectory }
}

const INSTANCE_ID = 'inst-1'
const APP_ID = 'app-1'
const CHANNEL = 'wecom-bot'

// ============================================
// Tests
// ============================================

describe('resolveInboundIdentity', () => {
  beforeEach(() => {
    sendToRendererMock.mockClear()
    broadcastToAllMock.mockClear()
    registryState.current = null
    clearIdentityResolutionStatus(INSTANCE_ID)
  })

  it('no-ops when the registry is not initialized', async () => {
    registryState.current = null
    const fetchFn = vi.fn(async () => new Map())
    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capabilityReturning(fetchFn))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('no-ops when resolvedName is already set (cache hit, zero network calls)', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct', resolvedName: 'Already Known' })
    registryState.current = registry
    const fetchFn = vi.fn(async () => new Map())

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capabilityReturning(fetchFn))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('backfills every directory entry with a matching local session, not just the requested id', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registry.seed('chat-2', { chatType: 'direct' })
    // chat-3 is in the directory but has no local session — must be skipped.
    registryState.current = registry
    const capability = capabilityReturning(async () => new Map([
      ['chat-1', 'Alice'],
      ['chat-2', 'Bob'],
      ['chat-3', 'Carol'],
    ]))

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)

    expect(registry.findSession(APP_ID, CHANNEL, 'chat-1')?.resolvedName).toBe('Alice')
    expect(registry.findSession(APP_ID, CHANNEL, 'chat-2')?.resolvedName).toBe('Bob')
    expect(getIdentityResolutionStatus(INSTANCE_ID)?.status).toBe('ok')
  })

  it('fires a single batched update event, not one per resolved id', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registry.seed('chat-2', { chatType: 'direct' })
    registryState.current = registry
    const capability = capabilityReturning(async () => new Map([
      ['chat-1', 'Alice'],
      ['chat-2', 'Bob'],
    ]))

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)

    // Two sessions were resolved by this one fetch, but consumers (e.g.
    // ImSessionPanel) re-fetch their whole list per event — one event for
    // the batch avoids N redundant full-list refetches.
    expect(broadcastToAllMock).toHaveBeenCalledTimes(1)
    expect(sendToRendererMock).toHaveBeenCalledTimes(1)
  })

  it('fires no event when the fetch succeeds but resolves nothing new', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registryState.current = registry
    // Directory doesn't include chat-1 at all.
    const capability = capabilityReturning(async () => new Map([['chat-9', 'Someone Else']]))

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)

    expect(broadcastToAllMock).not.toHaveBeenCalled()
    expect(sendToRendererMock).not.toHaveBeenCalled()
    // Still a real, observable outcome — not indistinguishable from "never called".
    expect(getIdentityResolutionStatus(INSTANCE_ID)?.status).toBe('ok')
  })

  it('coalesces concurrent calls for the same instance into a single fetch', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registry.seed('chat-2', { chatType: 'direct' })
    registryState.current = registry

    let resolveFetch!: (v: Map<string, string>) => void
    const fetchFn = vi.fn(() => new Promise<Map<string, string>>((resolve) => { resolveFetch = resolve }))
    const capability = capabilityReturning(fetchFn)

    const p1 = resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    const p2 = resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-2', capability)
    resolveFetch(new Map([['chat-1', 'Alice']]))
    await Promise.all([p1, p2])

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('classifies ImIdentityAuthExpiredError as status=expired', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registryState.current = registry
    const capability = capabilityReturning(async () => { throw new ImIdentityAuthExpiredError() })

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    expect(getIdentityResolutionStatus(INSTANCE_ID)?.status).toBe('expired')
  })

  it('classifies any other error as status=error', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registryState.current = registry
    const capability = capabilityReturning(async () => { throw new Error('network down') })

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    expect(getIdentityResolutionStatus(INSTANCE_ID)?.status).toBe('error')
  })

  it('respects the retry cooldown after a failed attempt (no immediate re-fetch)', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registry.seed('chat-2', { chatType: 'direct' })
    registryState.current = registry
    const fetchFn = vi.fn(async () => { throw new Error('network down') })
    const capability = capabilityReturning(fetchFn)

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // A different (still-unresolved) chatId on the same instance should not
    // trigger a second fetch within the cooldown window.
    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-2', capability)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not re-fetch a specific chatId that was already confirmed absent from the directory', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registry.seed('chat-2', { chatType: 'direct' })
    registryState.current = registry

    let calls = 0
    const capability = capabilityReturning(async () => {
      calls++
      // chat-1 is never in the directory (e.g. permanently outside the
      // most-recent-20 window); chat-2 resolves on the second attempt.
      return calls === 1 ? new Map() : new Map([['chat-2', 'Bob']])
    })

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    expect(calls).toBe(1)
    expect(getIdentityResolutionStatus(INSTANCE_ID)).toBeDefined()

    // Force past the instance-level retry cooldown so only the per-chatId
    // not-found cooldown is under test.
    const state = getIdentityResolutionStatus(INSTANCE_ID)!
    state.lastCheckedAt = Date.now() - 31_000

    // Same chatId (chat-1): still within its own not-found cooldown, skip.
    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    expect(calls).toBe(1)

    // A different, never-before-tried chatId (chat-2) on the same instance
    // is unaffected by chat-1's not-found cooldown.
    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-2', capability)
    expect(calls).toBe(2)
    expect(registry.findSession(APP_ID, CHANNEL, 'chat-2')?.resolvedName).toBe('Bob')
  })

  it('clearIdentityResolutionStatus drops tracked state and the not-found cooldown for the instance', async () => {
    const registry = new FakeRegistry()
    registry.seed('chat-1', { chatType: 'direct' })
    registryState.current = registry
    let calls = 0
    const capability = capabilityReturning(async () => { calls++; return new Map() })

    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    expect(getIdentityResolutionStatus(INSTANCE_ID)).toBeDefined()
    expect(calls).toBe(1)

    clearIdentityResolutionStatus(INSTANCE_ID)
    expect(getIdentityResolutionStatus(INSTANCE_ID)).toBeUndefined()

    // Not-found cooldown for chat-1 was cleared too, so this retries immediately.
    await resolveInboundIdentity(INSTANCE_ID, APP_ID, CHANNEL, 'chat-1', capability)
    expect(calls).toBe(2)
  })
})
