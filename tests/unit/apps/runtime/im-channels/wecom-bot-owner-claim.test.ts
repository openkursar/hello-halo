/**
 * Unit tests for apps/runtime/im-channels/wecom-bot-owner-claim.
 *
 * Validates the one-shot owner auto-claim contract used by the WeCom
 * Intelligent Bot scan-auth onboarding flow:
 *
 *   1. Happy path: pending instance → owners bound, flag cleared, manager
 *      refreshed, IM sessions invalidated, renderer + WS broadcast fired.
 *   2. Idempotency: re-entry after claim is a no-op (concurrent inbound safe)
 *   3. Scope guards: non-wecom-bot types, missing instance, missing sender id
 *   4. Resilience: persistence failure surfaces as `false` without throwing
 *   5. Side-effect failures (manager refresh / invalidate / broadcast) do NOT
 *      roll back the persisted claim — they are best-effort by design.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Hoisted mocks — vi.mock is hoisted above imports, so the factories must not
// close over module-scope variables that aren't themselves hoisted.
const configState: { current: { imChannels?: { instances: any[] } } } = {
  current: { imChannels: { instances: [] } },
}
const saveConfigMock = vi.fn((patch: any) => {
  configState.current = { ...configState.current, ...patch }
})
const getConfigMock = vi.fn(() => configState.current)

vi.mock('../../../../../src/main/foundation/config.service', () => ({
  getConfig: () => getConfigMock(),
  saveConfig: (patch: any) => saveConfigMock(patch),
}))

const applyConfigMock = vi.fn()
const fakeManager = { applyConfig: applyConfigMock }
vi.mock('../../../../../src/main/apps/runtime/im-channels/index', () => ({
  getActiveImChannelManager: () => fakeManager,
}))

vi.mock('../../../../../src/main/apps/runtime/dispatch-inbound', () => ({
  dispatchInboundMessage: vi.fn(),
}))

const invalidateImSessionsMock = vi.fn()
vi.mock('../../../../../src/main/services/agent/session-manager', () => ({
  invalidateImSessions: () => invalidateImSessionsMock(),
}))

const sendToRendererMock = vi.fn()
vi.mock('../../../../../src/main/foundation/window.service', () => ({
  sendToRenderer: (channel: string, data: unknown) => sendToRendererMock(channel, data),
}))

const broadcastToAllMock = vi.fn()
vi.mock('../../../../../src/main/http/websocket', () => ({
  broadcastToAll: (channel: string, data: unknown) => broadcastToAllMock(channel, data),
}))

import { maybeClaimOwner } from '../../../../../src/main/apps/runtime/im-channels/wecom-bot-owner-claim'

// ============================================
// Helpers
// ============================================

function setInstances(instances: any[]): void {
  configState.current = { imChannels: { instances } }
}

function wecomInstance(overrides: Partial<any> = {}): any {
  return {
    id: 'inst-1',
    type: 'wecom-bot',
    enabled: true,
    appId: 'app-1',
    config: { botId: 'bot-abc', secret: 's3cr3t', wsUrl: '' },
    permissionEnabled: true,
    pendingOwnerClaim: true,
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

beforeEach(() => {
  saveConfigMock.mockClear()
  applyConfigMock.mockClear()
  getConfigMock.mockClear()
  invalidateImSessionsMock.mockClear()
  sendToRendererMock.mockClear()
  broadcastToAllMock.mockClear()
  configState.current = { imChannels: { instances: [] } }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('maybeClaimOwner — happy path', () => {
  it('binds the sender as the sole owner and clears the pending flag', async () => {
    setInstances([wecomInstance()])

    const result = await maybeClaimOwner('inst-1', 'user-zhangsan')

    expect(result).toBe(true)
    expect(saveConfigMock).toHaveBeenCalledTimes(1)
    const persisted = saveConfigMock.mock.calls[0][0].imChannels.instances[0]
    expect(persisted.owners).toEqual(['user-zhangsan'])
    expect(persisted.pendingOwnerClaim).toBe(false)
  })

  it('replaces (not appends to) any existing owners list', async () => {
    setInstances([wecomInstance({ owners: ['stale-owner'] })])

    await maybeClaimOwner('inst-1', 'new-owner')

    const persisted = saveConfigMock.mock.calls[0][0].imChannels.instances[0]
    expect(persisted.owners).toEqual(['new-owner'])
  })

  it('refreshes the manager snapshot after persisting', async () => {
    setInstances([wecomInstance()])

    await maybeClaimOwner('inst-1', 'user-1')

    expect(applyConfigMock).toHaveBeenCalledTimes(1)
    const passed = applyConfigMock.mock.calls[0][0]
    expect(passed[0].owners).toEqual(['user-1'])
    expect(passed[0].pendingOwnerClaim).toBe(false)
  })

  it('preserves all unrelated instances unchanged', async () => {
    const other = wecomInstance({ id: 'inst-2', pendingOwnerClaim: false, owners: ['keep-me'] })
    setInstances([wecomInstance(), other])

    await maybeClaimOwner('inst-1', 'user-1')

    const persisted = saveConfigMock.mock.calls[0][0].imChannels.instances
    expect(persisted).toHaveLength(2)
    expect(persisted.find((i: any) => i.id === 'inst-2')).toEqual(other)
  })

  it('invalidates IM agent sessions after claim (so cached prompts refresh)', async () => {
    setInstances([wecomInstance()])

    await maybeClaimOwner('inst-1', 'user-1')

    expect(invalidateImSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('broadcasts im-channels:instance-updated to renderer and remote clients', async () => {
    setInstances([wecomInstance()])

    await maybeClaimOwner('inst-1', 'user-1')

    expect(sendToRendererMock).toHaveBeenCalledTimes(1)
    expect(sendToRendererMock).toHaveBeenCalledWith(
      'im-channels:instance-updated',
      expect.objectContaining({
        instanceId: 'inst-1',
        instance: expect.objectContaining({
          owners: ['user-1'],
          pendingOwnerClaim: false,
        }),
      }),
    )
    expect(broadcastToAllMock).toHaveBeenCalledTimes(1)
    expect(broadcastToAllMock).toHaveBeenCalledWith(
      'im-channels:instance-updated',
      expect.objectContaining({ instanceId: 'inst-1' }),
    )
  })
})

describe('maybeClaimOwner — idempotency', () => {
  it('returns false when the flag is already cleared (concurrent inbound)', async () => {
    setInstances([wecomInstance({ pendingOwnerClaim: false, owners: ['existing'] })])

    const result = await maybeClaimOwner('inst-1', 'someone-else')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
    expect(applyConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when the flag is undefined (manual-config instance)', async () => {
    setInstances([wecomInstance({ pendingOwnerClaim: undefined })])

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })
})

describe('maybeClaimOwner — scope guards', () => {
  it('returns false for non-wecom-bot instance types', async () => {
    setInstances([
      wecomInstance({ type: 'feishu-bot' }),
    ])

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when the instance does not exist', async () => {
    setInstances([wecomInstance({ id: 'other' })])

    const result = await maybeClaimOwner('missing', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when the sender id is empty', async () => {
    setInstances([wecomInstance()])

    const result = await maybeClaimOwner('inst-1', '')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when the instance id is empty', async () => {
    setInstances([wecomInstance()])

    const result = await maybeClaimOwner('', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })
})

describe('maybeClaimOwner — resilience', () => {
  it('returns false when saveConfig throws and does not refresh the manager', async () => {
    setInstances([wecomInstance()])
    saveConfigMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(applyConfigMock).not.toHaveBeenCalled()
  })

  it('returns true even when manager.applyConfig throws (persistence already succeeded)', async () => {
    setInstances([wecomInstance()])
    applyConfigMock.mockImplementationOnce(() => {
      throw new Error('manager exploded')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(true)
    expect(saveConfigMock).toHaveBeenCalledTimes(1)
  })

  it('returns true even when invalidateImSessions throws (best-effort)', async () => {
    setInstances([wecomInstance()])
    invalidateImSessionsMock.mockImplementationOnce(() => {
      throw new Error('session manager unavailable')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(true)
    // Broadcast still fires even when invalidateImSessions throws.
    expect(sendToRendererMock).toHaveBeenCalledTimes(1)
  })

  it('returns true even when the renderer broadcast throws (best-effort)', async () => {
    setInstances([wecomInstance()])
    sendToRendererMock.mockImplementationOnce(() => {
      throw new Error('window destroyed')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(true)
    expect(saveConfigMock).toHaveBeenCalledTimes(1)
  })

  it('skips broadcast + invalidate when persistence fails', async () => {
    setInstances([wecomInstance()])
    saveConfigMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(applyConfigMock).not.toHaveBeenCalled()
    expect(invalidateImSessionsMock).not.toHaveBeenCalled()
    expect(sendToRendererMock).not.toHaveBeenCalled()
    expect(broadcastToAllMock).not.toHaveBeenCalled()
  })
})
