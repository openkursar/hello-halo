/**
 * Unit tests for apps/runtime/im-channels/manager (ImChannelManager).
 *
 * The manager is the generic, provider-agnostic lifecycle engine. These tests
 * pin the contracts other layers depend on, using fake providers/instances only
 * (no real WeCom/Feishu code, no network):
 *
 *   1. applyConfig diff engine: new → create+start, removed → stop+delete,
 *      changed → stop old + create new, unchanged → no-op.
 *   2. configEqual reacts to config JSON but ignores streaming/replyScope.
 *   3. statusReasons: set on missing provider / validateConfig failure /
 *      createInstance throw; cleared on success.
 *   4. toStatus derivation, including the disconnected+enabled → 'connecting'
 *      fallback and getConnectionState() precedence.
 *   5. stopInstance swallows onInstanceStop handler errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ImChannelManager } from '../../../../../src/main/apps/runtime/im-channels/manager'
import * as identityResolve from '../../../../../src/main/apps/runtime/im-channels/identity-resolve'
import type {
  ImChannelProvider,
  ImChannelInstance,
  ImChannelInstanceConfig,
  ImConnectionState,
  ImIdentityCapability,
} from '../../../../../src/shared/types/im-channel'

// ============================================
// Test fakes
// ============================================

interface FakeInstance extends ImChannelInstance {
  started: boolean
  stopped: boolean
  reconnected: boolean
  connectedFlag: boolean
  connectionState?: ImConnectionState
  inboundHandler: ((msg: any, reply: any) => void) | null
  updateConfigCalls: Record<string, unknown>[]
}

function makeInstance(
  instanceId: string,
  overrides: Partial<FakeInstance> = {},
): FakeInstance {
  const inst: FakeInstance = {
    instanceId,
    providerType: 'wecom-bot',
    started: false,
    stopped: false,
    reconnected: false,
    connectedFlag: true,
    connectionState: undefined,
    inboundHandler: null,
    updateConfigCalls: [],
    start() {
      inst.started = true
    },
    stop() {
      inst.stopped = true
    },
    reconnect() {
      inst.reconnected = true
    },
    isConnected() {
      return inst.connectedFlag
    },
    getConnectionState() {
      return inst.connectionState ?? (inst.connectedFlag ? 'online' : 'offline')
    },
    pushToChat() {
      return true
    },
    onInbound(handler) {
      inst.inboundHandler = handler
    },
    updateConfig(config) {
      inst.updateConfigCalls.push(config)
    },
    ...overrides,
  }
  return inst
}

interface FakeProvider extends ImChannelProvider {
  created: FakeInstance[]
  validationError: string | null
  throwOnCreate: Error | null
  nextInstanceOverrides: Partial<FakeInstance>
}

function makeProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  const p: FakeProvider = {
    type: 'wecom-bot',
    displayName: 'Fake WeCom',
    description: 'test provider',
    direction: 'bidirectional',
    configFields: [],
    defaultConfig: {},
    created: [],
    validationError: null,
    throwOnCreate: null,
    nextInstanceOverrides: {},
    validateConfig() {
      return p.validationError
    },
    createInstance(instanceId) {
      if (p.throwOnCreate) throw p.throwOnCreate
      const inst = makeInstance(instanceId, p.nextInstanceOverrides)
      p.created.push(inst)
      return inst
    },
    ...overrides,
  }
  return p
}

function makeConfig(
  id: string,
  overrides: Partial<ImChannelInstanceConfig> = {},
): ImChannelInstanceConfig {
  return {
    id,
    type: 'wecom-bot',
    enabled: true,
    appId: 'app-1',
    config: { botId: 'b1' },
    ...overrides,
  }
}

const noopInbound = () => {}

// ============================================
// Tests
// ============================================

describe('ImChannelManager.applyConfig — diff engine', () => {
  let manager: ImChannelManager
  let provider: FakeProvider

  beforeEach(() => {
    manager = new ImChannelManager()
    provider = makeProvider()
    manager.registerProvider(provider)
  })

  it('creates and starts a new enabled instance', () => {
    manager.applyConfig([makeConfig('i1')], noopInbound)
    expect(provider.created).toHaveLength(1)
    expect(provider.created[0].started).toBe(true)
    expect(manager.getInstance('i1')).toBeDefined()
  })

  it('does not create an instance when disabled', () => {
    manager.applyConfig([makeConfig('i1', { enabled: false })], noopInbound)
    expect(provider.created).toHaveLength(0)
    expect(manager.getInstance('i1')).toBeUndefined()
  })

  it('does not create an instance when appId is missing', () => {
    manager.applyConfig([makeConfig('i1', { appId: '' })], noopInbound)
    expect(provider.created).toHaveLength(0)
  })

  it('stops and removes instances no longer present in config', () => {
    manager.applyConfig([makeConfig('i1')], noopInbound)
    const inst = manager.getInstance('i1') as FakeInstance
    manager.applyConfig([], noopInbound)
    expect(inst.stopped).toBe(true)
    expect(manager.getInstance('i1')).toBeUndefined()
  })

  it('leaves an unchanged instance untouched (no recreate)', () => {
    const cfg = makeConfig('i1')
    manager.applyConfig([cfg], noopInbound)
    const first = manager.getInstance('i1')
    manager.applyConfig([makeConfig('i1')], noopInbound)
    // Same object retained; provider only created once.
    expect(manager.getInstance('i1')).toBe(first)
    expect(provider.created).toHaveLength(1)
  })

  it('recreates an instance when the provider config changed', () => {
    manager.applyConfig([makeConfig('i1')], noopInbound)
    const old = manager.getInstance('i1') as FakeInstance
    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b2' } })],
      noopInbound,
    )
    expect(old.stopped).toBe(true)
    expect(provider.created).toHaveLength(2)
    expect(manager.getInstance('i1')).toBe(provider.created[1])
  })

  it('wires the inbound handler with bound instanceId and appId', () => {
    const onInbound = vi.fn()
    manager.applyConfig([makeConfig('i1', { appId: 'app-9' })], onInbound)
    const inst = manager.getInstance('i1') as FakeInstance
    const msg = { text: 'hi' }
    const reply = { kind: 'reply' }
    inst.inboundHandler!(msg, reply)
    expect(onInbound).toHaveBeenCalledWith('i1', 'app-9', msg, reply)
  })
})

describe('ImChannelManager.configEqual (via applyConfig recreate behavior)', () => {
  let manager: ImChannelManager
  let provider: FakeProvider

  beforeEach(() => {
    manager = new ImChannelManager()
    provider = makeProvider()
    manager.registerProvider(provider)
  })

  it('ignores streaming and replyScope changes (no recreate)', () => {
    manager.applyConfig(
      [makeConfig('i1', { streaming: false, replyScope: 'group' })],
      noopInbound,
    )
    const first = manager.getInstance('i1')
    manager.applyConfig(
      [makeConfig('i1', { streaming: true, replyScope: 'all' })],
      noopInbound,
    )
    expect(manager.getInstance('i1')).toBe(first)
    expect(provider.created).toHaveLength(1)
    // Snapshot reflects the new streaming/replyScope for dispatch-time reads.
    const cfg = manager.getInstanceConfig('i1')
    expect(cfg?.streaming).toBe(true)
    expect(cfg?.replyScope).toBe('all')
  })

  it('reacts to enabled toggling by tearing the instance down', () => {
    manager.applyConfig([makeConfig('i1')], noopInbound)
    const inst = manager.getInstance('i1') as FakeInstance
    manager.applyConfig([makeConfig('i1', { enabled: false })], noopInbound)
    expect(inst.stopped).toBe(true)
    expect(manager.getInstance('i1')).toBeUndefined()
  })

  it('reacts to appId change by recreating', () => {
    manager.applyConfig([makeConfig('i1', { appId: 'a' })], noopInbound)
    manager.applyConfig([makeConfig('i1', { appId: 'b' })], noopInbound)
    expect(provider.created).toHaveLength(2)
  })
})

describe('ImChannelManager — statusReasons', () => {
  let manager: ImChannelManager

  beforeEach(() => {
    manager = new ImChannelManager()
  })

  it('sets a reason when no provider is registered for the type', () => {
    manager.applyConfig([makeConfig('i1')], noopInbound)
    const status = manager.getInstanceStatus('i1')
    expect(status?.connected).toBe(false)
    expect(status?.reason).toContain('No provider registered')
  })

  it('sets validateConfig error as the reason', () => {
    const provider = makeProvider({ validationError: 'missing secret' })
    manager.registerProvider(provider)
    manager.applyConfig([makeConfig('i1')], noopInbound)
    expect(manager.getInstanceStatus('i1')?.reason).toBe('missing secret')
    expect(manager.getInstance('i1')).toBeUndefined()
  })

  it('captures a createInstance throw as the reason', () => {
    const provider = makeProvider({ throwOnCreate: new Error('boom') })
    manager.registerProvider(provider)
    manager.applyConfig([makeConfig('i1')], noopInbound)
    expect(manager.getInstanceStatus('i1')?.reason).toBe('boom')
  })

  it('clears the reason on a successful (re)create', () => {
    const provider = makeProvider({ validationError: 'bad' })
    manager.registerProvider(provider)
    manager.applyConfig([makeConfig('i1')], noopInbound)
    expect(manager.getInstanceStatus('i1')?.reason).toBe('bad')

    provider.validationError = null
    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'changed' } })],
      noopInbound,
    )
    expect(manager.getInstanceStatus('i1')?.reason).toBeUndefined()
  })

  it('drops reasons for instances removed from config', () => {
    manager.applyConfig([makeConfig('i1')], noopInbound) // no provider → reason set
    expect(manager.getInstanceStatus('i1')?.reason).toBeTruthy()
    manager.applyConfig([], noopInbound)
    expect(manager.getInstanceStatus('i1')).toBeNull()
  })
})

describe('ImChannelManager.toStatus derivation', () => {
  let manager: ImChannelManager
  let provider: FakeProvider

  beforeEach(() => {
    manager = new ImChannelManager()
    provider = makeProvider()
    manager.registerProvider(provider)
  })

  it('derives connecting for an enabled instance that failed to instantiate', () => {
    // No provider registered path: enabled but no instance → connecting.
    const bare = new ImChannelManager()
    bare.applyConfig([makeConfig('i1')], noopInbound)
    const status = bare.getInstanceStatus('i1')
    expect(status?.connected).toBe(false)
    expect(status?.state).toBe('connecting')
  })

  it('derives offline for a disabled instance with no live instance', () => {
    manager.applyConfig([makeConfig('i1', { enabled: false })], noopInbound)
    const status = manager.getInstanceStatus('i1')
    expect(status?.state).toBe('offline')
  })

  it('reports online + connected for a live connected instance', () => {
    manager.applyConfig([makeConfig('i1')], noopInbound)
    const status = manager.getInstanceStatus('i1')
    expect(status?.connected).toBe(true)
    expect(status?.state).toBe('online')
  })

  it('prefers the instance getConnectionState() (standby) over derivation', () => {
    provider.nextInstanceOverrides = {
      connectedFlag: false,
      connectionState: 'standby',
    }
    manager.applyConfig([makeConfig('i1')], noopInbound)
    const status = manager.getInstanceStatus('i1')
    expect(status?.connected).toBe(false)
    expect(status?.state).toBe('standby')
  })

  it('getAllStatuses returns one status per configured instance', () => {
    manager.applyConfig(
      [makeConfig('i1'), makeConfig('i2')],
      noopInbound,
    )
    expect(manager.getAllStatuses()).toHaveLength(2)
  })
})

describe('ImChannelManager.stopInstance — onInstanceStop resilience', () => {
  it('fires onInstanceStop after teardown', () => {
    const manager = new ImChannelManager()
    manager.registerProvider(makeProvider())
    const stopHandler = vi.fn()
    manager.setOnInstanceStop(stopHandler)
    manager.applyConfig([makeConfig('i1')], noopInbound)
    manager.applyConfig([], noopInbound)
    expect(stopHandler).toHaveBeenCalledWith('i1')
  })

  it('swallows errors thrown by the onInstanceStop handler', () => {
    const manager = new ImChannelManager()
    manager.registerProvider(makeProvider())
    manager.setOnInstanceStop(() => {
      throw new Error('handler blew up')
    })
    manager.applyConfig([makeConfig('i1')], noopInbound)
    const inst = manager.getInstance('i1') as FakeInstance
    expect(() => manager.applyConfig([], noopInbound)).not.toThrow()
    expect(inst.stopped).toBe(true)
    expect(manager.getInstance('i1')).toBeUndefined()
  })

  it('swallows errors thrown by instance.stop()', () => {
    const manager = new ImChannelManager()
    const provider = makeProvider({
      nextInstanceOverrides: {
        stop() {
          throw new Error('stop failed')
        },
      },
    })
    manager.registerProvider(provider)
    manager.applyConfig([makeConfig('i1')], noopInbound)
    expect(() => manager.applyConfig([], noopInbound)).not.toThrow()
    expect(manager.getInstance('i1')).toBeUndefined()
  })
})

describe('ImChannelManager — hotUpdatableConfigKeys', () => {
  let manager: ImChannelManager

  beforeEach(() => {
    manager = new ImChannelManager()
  })

  it('applies a hot-updatable-only change via updateConfig(), without stop+recreate', () => {
    const provider = makeProvider({ hotUpdatableConfigKeys: ['nameResolveApiKey'] })
    manager.registerProvider(provider)

    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b1', nameResolveApiKey: '' } })],
      noopInbound,
    )
    const inst = manager.getInstance('i1') as FakeInstance

    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b1', nameResolveApiKey: 'https://qyapi.example/x?apikey=new' } })],
      noopInbound,
    )

    expect(inst.stopped).toBe(false)
    expect(provider.created).toHaveLength(1)
    expect(manager.getInstance('i1')).toBe(inst)
    expect(inst.updateConfigCalls).toEqual([
      { botId: 'b1', nameResolveApiKey: 'https://qyapi.example/x?apikey=new' },
    ])
  })

  it('still does a full stop+recreate when a non-hot-updatable field also changes', () => {
    const provider = makeProvider({ hotUpdatableConfigKeys: ['nameResolveApiKey'] })
    manager.registerProvider(provider)

    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b1', nameResolveApiKey: '' } })],
      noopInbound,
    )
    const inst = manager.getInstance('i1') as FakeInstance

    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b2', nameResolveApiKey: 'https://qyapi.example/x?apikey=new' } })],
      noopInbound,
    )

    expect(inst.stopped).toBe(true)
    expect(provider.created).toHaveLength(2)
    expect(inst.updateConfigCalls).toHaveLength(0)
  })

  it('falls back to stop+recreate when the provider declares no hotUpdatableConfigKeys', () => {
    const provider = makeProvider() // no hotUpdatableConfigKeys
    manager.registerProvider(provider)

    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b1', nameResolveApiKey: '' } })],
      noopInbound,
    )
    const inst = manager.getInstance('i1') as FakeInstance

    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b1', nameResolveApiKey: 'https://qyapi.example/x?apikey=new' } })],
      noopInbound,
    )

    expect(inst.stopped).toBe(true)
    expect(provider.created).toHaveLength(2)
  })
})

describe('ImChannelManager — identityResolution status lifecycle', () => {
  let manager: ImChannelManager

  beforeEach(() => {
    manager = new ImChannelManager()
  })

  function fakeCapability(): ImIdentityCapability {
    return { fetchIdentityDirectory: async () => new Map() }
  }

  it('omits identityResolution when the instance exposes no identityCapability', () => {
    manager.registerProvider(makeProvider())
    manager.applyConfig([makeConfig('i1')], noopInbound)
    expect(manager.getInstanceStatus('i1')?.identityResolution).toBeUndefined()
  })

  it("reports 'pending' when identityCapability is present but no attempt has completed", () => {
    const provider = makeProvider({
      nextInstanceOverrides: { identityCapability: fakeCapability() },
    })
    manager.registerProvider(provider)
    manager.applyConfig([makeConfig('i1')], noopInbound)
    expect(manager.getInstanceStatus('i1')?.identityResolution).toEqual({ status: 'pending' })
  })

  it('clears tracked identity-resolution state on true removal, not on a mere disable', () => {
    const clearSpy = vi.spyOn(identityResolve, 'clearIdentityResolutionStatus')
    const provider = makeProvider({
      nextInstanceOverrides: { identityCapability: fakeCapability() },
    })
    manager.registerProvider(provider)

    manager.applyConfig([makeConfig('i1')], noopInbound)
    clearSpy.mockClear()

    // Disable — config change, not removal. Must NOT clear: the UI should
    // keep showing the last known outcome rather than flashing to "pending".
    manager.applyConfig([makeConfig('i1', { enabled: false })], noopInbound)
    expect(clearSpy).not.toHaveBeenCalled()

    // Re-enable, then remove entirely — MUST clear.
    manager.applyConfig([makeConfig('i1')], noopInbound)
    manager.applyConfig([], noopInbound)
    expect(clearSpy).toHaveBeenCalledWith('i1')

    clearSpy.mockRestore()
  })

  it('clears tracked identity-resolution state when a hot-updatable credential changes', () => {
    const clearSpy = vi.spyOn(identityResolve, 'clearIdentityResolutionStatus')
    const provider = makeProvider({
      hotUpdatableConfigKeys: ['nameResolveApiKey'],
      nextInstanceOverrides: { identityCapability: fakeCapability() },
    })
    manager.registerProvider(provider)

    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b1', nameResolveApiKey: 'old' } })],
      noopInbound,
    )
    clearSpy.mockClear()

    // Re-authorized with a fresh URL — a stale 'expired'/'error' status must
    // not linger past the fix.
    manager.applyConfig(
      [makeConfig('i1', { config: { botId: 'b1', nameResolveApiKey: 'new' } })],
      noopInbound,
    )
    expect(clearSpy).toHaveBeenCalledWith('i1')

    clearSpy.mockRestore()
  })
})
