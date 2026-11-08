/**
 * A conversation follows its group's routing only while it runs on a group:
 * no listener and no request otherwise. And the one line Halo shows while it
 * moves a waiting reply to another model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const env = vi.hoisted(() => ({
  runner: null as any,
  routes: {} as Record<string, unknown>,
  watch: vi.fn(),
  load: vi.fn(),
  group: null as { id: string } | null,
  generating: false,
  activeId: 'c1' as string | null,
  conversationCache: new Map<string, any>(),
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => env.runner.effect(effect, deps),
  useRef: (initial: unknown) => env.runner.ref(initial),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
}))
vi.mock('../../../src/renderer/stores/ai-group-route.store', () => ({
  useGroupRouteStore: (select: (state: { routes: Record<string, unknown> }) => unknown) => select({ routes: env.routes }),
  watchGroupRoutes: env.watch,
  loadGroupRoutes: env.load,
}))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: (select: (state: { conversationCache: Map<string, any> }) => unknown) => select(env),
  selectActiveConversationId: () => env.activeId,
  useIsGenerating: () => env.generating,
}))
vi.mock('../../../src/renderer/hooks/useActiveGroup', () => ({ useActiveGroup: () => env.group }))

import { useConversationGroupRoute } from '../../../src/renderer/hooks/useConversationGroupRoute'
import { GroupSwitchNotice } from '../../../src/renderer/components/ai-groups/GroupSwitchNotice'

class HookRunner {
  index = 0
  refs = new Map<number, { current: unknown }>()
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending: Array<() => void> = []

  ref(initial: unknown) {
    const index = this.index++
    if (!this.refs.has(index)) this.refs.set(index, { current: initial })
    return this.refs.get(index)
  }

  effect(effect: () => void | (() => void), deps: unknown[]) {
    const index = this.index++
    const previous = this.effects.get(index)
    if (previous && deps.length === previous.deps.length && deps.every((value, position) => Object.is(value, previous.deps[position]))) return
    this.pending.push(() => {
      previous?.cleanup?.()
      const cleanup = effect()
      this.effects.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
    })
  }

  render<T>(render: () => T): T { this.index = 0; return render() }
  commit() { this.pending.splice(0).forEach(effect => effect()) }
  unmount() {
    this.effects.forEach(effect => effect.cleanup?.())
    this.effects.clear()
    this.refs.clear()
    this.pending.length = 0
  }
}

function observe(conversation: { id: string; sessionId?: string } | null, groupId: string) {
  return env.runner.render(() => useConversationGroupRoute(conversation, groupId))
}

const report = (extra: Record<string, unknown> = {}) => ({
  groupId: 'g1', sessionKey: 'c1', state: 'switching', at: 5,
  member: { key: 'k', sourceId: 'b', modelId: 'm', label: { account: 'Backup', model: 'Sonnet' } },
  ...extra,
})

beforeEach(() => {
  env.runner = new HookRunner()
  env.routes = {}
  env.watch.mockReset().mockReturnValue(vi.fn())
  env.load.mockReset()
  env.group = null
  env.generating = false
  env.activeId = 'c1'
  env.conversationCache = new Map([['c1', { id: 'c1', sessionId: 's1' }]])
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  env.runner.unmount()
  vi.restoreAllMocks()
})

describe('following a conversation\'s group', () => {
  it('does not read routes before the group has a conversation', () => {
    expect(observe(null, 'g1')).toBeNull()
    env.runner.commit()
    expect(env.watch).not.toHaveBeenCalled()
    expect(env.load).not.toHaveBeenCalled()
  })

  it('listens and asks what the router knows, under the conversation id and the engine\'s session id', () => {
    observe({ id: 'c1', sessionId: 's1' }, 'g1')
    env.runner.commit()
    expect(env.watch).toHaveBeenCalledTimes(1)
    expect(env.watch).toHaveBeenCalledWith(['c1', 's1'])
    expect(env.load).toHaveBeenCalledWith(['c1', 's1'])
  })

  it('asks under the conversation id alone before the engine has named a session', () => {
    observe({ id: 'c1' }, 'g1')
    env.runner.commit()
    expect(env.load).toHaveBeenCalledWith(['c1'])
  })

  it('stops listening when the conversation goes away', () => {
    const release = vi.fn()
    env.watch.mockReturnValue(release)
    observe({ id: 'c1' }, 'g1')
    env.runner.commit()
    env.runner.unmount()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('replaces the watched keys when the conversation or native binding changes', () => {
    const release = vi.fn()
    env.watch.mockReturnValue(release)
    observe({ id: 'c1' }, 'g1')
    env.runner.commit()
    observe({ id: 'c2', sessionId: 'native-cc' }, 'g2')
    env.runner.commit()
    expect(release).toHaveBeenCalledTimes(1)
    expect(env.watch).toHaveBeenLastCalledWith(['c2', 'native-cc'])
    expect(env.load).toHaveBeenLastCalledWith(['c2', 'native-cc'])
  })

  it('returns what the router reported for this conversation and this group', () => {
    env.routes = { c1: report({ state: 'serving' }), other: report({ sessionKey: 'other', groupId: 'g2' }) }
    expect(observe({ id: 'c1' }, 'g1')).toMatchObject({ state: 'serving' })
    env.runner.commit()
    expect(observe({ id: 'other' }, 'g1')).toBeNull()
  })
})

describe('the line shown while Halo switches models', () => {
  const render = () => env.runner.render(() => renderToStaticMarkup(createElement(GroupSwitchNotice)))

  it('adds nothing to a conversation that is not on a group', () => {
    env.routes = { c1: report() }
    env.generating = true
    const cached = vi.spyOn(env.conversationCache, 'get')
    expect(render()).toBe('')
    env.runner.commit()
    expect(cached).not.toHaveBeenCalled()
    expect(env.watch).not.toHaveBeenCalled()
    expect(env.load).not.toHaveBeenCalled()
  })

  it('names the model being tried while a reply is awaited', () => {
    env.group = { id: 'g1' }
    env.routes = { c1: report() }
    env.generating = true
    const html = render()
    expect(html).toContain('Trying another model: Backup / Sonnet')
    expect(html).toContain('role="status"')
  })

  it('says nothing once the wait is over, even if the last report was a switch', () => {
    env.group = { id: 'g1' }
    env.routes = { c1: report() }
    env.generating = false
    expect(render()).not.toContain('Trying another model')
  })

  it('says nothing while the model in use is simply serving', () => {
    env.group = { id: 'g1' }
    env.routes = { c1: report({ state: 'serving' }) }
    env.generating = true
    expect(render()).not.toContain('Trying another model')
  })

  it('keeps its live region in place for a conversation on a group, so what appears in it is announced', () => {
    env.group = { id: 'g1' }
    env.generating = true
    expect(render()).toContain('role="status"')
    env.routes = { c1: report() }
    expect(render()).toContain('role="status"')
    expect(render()).toContain('Trying another model')
  })

  it('finds the report under the engine\'s session id', () => {
    env.group = { id: 'g1' }
    env.routes = { s1: report({ sessionKey: 's1' }) }
    env.generating = true
    expect(render()).toContain('Trying another model')
    env.runner.commit()
    expect(env.load).toHaveBeenCalledWith(['c1', 's1'])
  })

  it('finds a digital human\'s native Claude Code report from its cached binding', () => {
    env.group = { id: 'g1' }
    env.activeId = 'app-chat:app1:local:direct:conversation1'
    env.conversationCache = new Map([[env.activeId, {
      id: env.activeId,
      engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'native-cc' },
    }]])
    const cached = vi.spyOn(env.conversationCache, 'get')
    env.routes = { 'native-cc': report({ sessionKey: 'native-cc' }) }
    env.generating = true
    expect(render()).toContain('Trying another model: Backup / Sonnet')
    env.runner.commit()
    expect(env.load).toHaveBeenCalledWith([env.activeId, 'native-cc'])
    expect(cached).toHaveBeenCalledTimes(1)
    expect(cached).toHaveBeenCalledWith(env.activeId)
  })

  it('prefers the current native binding over an older ordinary session id', () => {
    env.group = { id: 'g1' }
    env.conversationCache.set('c1', {
      id: 'c1', sessionId: 'old-native',
      engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'current-native' },
    })
    env.routes = {
      'old-native': report({ sessionKey: 'old-native', at: 10 }),
      'current-native': report({ sessionKey: 'current-native', state: 'serving', at: 5 }),
    }
    env.generating = true
    expect(render()).not.toContain('Trying another model')
    env.runner.commit()
    expect(env.load).toHaveBeenCalledWith(['c1', 'current-native'])
  })
})
