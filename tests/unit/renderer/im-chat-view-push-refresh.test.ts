/**
 * An IM chat open in Halo shows a message the digital human pushes to it while
 * it is open (#150).
 *
 * A push lands in the chat's record outside any turn, and the view re-read the
 * record only when a turn started or ended: the push appeared once the chat was
 * opened again. The session update that announces it is now the cue.
 *
 * Opening the chat while its turn runs also picks that turn up — its steps so
 * far and a retry it is waiting on — instead of a bare "thinking".
 *
 * No DOM here: React's hooks are replaced by a small runner that runs the
 * effects whose dependencies changed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as unknown as Runner,
  generating: false,
  updateListeners: [] as Array<(data: unknown) => void>,
  api: {
    appImChatMessages: vi.fn(async () => ({ success: true, data: [{ id: 'session-msg-1', role: 'assistant', content: 'Hi', timestamp: '' }] })),
    onImSessionUpdated: vi.fn(),
    onAgentInputArrived: vi.fn(() => () => {}),
    onAgentInputStopped: vi.fn(() => () => {}),
    getSessionState: vi.fn(),
    appImChatStop: vi.fn(),
    appImChatClear: vi.fn(),
    appChatMessages: vi.fn(async () => ({ success: true, data: [{ id: 'session-msg-1', role: 'assistant', content: 'Shipped', timestamp: '' }] })),
    appChatStop: vi.fn(async () => ({ success: true })),
  },
}))

class Runner {
  values: unknown[] = []
  index = 0
  pending: Array<() => void> = []
  cleanups = new Map<number, () => void>()
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [this.values[index], (update: unknown) => {
      this.values[index] = typeof update === 'function' ? (update as (value: unknown) => unknown)(this.values[index]) : update
    }]
  }
  ref(initial: unknown) {
    const index = this.index++
    this.values[index] ??= { current: initial }
    return this.values[index]
  }
  effect(effect: () => void | (() => void), deps?: unknown[]) {
    const index = this.index++
    const previous = this.values[index] as unknown[] | undefined
    if (!deps || !previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
      this.pending.push(() => {
        this.cleanups.get(index)?.()
        const cleanup = effect()
        if (typeof cleanup === 'function') this.cleanups.set(index, cleanup)
        else this.cleanups.delete(index)
      })
    }
    this.values[index] = deps
  }
  /** Render, then run the effects that fire. */
  render<T>(component: () => T): T {
    this.index = 0
    this.pending = []
    env.runner = this
    const tree = component()
    for (const run of this.pending) run()
    return tree
  }
  unmount() {
    for (const cleanup of this.cleanups.values()) cleanup()
    this.cleanups.clear()
  }
}

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useRef: (initial: unknown) => env.runner.ref(initial),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => env.runner.effect(effect, deps),
}))

const chatState = {
  getSession: () => ({
    isGenerating: env.generating, streamingContent: '', isStreaming: false, thoughts: [], isThinking: false,
    error: null, errorType: null, compactInfo: null, textBlockVersion: 0,
  }),
  resetSession: vi.fn(),
  markSessionStopped: vi.fn(),
  handleAgentApiRetry: vi.fn(),
  recoverRunningTurn: vi.fn(async () => {}),
}

vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: Object.assign((select: (state: typeof chatState) => unknown) => select(chatState), { getState: () => chatState }),
  reconcileTranscript: (_cached: unknown[], fresh: unknown[]) => ({ messages: fresh, keptOlder: false }),
}))
vi.mock('../../../src/renderer/stores/team.store', () => ({ useTeamStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({ useAppsPageStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/engine.store', () => ({ useEngineCapabilities: () => ({}) }))
vi.mock('../../../src/renderer/components/chat/MessageList', () => ({ MessageList: function MessageList() { return null } }))
vi.mock('../../../src/renderer/components/chat/ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }))
vi.mock('../../../src/renderer/hooks/useConversationDetail', () => ({ useConversationDetail: () => {} }))
vi.mock('../../../src/renderer/hooks/useWsRecovery', () => ({ useWsRecovery: () => {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

import { ImChatView } from '../../../src/renderer/components/apps/ImChatView'
import type { ImSessionRecord } from '../../../src/shared/types/im-channel'

const session: ImSessionRecord = {
  appId: 'dh', channel: 'wecom-bot', source: 'im', instanceId: 'inst-1',
  chatId: 'ops-group', chatType: 'group', displayName: 'Ops', proactive: false, lastActiveAt: 1,
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** Open the chat, let its first read land, and hand back the announcement it listens to. */
async function openChat() {
  const runner = new Runner()
  runner.render(() => ImChatView({ appId: 'dh', spaceId: 'space-1', session }))
  await settle()
  env.api.appImChatMessages.mockClear()
  return { runner, announce: (data: unknown) => env.updateListeners.forEach(listener => listener(data)) }
}

beforeEach(() => {
  env.generating = false
  env.updateListeners = []
  env.api.onImSessionUpdated.mockImplementation((listener: (data: unknown) => void) => {
    env.updateListeners.push(listener)
    return () => { env.updateListeners = env.updateListeners.filter(l => l !== listener) }
  })
  env.api.appImChatMessages.mockClear()
  env.api.appImChatStop.mockClear()
  env.api.appImChatClear.mockClear()
  env.api.appChatMessages.mockClear()
  env.api.appChatStop.mockClear()
  chatState.recoverRunningTurn.mockClear()
})

describe('opening an IM chat in Halo', () => {
  it('picks up the turn running in it, once per chat', async () => {
    const runner = new Runner()
    const view = () => ImChatView({ appId: 'dh', spaceId: 'space-1', session })
    runner.render(view)
    runner.render(view)
    await settle()

    expect(chatState.recoverRunningTurn).toHaveBeenCalledOnce()
    expect(chatState.recoverRunningTurn).toHaveBeenCalledWith('app-chat:dh:wecom-bot:group:ops-group')

    runner.render(() => ImChatView({ appId: 'dh', spaceId: 'space-1', session: { ...session, chatId: 'sales-group' } }))
    expect(chatState.recoverRunningTurn).toHaveBeenLastCalledWith('app-chat:dh:wecom-bot:group:sales-group')
  })

  it('leaves a chat the team handles alone', () => {
    new Runner().render(() => ImChatView({
      appId: 'dh', spaceId: 'space-1', session: { ...session, teamContext: { teamId: 'team-1', epochId: 'epoch-1' } },
    }))

    expect(chatState.recoverRunningTurn).not.toHaveBeenCalled()
  })
})

describe('an IM chat open in Halo', () => {
  it('reads its record again when an update for this chat is announced', async () => {
    const { announce } = await openChat()

    announce({ appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', chatType: 'group', lastMessage: 'Nightly report' })
    await settle()

    expect(env.api.appImChatMessages).toHaveBeenCalledOnce()
    expect(env.api.appImChatMessages).toHaveBeenCalledWith('dh', 'space-1', 'wecom-bot', 'group', 'ops-group')
  })

  it('leaves its record alone for another chat, and while a turn of its own is running', async () => {
    const { announce } = await openChat()

    announce({ appId: 'dh', channel: 'wecom-bot', chatId: 'another-group' })
    announce({ appId: 'another-dh', channel: 'wecom-bot', chatId: 'ops-group' })
    announce({ appId: 'dh', channel: 'feishu-bot', chatId: 'ops-group' })
    env.generating = true
    announce({ appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group' })
    await settle()

    expect(env.api.appImChatMessages).not.toHaveBeenCalled()
  })

  it('listens while open, and stops once closed', async () => {
    const { runner } = await openChat()
    expect(env.updateListeners).toHaveLength(1)

    runner.unmount()

    expect(env.updateListeners).toHaveLength(0)
  })
})

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } }

/** The elements of a returned tree that match, without rendering child components. */
function findAll(tree: unknown, match: (node: Element) => boolean): Element[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Element
  return [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => findAll(child, match))]
}

/** The read-only bar of a chat opened in Halo, once its record is read. */
async function openBar(chat: ImSessionRecord): Promise<Element> {
  const runner = new Runner()
  const view = () => ImChatView({ appId: 'dh', spaceId: 'space-1', session: chat })
  runner.render(view)
  await settle()
  const [bar] = findAll(runner.render(view), node => typeof node.type === 'function' && (node.type as { name: string }).name === 'ImChatInfoBar')
  return bar
}

/** The buttons the bar draws with this title. */
const barButtons = (bar: Element, title: string) =>
  findAll((bar.type as (props: unknown) => unknown)(bar.props), node => node.type === 'button' && node.props.title === title)

// The remote transport reaches a remote call (HTTP API session) by its key on
// the chat routes; its im-chat routes take IM channels only (#454).
describe('a remote call open in Halo', () => {
  const remoteCall: ImSessionRecord = {
    appId: 'dh', channel: 'http', source: 'http', instanceId: '',
    chatId: 'order-42', chatType: 'direct', displayName: 'order-42', proactive: false, lastActiveAt: 1,
  }
  const key = 'app-chat:dh:http:direct:order-42'

  it('reads its record by its key, and picks up its running turn', async () => {
    new Runner().render(() => ImChatView({ appId: 'dh', spaceId: 'space-1', session: remoteCall }))
    await settle()

    expect(env.api.appChatMessages).toHaveBeenCalledWith('dh', 'space-1', key)
    expect(env.api.appImChatMessages).not.toHaveBeenCalled()
    expect(chatState.recoverRunningTurn).toHaveBeenCalledWith(key)
  })

  it('can be stopped while it runs, by its key', async () => {
    env.generating = true
    const bar = await openBar(remoteCall)
    expect(barButtons(bar, 'Stop generation')).toHaveLength(1)

    await (bar.props.onStopConfirm as () => Promise<void>)()

    expect(env.api.appChatStop).toHaveBeenCalledWith('dh', key)
    expect(env.api.appImChatStop).not.toHaveBeenCalled()
  })

  // Its context belongs to the backend that calls it, which would not know it
  // had been wiped.
  it('offers no clear, unlike an IM chat', async () => {
    expect(barButtons(await openBar(remoteCall), 'Clear session')).toHaveLength(0)
    expect(barButtons(await openBar(session), 'Clear session')).toHaveLength(1)
  })
})
