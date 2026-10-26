/**
 * Unit tests for apps/runtime/im-channels/instance-settings.
 *
 * The settings page used to write its whole copy of the instance list back,
 * which undid fields main had written meanwhile — an owner claimed by a first
 * direct message vanished on the next unrelated settings save. These pin that a
 * settings change applies only what the person changed onto what is stored.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImChannelInstanceConfig } from '../../../../../src/shared/types/im-channel'

const state = {
  instances: [] as ImChannelInstanceConfig[],
  unreadable: false,
  /** What the next reads of config.json find, when it changed since the last one. */
  readFails: null as boolean | null,
  saved: null as { imChannels: { instances: ImChannelInstanceConfig[] } } | null,
  applied: [] as ImChannelInstanceConfig[][],
  invalidated: 0,
}

// Like the real service: a read sets the unreadable flag, and an unreadable
// file reads as the built-in defaults.
vi.mock('../../../../../src/main/foundation/config.service', () => ({
  getConfig: () => {
    if (state.readFails !== null) state.unreadable = state.readFails
    return { imChannels: { instances: state.unreadable ? [] : state.instances } }
  },
  saveConfig: (patch: { imChannels: { instances: ImChannelInstanceConfig[] } }) => {
    state.saved = patch
    state.instances = patch.imChannels.instances
  },
  isConfigUnreadable: () => state.unreadable,
}))

vi.mock('../../../../../src/main/apps/runtime/index', () => ({
  getImChannelManager: () => ({
    applyConfig: (instances: ImChannelInstanceConfig[]) => { state.applied.push(instances) },
  }),
  dispatchInboundMessage: () => {},
  invalidateImSessions: () => { state.invalidated++ },
}))

const { updateInstanceSettings, addInstance, removeInstance } = await import(
  '../../../../../src/main/apps/runtime/im-channels/instance-settings'
)
const { mergeImChannelInstancePatches } = await import('../../../../../src/shared/types/im-channel')

function instance(overrides: Partial<ImChannelInstanceConfig> = {}): ImChannelInstanceConfig {
  return {
    id: 'inst-1',
    type: 'wecom-bot',
    enabled: true,
    appId: 'app-1',
    config: { botId: 'bot-a', secret: 's', wsUrl: '' },
    replyScope: 'all',
    permissionEnabled: true,
    ...overrides,
  } as ImChannelInstanceConfig
}

function stored(id = 'inst-1'): ImChannelInstanceConfig {
  return state.instances.find(i => i.id === id)!
}

beforeEach(() => {
  state.instances = []
  state.unreadable = false
  state.readFails = null
  state.saved = null
  state.applied = []
  state.invalidated = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('updateInstanceSettings — the claimed owner survives', () => {
  it('keeps an owner main claimed after the page loaded when an unrelated field changes', () => {
    // The page loaded the instance with no owner; the first direct message then
    // claimed one in main. The page now turns streaming on.
    state.instances = [instance({ owners: ['zhangsan'] })]
    const res = updateInstanceSettings('inst-1', { streaming: true })

    expect(res.success).toBe(true)
    expect(stored().owners).toEqual(['zhangsan'])
    expect(stored().streaming).toBe(true)
  })

  it('keeps sibling instances exactly as stored', () => {
    const sibling = instance({ id: 'inst-2', owners: ['lisi'], config: { botId: 'bot-b' } })
    state.instances = [instance(), sibling]
    updateInstanceSettings('inst-1', { replyScope: 'group' })
    expect(stored('inst-2')).toEqual(sibling)
  })

  it('keeps a config key main wrote when another key is typed', () => {
    state.instances = [instance({ type: 'weixin-ilink-bot', config: { botToken: 'tok', baseUrl: 'u', accountId: 'a' } })]
    updateInstanceSettings('inst-1', { config: { accountId: 'b' } })
    expect(stored().config).toEqual({ botToken: 'tok', baseUrl: 'u', accountId: 'b' })
  })
})

describe('updateInstanceSettings — what a patch does', () => {
  it('sets owners the person typed in', () => {
    state.instances = [instance({ owners: ['zhangsan'] })]
    updateInstanceSettings('inst-1', { owners: ['wangwu'] })
    expect(stored().owners).toEqual(['wangwu'])
  })

  it('removes a field on null, so clearing the owner list really clears it', () => {
    state.instances = [instance({ owners: ['zhangsan'], streaming: true })]
    updateInstanceSettings('inst-1', { owners: null, streaming: null })
    expect(stored()).not.toHaveProperty('owners')
    expect(stored()).not.toHaveProperty('streaming')
  })

  it('removes a config key on null and leaves the others', () => {
    state.instances = [instance({ config: { botId: 'bot-a', secret: 's', quoteReply: false } })]
    updateInstanceSettings('inst-1', { config: { quoteReply: null } })
    expect(stored().config).toEqual({ botId: 'bot-a', secret: 's' })
  })

  it('ignores a masked secret, which a remote client was shown rather than typed', () => {
    state.instances = [instance()]
    updateInstanceSettings('inst-1', { config: { secret: '***', wsUrl: 'wss://x' } })
    expect(stored().config).toEqual({ botId: 'bot-a', secret: 's', wsUrl: 'wss://x' })
  })

  it('persists, re-applies to the running manager and invalidates IM sessions', () => {
    state.instances = [instance()]
    const res = updateInstanceSettings('inst-1', { enabled: false })
    expect(state.applied).toHaveLength(1)
    expect(state.applied[0][0].enabled).toBe(false)
    expect(state.invalidated).toBe(1)
    expect(res).toEqual({ success: true, data: state.instances })
  })

  it('writes nothing when the patch changes nothing', () => {
    state.instances = [instance({ streaming: true })]
    const res = updateInstanceSettings('inst-1', { streaming: true })
    expect(res.success).toBe(true)
    expect(state.saved).toBeNull()
    expect(state.applied).toHaveLength(0)
    expect(state.invalidated).toBe(0)
  })
})

describe('updateInstanceSettings — refusals', () => {
  it('refuses an unknown instance', () => {
    expect(updateInstanceSettings('missing', { enabled: true }).success).toBe(false)
  })

  it('refuses to change the id or type', () => {
    state.instances = [instance()]
    expect(updateInstanceSettings('inst-1', { id: 'other' } as never).success).toBe(false)
    expect(updateInstanceSettings('inst-1', { type: 'feishu-bot' } as never).success).toBe(false)
    expect(state.saved).toBeNull()
  })

  it('refuses to remove a required field', () => {
    state.instances = [instance()]
    expect(updateInstanceSettings('inst-1', { appId: null } as never).success).toBe(false)
    expect(updateInstanceSettings('inst-1', { enabled: null } as never).success).toBe(false)
  })

  it('refuses a patch that is not an object, or whose config is not one', () => {
    state.instances = [instance()]
    expect(updateInstanceSettings('inst-1', null as never).success).toBe(false)
    expect(updateInstanceSettings('inst-1', { config: 'x' } as never).success).toBe(false)
  })

  it('reports "not saved" while config.json cannot be read, instead of claiming success', () => {
    state.instances = [instance()]
    state.unreadable = true
    const res = updateInstanceSettings('inst-1', { enabled: false })
    expect(res.success).toBe(false)
    expect(state.saved).toBeNull()
    expect(state.applied).toHaveLength(0)
  })
})

describe('config.json read state — judged by the read a write builds on', () => {
  it('refuses when the file broke since the last read, instead of stopping every other bot', () => {
    state.instances = [instance()]
    state.readFails = true
    expect(addInstance(instance({ id: 'inst-2' }))).toMatchObject({ success: false, error: expect.stringContaining('Not saved') })
    expect(removeInstance('inst-1').success).toBe(false)
    expect(state.saved).toBeNull()
    expect(state.applied).toHaveLength(0)
  })

  it('writes once the file reads again, although the last read had failed', () => {
    state.instances = [instance()]
    state.unreadable = true
    state.readFails = false
    expect(updateInstanceSettings('inst-1', { enabled: false }).success).toBe(true)
    expect(stored().enabled).toBe(false)
  })
})

describe('addInstance', () => {
  it('appends to what is stored, keeping an owner claimed on another instance', () => {
    state.instances = [instance({ owners: ['zhangsan'] })]
    const res = addInstance(instance({ id: 'inst-2', appId: '', enabled: false, config: { botId: '' } }))
    expect(res.success).toBe(true)
    expect(state.instances.map(i => i.id)).toEqual(['inst-1', 'inst-2'])
    expect(stored('inst-1').owners).toEqual(['zhangsan'])
    expect(state.applied).toHaveLength(1)
  })

  it('refuses a duplicate id', () => {
    state.instances = [instance()]
    expect(addInstance(instance()).success).toBe(false)
    expect(state.saved).toBeNull()
  })

  it('refuses an instance without id, type or config object', () => {
    expect(addInstance({ ...instance(), id: '' }).success).toBe(false)
    expect(addInstance({ ...instance(), type: '' } as never).success).toBe(false)
    expect(addInstance({ ...instance(), config: null } as never).success).toBe(false)
    expect(addInstance(null as never).success).toBe(false)
  })

  it('refuses while config.json cannot be read', () => {
    state.unreadable = true
    expect(addInstance(instance()).success).toBe(false)
    expect(state.saved).toBeNull()
  })
})

describe('removeInstance', () => {
  it('removes only that instance', () => {
    const sibling = instance({ id: 'inst-2', owners: ['lisi'] })
    state.instances = [instance(), sibling]
    const res = removeInstance('inst-1')
    expect(res.success).toBe(true)
    expect(state.instances).toEqual([sibling])
    expect(state.applied).toHaveLength(1)
  })

  it('succeeds without writing when the instance is already gone', () => {
    state.instances = [instance()]
    const res = removeInstance('missing')
    expect(res).toEqual({ success: true, data: state.instances })
    expect(state.saved).toBeNull()
  })

  it('refuses while config.json cannot be read', () => {
    state.instances = [instance()]
    state.unreadable = true
    expect(removeInstance('inst-1').success).toBe(false)
    expect(state.instances).toHaveLength(1)
  })
})

describe('mergeImChannelInstancePatches', () => {
  it('keeps typing waiting for the debounce when a later change arrives', () => {
    const merged = mergeImChannelInstancePatches(
      { config: { botId: 'bot-b' } },
      { owners: ['zhangsan'], config: { secret: 'x' } },
    )
    expect(merged).toEqual({ owners: ['zhangsan'], config: { botId: 'bot-b', secret: 'x' } })
  })

  it('lets the later change win on the same field', () => {
    expect(mergeImChannelInstancePatches({ streaming: true }, { streaming: null })).toEqual({ streaming: null })
  })

  it('returns the later patch when nothing was waiting', () => {
    const later = { enabled: false }
    expect(mergeImChannelInstancePatches(null, later)).toBe(later)
  })
})
