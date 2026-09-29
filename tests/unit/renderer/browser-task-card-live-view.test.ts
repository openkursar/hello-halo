/**
 * "View live feed" on the browser card: enabled only when the conversation on
 * screen has an AI page of its own, and it attaches exactly that view.
 *
 * This is what turns on live view for a digital-human chat: its conversation id
 * (the app-chat key) is the key the main process announces the page under.
 * No DOM: hooks are replaced by a small runner and the element tree is searched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  activeConversationId: null as string | null,
  views: {} as Record<string, { viewId: string; url: string | null }>,
  attach: vi.fn(),
  setOperating: vi.fn(),
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useEffect: (fn: any, deps: any) => env.runner.effect(fn, deps),
  useMemo: (fn: any) => fn(),
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/canvas.store', () => ({
  useCanvasStore: (select: any) => select({ attachAIBrowserView: env.attach }),
}))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: () => env.activeConversationId,
  selectActiveConversationId: () => null,
}))
vi.mock('../../../src/renderer/stores/ai-browser.store', () => ({
  useAIBrowserStore: (select: any) => select({ setOperating: env.setOperating }),
  useActiveConversationBrowserView: () => (env.activeConversationId ? env.views[env.activeConversationId] ?? null : null),
}))

import { BrowserTaskCard } from '../../../src/renderer/components/tool/BrowserTaskCard'

class Runner {
  values: any[] = []; index = 0; pending: (() => void)[] = []
  state(initial: any) { const i = this.index++; if (!(i in this.values)) this.values[i] = initial; return [this.values[i], (v: any) => { this.values[i] = v }] }
  effect(fn: () => void, deps?: any[]) {
    const i = this.index++
    const prev = this.values[i]
    if (!deps || !prev || deps.some((d, k) => !Object.is(d, prev[k]))) this.pending.push(fn)
    this.values[i] = deps
  }
  render(component: () => any) {
    this.index = 0; this.pending = []; env.runner = this
    const tree = component()
    this.pending.forEach(fn => fn())
    return tree
  }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
const viewButton = (tree: any) =>
  nodes(tree).find(n => n.type === 'button' && nodes(n).some(c => c.props?.children === 'View live feed'))

const call = { id: 't1', name: 'mcp__ai-browser__browser_navigate', input: { url: 'https://example.com/a' }, status: 'success' } as any
const render = (props: Partial<Parameters<typeof BrowserTaskCard>[0]> = {}) =>
  new Runner().render(() => BrowserTaskCard({ browserToolCalls: [call], isActive: false, ...props }))

const DH_KEY = 'app-chat:dh1:local:direct:11111111-1111-1111-1111-111111111111'

describe('BrowserTaskCard live view', () => {
  beforeEach(() => {
    env.activeConversationId = DH_KEY
    env.views = {}
    env.attach.mockReset()
    env.setOperating.mockReset()
  })

  it('is disabled until the on-screen conversation has a page', () => {
    const button = viewButton(render())
    expect(button.props.disabled).toBe(true)
  })

  it('is enabled for a digital-human conversation and reveals exactly its view', () => {
    env.views[DH_KEY] = { viewId: 'ai-browser-42', url: 'https://example.com/live' }

    const button = viewButton(render())
    expect(button.props.disabled).toBe(false)
    button.props.onClick()

    expect(env.attach).toHaveBeenCalledWith('ai-browser-42', 'https://example.com/live', '🤖 AI Browser')
  })

  it('never offers another conversation’s page', () => {
    env.views['app-chat:other'] = { viewId: 'ai-browser-99', url: null }

    expect(viewButton(render()).props.disabled).toBe(true)
  })

  it('falls back to the URL the AI navigated to when the page has none yet', () => {
    env.views[DH_KEY] = { viewId: 'ai-browser-42', url: null }

    viewButton(render()).props.onClick()

    expect(env.attach).toHaveBeenCalledWith('ai-browser-42', 'https://example.com/a', '🤖 AI Browser')
  })

  it('has no button where live view is switched off (IM, team, automation views)', () => {
    env.views[DH_KEY] = { viewId: 'ai-browser-42', url: null }

    expect(viewButton(render({ showViewButton: false }))).toBeUndefined()
  })

  it('reports operating state for the on-screen conversation only while its turn runs', () => {
    render({ isActive: true, browserToolCalls: [{ ...call, status: 'running' }] })
    expect(env.setOperating).toHaveBeenCalledWith(DH_KEY, true)

    env.setOperating.mockReset()
    render({ isActive: false, browserToolCalls: [{ ...call, status: 'running' }] })
    expect(env.setOperating).not.toHaveBeenCalled()
  })
})
