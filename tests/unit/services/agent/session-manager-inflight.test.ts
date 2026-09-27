/**
 * getOrCreateV2Session in-flight sharing vs. SessionGates.requireFreshInputs.
 *
 * The in-flight map exists so a warm-up racing the first send does not spawn
 * two CC processes for one conversation. But sharing happens BEFORE any
 * fingerprint/gate check, so a gated caller (delegated turn: the options ARE
 * the restriction) could be handed a creation built on somebody else's
 * permissions. The rule under test: a gated latecomer shares only when the
 * creation in flight was invoked with matching inputs; otherwise it waits the
 * creation out and re-evaluates against the finished session, where the
 * existing stale check rebuilds on its own options. Non-gated callers keep the
 * old behavior unchanged.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false }
}))
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession,
  getActiveEngine: vi.fn(() => 'claude'),
}))
vi.mock('../../../../src/main/services/agent/session-consumer', () => ({ startConsumer: vi.fn() }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applySessionReasoningEffort: vi.fn() }))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({
  resolveConversationKnowledgeBases: vi.fn(() => []),
  resolveConversationKnowledgeBaseIds: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({
  setSessionInvalidator: vi.fn(),
  buildCreationTimeServers: vi.fn(() => ({})),
}))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: vi.fn(() => '') }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({
  dropConversationState: vi.fn(),
  getOpenToolsets: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_TOOLSET_ID: 'halo-api-ref' }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation: vi.fn(() => null) }))
vi.mock('../../../../src/main/services/health', () => ({
  registerProcess: vi.fn(),
  unregisterProcess: vi.fn(),
  getCurrentInstanceId: vi.fn(() => null),
}))

import {
  getOrCreateV2Session,
  closeAllV2Sessions,
  stopSessionCleanup,
} from '../../../../src/main/services/agent/session-manager'

/** A session whose transport reads ready, so the reuse path exercises the fingerprint check. */
function fakeSession(label: string) {
  return {
    label,
    query: { transport: { isReady: () => true, onExit: () => () => {} } },
    close: vi.fn(),
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  closeAllV2Sessions()
  createSession.mockReset()
})

afterAll(() => {
  stopSessionCleanup()
})

describe('getOrCreateV2Session in-flight sharing', () => {
  it('a gated latecomer with DIFFERENT inputs does not share: it waits, then rebuilds on its own options', async () => {
    const conv = 'conv-gate-mismatch'
    const s1 = fakeSession('s1')
    const s2 = fakeSession('s2')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(s2)

    const creator = getOrCreateV2Session('space', conv, { systemPrompt: 'creator prompt', model: 'm' })
    await flush()
    expect(createSession).toHaveBeenCalledTimes(1)

    let settled = false
    const latecomer = getOrCreateV2Session(
      'space', conv, { systemPrompt: 'delegated prompt', model: 'm', permissionMode: 'default' },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { requireFreshInputs: true }
    ).then((s) => { settled = true; return s })

    // Not shared and not started: the latecomer is waiting the creation out.
    await flush()
    expect(settled).toBe(false)
    expect(createSession).toHaveBeenCalledTimes(1)

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    // Re-entry lands on the finished session, whose inputs fingerprint does not
    // match → the existing stale path rebuilds with the latecomer's options.
    await expect(latecomer).resolves.toBe(s2)
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(createSession.mock.calls[1][0].systemPrompt).toBe('delegated prompt')
    expect(s1.close).toHaveBeenCalled()
  })

  it('a gated latecomer with MATCHING inputs shares the creation in flight', async () => {
    const conv = 'conv-gate-match'
    const s1 = fakeSession('s1')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise)

    const options = { systemPrompt: 'same prompt', model: 'm', permissionMode: 'default' }
    const creator = getOrCreateV2Session('space', conv, { ...options })
    await flush()
    const latecomer = getOrCreateV2Session(
      'space', conv, { ...options },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { requireFreshInputs: true }
    )

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    await expect(latecomer).resolves.toBe(s1)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('a NON-gated latecomer shares even when its options differ (pre-existing behavior)', async () => {
    const conv = 'conv-ungated'
    const s1 = fakeSession('s1')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise)

    const creator = getOrCreateV2Session('space', conv, { systemPrompt: 'A', model: 'm' })
    await flush()
    const latecomer = getOrCreateV2Session('space', conv, { systemPrompt: 'B', model: 'm' })

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    await expect(latecomer).resolves.toBe(s1)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('a gated latecomer never shares a lazy-MCP creation (its inputs cannot be verified)', async () => {
    const conv = 'conv-lazy'
    const s1 = fakeSession('s1')
    const s2 = fakeSession('s2')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(s2)

    const options = { systemPrompt: 'same prompt', model: 'm' }
    // Main-chat style creation: MCP servers built lazily → no eager fingerprint.
    const creator = getOrCreateV2Session(
      'space', conv, { ...options },
      undefined, undefined, undefined, undefined,
      () => ({})
    )
    await flush()
    const latecomer = getOrCreateV2Session(
      'space', conv, { ...options },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { requireFreshInputs: true }
    )

    await flush()
    expect(createSession).toHaveBeenCalledTimes(1)

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    // The finished session carries no inputs fingerprint either → stale path rebuilds.
    await expect(latecomer).resolves.toBe(s2)
    expect(createSession).toHaveBeenCalledTimes(2)
  })
})
