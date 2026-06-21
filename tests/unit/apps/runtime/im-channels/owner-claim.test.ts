/**
 * Unit tests for apps/runtime/im-channels/owner-claim.
 *
 * Validates the channel-agnostic owner auto-claim contract:
 *
 *   1. Happy path: permission-enabled instance with empty owners → sender
 *      bound as sole owner, manager refreshed, IM sessions invalidated,
 *      renderer + WS broadcast fired.
 *   2. Claim condition: permission control off or owners already set → no-op.
 *   3. Channel-agnostic: claims for any instance type, not just wecom-bot.
 *   4. Scope guards: missing instance, empty ids.
 *   5. Resilience: persistence failure surfaces as `false` without throwing;
 *      side-effect failures (manager refresh / invalidate / broadcast) do NOT
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

const updateSnapshotMock = vi.fn(() => true)
const fakeManager = { updateInstanceConfigSnapshot: updateSnapshotMock }
vi.mock('../../../../../src/main/apps/runtime/im-channels/index', () => ({
  getActiveImChannelManager: () => fakeManager,
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

import { maybeClaimOwner } from '../../../../../src/main/apps/runtime/im-channels/owner-claim'

// ============================================
// Helpers
// ============================================

function setInstances(instances: any[]): void {
  configState.current = { imChannels: { instances } }
}

function instanceCfg(overrides: Partial<any> = {}): any {
  return {
    id: 'inst-1',
    type: 'wecom-bot',
    enabled: true,
    appId: 'app-1',
    config: { botId: 'bot-abc', secret: 's3cr3t', wsUrl: '' },
    permissionEnabled: true,
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

beforeEach(() => {
  saveConfigMock.mockClear()
  updateSnapshotMock.mockClear()
  updateSnapshotMock.mockImplementation(() => true)
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
  it('binds the sender as the sole owner', async () => {
    setInstances([instanceCfg()])

    const result = await maybeClaimOwner('inst-1', 'user-zhangsan')

    expect(result).toBe(true)
    expect(saveConfigMock).toHaveBeenCalledTimes(1)
    const persisted = saveConfigMock.mock.calls[0][0].imChannels.instances[0]
    expect(persisted.owners).toEqual(['user-zhangsan'])
  })

  it('claims when owners is an empty array', async () => {
    setInstances([instanceCfg({ owners: [] })])

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(true)
    const persisted = saveConfigMock.mock.calls[0][0].imChannels.instances[0]
    expect(persisted.owners).toEqual(['user-1'])
  })

  it('refreshes the manager snapshot after persisting', async () => {
    setInstances([instanceCfg()])

    await maybeClaimOwner('inst-1', 'user-1')

    expect(updateSnapshotMock).toHaveBeenCalledTimes(1)
    const passed = updateSnapshotMock.mock.calls[0][0]
    expect(passed.owners).toEqual(['user-1'])
  })

  it('preserves all unrelated instances unchanged', async () => {
    const other = instanceCfg({ id: 'inst-2', owners: ['keep-me'] })
    setInstances([instanceCfg(), other])

    await maybeClaimOwner('inst-1', 'user-1')

    const persisted = saveConfigMock.mock.calls[0][0].imChannels.instances
    expect(persisted).toHaveLength(2)
    expect(persisted.find((i: any) => i.id === 'inst-2')).toEqual(other)
  })

  it('invalidates IM agent sessions after claim (so cached permission context refreshes)', async () => {
    setInstances([instanceCfg()])

    await maybeClaimOwner('inst-1', 'user-1')

    expect(invalidateImSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('broadcasts im-channels:instance-updated to renderer and remote clients', async () => {
    setInstances([instanceCfg()])

    await maybeClaimOwner('inst-1', 'user-1')

    expect(sendToRendererMock).toHaveBeenCalledTimes(1)
    expect(sendToRendererMock).toHaveBeenCalledWith(
      'im-channels:instance-updated',
      expect.objectContaining({
        instanceId: 'inst-1',
        instance: expect.objectContaining({ owners: ['user-1'] }),
      }),
    )
    expect(broadcastToAllMock).toHaveBeenCalledTimes(1)
    expect(broadcastToAllMock).toHaveBeenCalledWith(
      'im-channels:instance-updated',
      expect.objectContaining({ instanceId: 'inst-1' }),
    )
  })

  it('claims for non-wecom instance types (channel-agnostic)', async () => {
    setInstances([instanceCfg({ type: 'feishu-bot' })])

    const result = await maybeClaimOwner('inst-1', 'open-id-1')

    expect(result).toBe(true)
    const persisted = saveConfigMock.mock.calls[0][0].imChannels.instances[0]
    expect(persisted.owners).toEqual(['open-id-1'])
  })
})

describe('maybeClaimOwner — claim condition', () => {
  it('returns false when permission control is disabled', async () => {
    setInstances([instanceCfg({ permissionEnabled: false })])

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when permissionEnabled is undefined', async () => {
    setInstances([instanceCfg({ permissionEnabled: undefined })])

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when owners are already set (idempotent under concurrent inbound)', async () => {
    setInstances([instanceCfg({ owners: ['existing'] })])

    const result = await maybeClaimOwner('inst-1', 'someone-else')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
    expect(updateSnapshotMock).not.toHaveBeenCalled()
  })
})

describe('maybeClaimOwner — scope guards', () => {
  it('returns false when the instance does not exist', async () => {
    setInstances([instanceCfg({ id: 'other' })])

    const result = await maybeClaimOwner('missing', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when the sender id is empty', async () => {
    setInstances([instanceCfg()])

    const result = await maybeClaimOwner('inst-1', '')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })

  it('returns false when the instance id is empty', async () => {
    setInstances([instanceCfg()])

    const result = await maybeClaimOwner('', 'user-1')

    expect(result).toBe(false)
    expect(saveConfigMock).not.toHaveBeenCalled()
  })
})

describe('maybeClaimOwner — resilience', () => {
  it('returns false when saveConfig throws and does not refresh the manager', async () => {
    setInstances([instanceCfg()])
    saveConfigMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(updateSnapshotMock).not.toHaveBeenCalled()
  })

  it('returns true even when the snapshot refresh reports a miss (persistence already succeeded)', async () => {
    setInstances([instanceCfg()])
    updateSnapshotMock.mockImplementationOnce(() => false)

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(true)
    expect(saveConfigMock).toHaveBeenCalledTimes(1)
    // Best-effort side effects still fire.
    expect(invalidateImSessionsMock).toHaveBeenCalledTimes(1)
    expect(sendToRendererMock).toHaveBeenCalledTimes(1)
  })

  it('returns true even when invalidateImSessions throws (best-effort)', async () => {
    setInstances([instanceCfg()])
    invalidateImSessionsMock.mockImplementationOnce(() => {
      throw new Error('session manager unavailable')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(true)
    // Broadcast still fires even when invalidateImSessions throws.
    expect(sendToRendererMock).toHaveBeenCalledTimes(1)
  })

  it('returns true even when the renderer broadcast throws (best-effort)', async () => {
    setInstances([instanceCfg()])
    sendToRendererMock.mockImplementationOnce(() => {
      throw new Error('window destroyed')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(true)
    expect(saveConfigMock).toHaveBeenCalledTimes(1)
  })

  it('skips broadcast + invalidate when persistence fails', async () => {
    setInstances([instanceCfg()])
    saveConfigMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    const result = await maybeClaimOwner('inst-1', 'user-1')

    expect(result).toBe(false)
    expect(updateSnapshotMock).not.toHaveBeenCalled()
    expect(invalidateImSessionsMock).not.toHaveBeenCalled()
    expect(sendToRendererMock).not.toHaveBeenCalled()
    expect(broadcastToAllMock).not.toHaveBeenCalled()
  })
})
