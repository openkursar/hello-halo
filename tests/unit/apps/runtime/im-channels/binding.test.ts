/**
 * Unit tests for apps/runtime/im-channels/binding.
 *
 * These pin the invariants that used to exist only as a renderer-side warning,
 * and which a second binding surface (the digital human's own settings page)
 * would otherwise have bypassed:
 *
 *   1. A bind target must be an automation app that still exists and has a
 *      space — otherwise inbound dispatch drops the message silently.
 *   2. The same physical bot (botId) must not be enabled twice, which would
 *      route one conversation to two digital humans.
 *   3. Every accepted write persists AND re-applies to the running manager,
 *      because appId is captured at connection creation time.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImChannelInstanceConfig } from '../../../../../src/shared/types/im-channel'

const state = {
  instances: [] as ImChannelInstanceConfig[],
  apps: new Map<string, { spec: { type: string }; spaceId: string | null }>(),
  saved: null as unknown,
  applied: 0,
  invalidated: 0,
}

vi.mock('../../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ imChannels: { instances: state.instances } }),
  saveConfig: (patch: unknown) => { state.saved = patch },
}))

vi.mock('../../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({
    getApp: (appId: string) => state.apps.get(appId) ?? null,
  }),
}))

// getProvider is part of the mock because the duplicate-credential rule asks
// the provider which of its fields identifies the bot (botId for WeCom, appId
// for Feishu) instead of assuming one field name.
vi.mock('../../../../../src/main/apps/runtime/index', () => ({
  getImChannelManager: () => ({
    applyConfig: () => { state.applied++ },
    getProvider: (type: string) => (
      type === 'feishu-bot'
        ? { credentialId: (config: Record<string, unknown>) => String(config.appId ?? '').trim() || undefined }
        : { /* legacy provider: no credentialId, falls back to botId */ }
    ),
  }),
  dispatchInboundMessage: () => {},
  invalidateImSessions: () => { state.invalidated++ },
}))

const { setInstanceApp, createInstance, unbindInstance } = await import(
  '../../../../../src/main/apps/runtime/im-channels/binding'
)

function instance(overrides: Partial<ImChannelInstanceConfig> = {}): ImChannelInstanceConfig {
  return {
    id: 'inst-1',
    type: 'wecom-bot',
    enabled: true,
    appId: 'app-1',
    config: { botId: 'bot-a', secret: 's', wsUrl: '' },
    ...overrides,
  } as ImChannelInstanceConfig
}

beforeEach(() => {
  state.instances = []
  state.apps = new Map([
    ['app-1', { spec: { type: 'automation' }, spaceId: 'space-1' }],
    ['app-2', { spec: { type: 'automation' }, spaceId: 'space-1' }],
    ['global-app', { spec: { type: 'automation' }, spaceId: null }],
    ['a-skill', { spec: { type: 'skill' }, spaceId: 'space-1' }],
  ])
  state.saved = null
  state.applied = 0
  state.invalidated = 0
})

describe('setInstanceApp — target validation', () => {
  it('rejects an empty appId', () => {
    expect(setInstanceApp('inst-1', '').success).toBe(false)
  })

  it('rejects an app that does not exist', () => {
    state.instances = [instance()]
    const res = setInstanceApp('inst-1', 'ghost')
    expect(res.success).toBe(false)
    expect(res.error).toContain('not found')
  })

  it('rejects a non-automation app', () => {
    state.instances = [instance()]
    expect(setInstanceApp('inst-1', 'a-skill').success).toBe(false)
  })

  it('rejects a global app, which inbound dispatch cannot route to', () => {
    state.instances = [instance()]
    const res = setInstanceApp('inst-1', 'global-app')
    expect(res.success).toBe(false)
    expect(res.error).toContain('global')
  })

  it('rejects an unknown instance', () => {
    expect(setInstanceApp('missing', 'app-1').success).toBe(false)
  })
})

describe('setInstanceApp — duplicate credential block', () => {
  it('rejects binding an instance whose bot is already live on another bound instance', () => {
    // inst-2 is unbound (appId '') so the manager is not running it; binding it
    // is exactly the step that would start a second connection on bot-a.
    state.instances = [
      instance({ id: 'inst-1', appId: 'app-1' }),
      instance({ id: 'inst-2', appId: '' }),
    ]
    const res = setInstanceApp('inst-2', 'app-2')
    expect(res.success).toBe(false)
    expect(res.error).toContain('already bound')
    expect(state.saved).toBeNull()
  })

  it('allows binding when the credentials differ', () => {
    state.instances = [
      instance({ id: 'inst-1', appId: 'app-1' }),
      instance({ id: 'inst-2', appId: '', config: { botId: 'bot-b' } }),
    ]
    expect(setInstanceApp('inst-2', 'app-2').success).toBe(true)
  })

  it('allows binding when the conflicting instance is disabled', () => {
    state.instances = [
      instance({ id: 'inst-1', appId: 'app-1', enabled: false }),
      instance({ id: 'inst-2', appId: '' }),
    ]
    expect(setInstanceApp('inst-2', 'app-2').success).toBe(true)
  })
})

describe('setInstanceApp — write behaviour', () => {
  it('rebinds and re-applies to the running manager', () => {
    state.instances = [instance()]
    const res = setInstanceApp('inst-1', 'app-2')

    expect(res.success).toBe(true)
    expect((state.saved as { imChannels: { instances: ImChannelInstanceConfig[] } })
      .imChannels.instances[0].appId).toBe('app-2')
    expect(state.applied).toBe(1)
    expect(state.invalidated).toBe(1)
  })

  it('is a no-op when the instance is already bound to that app', () => {
    state.instances = [instance({ appId: 'app-1' })]
    expect(setInstanceApp('inst-1', 'app-1').success).toBe(true)
    expect(state.saved).toBeNull()
    expect(state.applied).toBe(0)
  })

  it('leaves sibling instances untouched', () => {
    state.instances = [instance(), instance({ id: 'inst-2', appId: 'app-2', config: { botId: 'bot-b' } })]
    setInstanceApp('inst-1', 'app-2')
    const saved = (state.saved as { imChannels: { instances: ImChannelInstanceConfig[] } }).imChannels.instances
    expect(saved).toHaveLength(2)
    expect(saved[1]).toEqual(state.instances[1])
  })
})

describe('createInstance', () => {
  it('appends a validated instance', () => {
    const res = createInstance(instance({ id: 'new-1' }))
    expect(res.success).toBe(true)
    expect((state.saved as { imChannels: { instances: ImChannelInstanceConfig[] } })
      .imChannels.instances).toHaveLength(1)
    expect(state.applied).toBe(1)
  })

  it('rejects a duplicate id', () => {
    state.instances = [instance()]
    expect(createInstance(instance()).success).toBe(false)
  })

  it('rejects a bot already bound elsewhere, the rule that was renderer-only before', () => {
    state.instances = [instance({ id: 'inst-1', appId: 'app-1' })]
    const res = createInstance(instance({ id: 'inst-2', appId: 'app-2' }))
    expect(res.success).toBe(false)
    expect(res.error).toContain('already bound')
  })

  it('allows the same botId when the existing instance is disabled', () => {
    state.instances = [instance({ id: 'inst-1', enabled: false })]
    expect(createInstance(instance({ id: 'inst-2', appId: 'app-2' })).success).toBe(true)
  })

  it('does not treat a blank botId as a duplicate', () => {
    state.instances = [instance({ id: 'inst-1', config: { botId: '' } })]
    expect(createInstance(instance({ id: 'inst-2', config: { botId: '' } })).success).toBe(true)
  })

  it('rejects a Feishu app already bound elsewhere, keyed on App ID not botId', () => {
    const feishu = (id: string, appId: string): ImChannelInstanceConfig => instance({
      id,
      appId,
      type: 'feishu-bot',
      config: { appId: 'cli_a1b2c3d4e5f60718', appSecret: 's' },
    })
    state.instances = [feishu('inst-1', 'app-1')]
    const res = createInstance(feishu('inst-2', 'app-2'))
    expect(res.success).toBe(false)
    expect(res.error).toContain('already bound')
  })

  it('allows two Feishu instances with different App IDs', () => {
    state.instances = [instance({
      id: 'inst-1',
      type: 'feishu-bot',
      config: { appId: 'cli_a1b2c3d4e5f60718', appSecret: 's' },
    })]
    const res = createInstance(instance({
      id: 'inst-2',
      appId: 'app-2',
      type: 'feishu-bot',
      config: { appId: 'cli_ffffffffffffffff', appSecret: 's' },
    }))
    expect(res.success).toBe(true)
  })

  it('validates the target before touching config', () => {
    expect(createInstance(instance({ id: 'new-1', appId: 'global-app' })).success).toBe(false)
    expect(state.saved).toBeNull()
  })
})

describe('unbindInstance', () => {
  it('clears appId so the manager stops connecting the bot', () => {
    state.instances = [instance()]
    const res = unbindInstance('inst-1')

    expect(res.success).toBe(true)
    expect((state.saved as { imChannels: { instances: ImChannelInstanceConfig[] } })
      .imChannels.instances[0].appId).toBe('')
    expect(state.applied).toBe(1)
  })

  it('keeps the bot credentials, so it can be rebound without scanning again', () => {
    state.instances = [instance()]
    unbindInstance('inst-1')
    const saved = (state.saved as { imChannels: { instances: ImChannelInstanceConfig[] } }).imChannels.instances[0]
    expect(saved.config).toEqual({ botId: 'bot-a', secret: 's', wsUrl: '' })
  })

  it('is a no-op when already unbound', () => {
    state.instances = [instance({ appId: '' })]
    expect(unbindInstance('inst-1').success).toBe(true)
    expect(state.saved).toBeNull()
  })

  it('rejects an unknown instance', () => {
    expect(unbindInstance('missing').success).toBe(false)
  })
})
