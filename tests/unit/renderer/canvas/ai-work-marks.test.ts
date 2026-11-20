/**
 * The line at the top of an AI tab says, without buttons, whether the AI is
 * operating it, and whose work it is when that is not the conversation on
 * screen — named as people know it: a digital human's name or the
 * conversation's title.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const env = vi.hoisted(() => ({
  onScreen: 'conv-1' as string | null,
  currentSpaceId: 'space-1' as string | null,
  conversations: [{ id: 'conv-1', title: 'Fix the build' }, { id: 'conv-2', title: 'Release notes' }],
  apps: [{ id: 'app-9', spec: { name: 'Ops helper' } }],
  terminal: {} as Record<string, unknown>,
  browser: {} as Record<string, unknown>,
}))
vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../../src/renderer/api/transport', () => ({ isElectron: () => true }))
vi.mock('../../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { setTerminalTitle: vi.fn(), openTerminal: vi.fn(), closeTabsOfGoneView: vi.fn(), adoptPages: vi.fn() } }))
vi.mock('../../../../src/renderer/stores/chat.store', () => ({
  useChatStore: (select: (state: unknown) => unknown) => select({ spaceStates: new Map([['space-1', { conversations: env.conversations }]]) }),
  selectActiveConversationId: () => env.onScreen,
}))
vi.mock('../../../../src/renderer/stores/chat/active', () => ({ selectActiveConversationId: () => env.onScreen }))
vi.mock('../../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: (state: unknown) => unknown) => select({ apps: env.apps }) }))
// Server rendering reads a store's initial state, so the hooks read the test's state directly.
vi.mock('../../../../src/renderer/stores/terminal.store', () => ({
  useTerminalStore: Object.assign((select: (state: unknown) => unknown) => select(env.terminal), {
    setState: (patch: Record<string, unknown>) => Object.assign(env.terminal, patch),
  }),
}))
vi.mock('../../../../src/renderer/stores/ai-browser.store', async original => {
  const actual = await original<typeof import('../../../../src/renderer/stores/ai-browser.store')>()
  return {
    ...actual,
    useAIBrowserStore: Object.assign((select: (state: unknown) => unknown) => select(env.browser), {
      setState: (patch: Record<string, unknown> | ((state: any) => Record<string, unknown>)) =>
        Object.assign(env.browser, typeof patch === 'function' ? patch(env.browser) : patch),
    }),
  }
})
vi.mock('../../../../src/renderer/stores/space.store', () => ({
  useSpaceStore: (select: (state: unknown) => unknown) => select({ currentSpace: env.currentSpaceId ? { id: env.currentSpaceId } : null }),
}))

const { useTerminalStore } = await import('../../../../src/renderer/stores/terminal.store')
const { useAIBrowserStore } = await import('../../../../src/renderer/stores/ai-browser.store')
const { AIWorkStatusLine } = await import('../../../../src/renderer/components/canvas/AIWorkMarks')
const { useSpaceAIOperating } = await import('../../../../src/renderer/hooks/useAIWork')

const terminalTab = { type: 'terminal', terminalSessionId: 't1' } as const
const pageTab = { type: 'browser', browserViewId: 'p1' } as const
const line = (tab: object) => renderToStaticMarkup(createElement(AIWorkStatusLine, { tab: tab as never }))
const info = (id: string, spaceId = 'space-1') => ({ id, title: id, shell: 'zsh', cwd: '/', cols: 80, rows: 24, owner: 'ai', aiTouched: true, state: 'running', exitCode: null, lastActivityAt: 1, createdAt: 1, spaceId })

beforeEach(() => {
  env.onScreen = 'conv-1'
  env.currentSpaceId = 'space-1'
  useTerminalStore.setState({ sessions: new Map([['t1', info('t1') as never]]), operating: new Set(), operators: new Map([['t1', 'conv-1']]) })
  useAIBrowserStore.setState({
    pages: { p1: { viewId: 'p1', conversationId: 'conv-1', spaceId: 'space-1', url: null, title: null, lastActivityAt: 1 } },
    views: { 'conv-1': { viewId: 'p1', url: null, title: null, lastActivityAt: 1 } },
    operating: {},
  })
})

describe('the status line', () => {
  it('says idle, with a still dot, when the AI is not operating', () => {
    const markup = line(terminalTab)
    expect(markup).toContain('AI is idle')
    expect(markup).not.toContain('animate-pulse')
    expect(markup).not.toContain('<button')
  })

  it('says operating, with a pulsing dot that respects reduced motion, when it is', () => {
    useTerminalStore.setState({ operating: new Set(['t1']) })
    const markup = line(terminalTab)
    expect(markup).toContain('AI is operating')
    expect(markup).toContain('motion-safe:animate-pulse')
  })

  it('reads a page as operated only while its conversation operates that very page', () => {
    useAIBrowserStore.setState({ operating: { 'conv-1': true } })
    expect(line(pageTab)).toContain('AI is operating')
    useAIBrowserStore.setState(state => ({ views: { ...state.views, 'conv-1': { viewId: 'other', url: null, title: null, lastActivityAt: 1 } } }))
    expect(line(pageTab)).toContain('AI is idle')
  })

  it('names nobody when the work belongs to the conversation on screen', () => {
    expect(line(terminalTab)).not.toContain('·')
  })

  it('names the conversation by its title when it is another one', () => {
    env.onScreen = 'conv-2'
    expect(line(terminalTab)).toContain('· Fix the build')
  })

  it('names a digital human by its name, for its chat and for its runs', () => {
    useTerminalStore.setState({ operators: new Map([['t1', 'app-chat:app-9']]) })
    expect(line(terminalTab)).toContain('· Ops helper')
    useAIBrowserStore.setState(state => ({ pages: { p1: { ...state.pages.p1, conversationId: 'app-run:app-9:run-1' } } }))
    expect(line(pageTab)).toContain('· Ops helper')
  })

  it('names nobody for a terminal whose AI conversation is not known yet', () => {
    useTerminalStore.setState({ operators: new Map() })
    expect(line(terminalTab)).not.toContain('·')
  })
})

describe('the handle\'s dot', () => {
  const Probe = () => createElement('i', null, String(useSpaceAIOperating()))
  const probe = () => renderToStaticMarkup(createElement(Probe))

  it('is on only while the AI is operating a tab of the space on screen', () => {
    expect(probe()).toBe('<i>false</i>')
    useTerminalStore.setState({ operating: new Set(['t1']) })
    expect(probe()).toBe('<i>true</i>')
    env.currentSpaceId = 'space-2'
    expect(probe()).toBe('<i>false</i>')
  })

  it('counts the AI\'s page being operated too', () => {
    useAIBrowserStore.setState({ operating: { 'conv-1': true } })
    expect(probe()).toBe('<i>true</i>')
  })

  it('ignores a terminal that is no longer the AI\'s running work', () => {
    useTerminalStore.setState({ sessions: new Map([['t1', { ...info('t1'), state: 'exited' } as never]]), operating: new Set(['t1']) })
    expect(probe()).toBe('<i>false</i>')
  })
})
