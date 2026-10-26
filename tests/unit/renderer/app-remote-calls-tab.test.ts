/**
 * A digital human called through Halo's HTTP API shows those calls on its own
 * page (#454): the sessions tab is named "IM / Remote", exists for a digital
 * human with remote calls and no bot, and lists the calls as a group of their
 * own beside its bots.
 *
 * Rendered to static markup; the registry feed, the bot list and the views
 * behind a selection are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const env = vi.hoisted(() => ({
  records: [] as unknown[],
  feedLoading: false,
  instances: [] as unknown[],
  instancesLoading: false,
  app: null as unknown,
  page: {} as Record<string, unknown>,
  statuses: new Map<string, string>(),
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))
vi.mock('../../../src/renderer/stores/app-chat-sessions', () => ({
  acquireAppChatSessions: () => () => {},
  subscribeAppChatSessions: () => () => {},
  getAppChatSessions: () => env.records,
  isAppChatSessionsLoading: () => env.feedLoading,
}))
vi.mock('../../../src/renderer/hooks/useAppImInstances', () => ({
  useAppImInstances: () => ({ instances: env.instances, loading: env.instancesLoading }),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: (select?: (state: unknown) => unknown) => {
    const state = { apps: env.app ? [env.app] : [], appStates: {} }
    return select ? select(state) : state
  },
}))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({
  useAppsPageStore: Object.assign(
    (select?: (state: unknown) => unknown) => (select ? select(env.page) : env.page),
    { getState: () => env.page },
  ),
}))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useConversationTaskStatus: (conversationId: string) => env.statuses.get(conversationId) ?? 'idle',
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/utils/spec-i18n', () => ({ resolveSpecI18n: (spec: unknown) => spec }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({ spaces: [] }) } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ openDigitalHumanChat: vi.fn(), navigateToAppChat: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({ useConfirmDialog: () => ({ showConfirm: vi.fn(), DialogComponent: null }) }))
vi.mock('../../../src/renderer/components/store/ShareCurrentAppDialog', () => ({ ShareCurrentAppDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/WorkspaceMigrationDialog', () => ({ WorkspaceMigrationDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/components/apps/AppBotSessionsView', async () => {
  const { createElement: h } = await import('react')
  return { AppBotSessionsView: ({ instanceId }: { instanceId: string }) => h('section', { 'data-bot-sessions': instanceId }) }
})
vi.mock('../../../src/renderer/components/apps/ImSessionDetailView', async () => {
  const { createElement: h } = await import('react')
  return { ImSessionDetailView: ({ session }: { session: { chatId: string } }) => h('section', { 'data-transcript': session.chatId }) }
})

import { AutomationHeader } from '../../../src/renderer/components/apps/AutomationHeader'
import { AppSessionsView } from '../../../src/renderer/components/apps/AppSessionsView'

const APP = 'concierge'

const remoteCall = (chatId: string, over: Record<string, unknown> = {}) => ({
  appId: APP, channel: 'http', source: 'http', instanceId: '', chatId, chatType: 'direct',
  displayName: chatId, proactive: false, lastActiveAt: 1_000, messageCount: 1, ...over,
})

const bot = { id: 'bot-uuid-1', type: 'wecom-bot', ordinal: 1, appId: APP, connected: true }

const header = () => renderToStaticMarkup(createElement(AutomationHeader, { appId: APP }))
const sessions = () => renderToStaticMarkup(createElement(AppSessionsView, { appId: APP, spaceId: 'space-1' }))

beforeEach(() => {
  env.records = []
  env.feedLoading = false
  env.instances = []
  env.instancesLoading = false
  env.statuses = new Map()
  env.app = {
    id: APP, spaceId: 'space-1', status: 'active',
    spec: { type: 'automation', name: 'Concierge' },
    permissions: { granted: [], denied: [] },
  }
  env.page = {
    detailView: { type: 'activity-thread', appId: APP },
    openAppConfig: vi.fn(), openActivityThread: vi.fn(), openAppTeams: vi.fn(),
    openAppSessions: vi.fn(), selectApp: vi.fn(), openAppConfigAt: vi.fn(),
  }
})

describe('the sessions tab of a digital human', () => {
  it('is named IM / Remote and exists for a digital human that only has remote calls', () => {
    env.records = [remoteCall('order-42')]

    expect(header()).toContain('IM / Remote')
  })

  it('keeps that name for a digital human with a bound bot', () => {
    env.instances = [bot]

    const html = header()
    expect(html).toContain('IM / Remote')
    expect(html).not.toContain('IM sessions')
  })

  it('does not exist without a bot or a remote call of its own', () => {
    env.records = [
      remoteCall('elsewhere', { appId: 'another-app' }),
      { ...remoteCall('my-chat'), channel: 'local', source: 'local' },
      { ...remoteCall('wecom-chat'), channel: 'wecom-bot', source: 'im' },
    ]

    expect(header()).not.toContain('IM / Remote')
  })

  it('does not exist for a digital human without a workspace', () => {
    env.app = { ...(env.app as object), spaceId: null }
    env.records = [remoteCall('order-42')]

    expect(header()).not.toContain('IM / Remote')
  })
})

describe('what the IM / Remote tab lists', () => {
  it('shows the remote calls of a digital human without a bot instead of asking to bind one', () => {
    env.records = [remoteCall('order-41', { lastActiveAt: 1_000 }), remoteCall('order-42', { lastActiveAt: 2_000 })]

    const html = sessions()
    expect(html).toContain('order-41')
    expect(html).toContain('order-42')
    expect(html).not.toContain('No bot bound yet')
  })

  it('offers the remote calls as a group of their own beside the bots', () => {
    env.instances = [bot]
    env.records = [remoteCall('order-42')]

    const html = sessions()
    expect(html).toContain('WeCom bot 1')
    expect(html).toContain('Remote calls')
    // The first group stays the one shown, as before.
    expect(html).toContain('data-bot-sessions="bot-uuid-1"')
  })

  it('looks as before for a digital human with a bot and no remote calls', () => {
    env.instances = [bot]

    const html = sessions()
    expect(html).not.toContain('Remote calls')
    expect(html).toContain('data-bot-sessions="bot-uuid-1"')
  })

  it('still points to binding a bot when there is nothing to list', () => {
    expect(sessions()).toContain('No bot bound yet')
  })
})

// The group the tab opens on must not change once shown: a call clicked in a
// list that then gives way to another group is lost.
describe('while its lists are still being read', () => {
  it('waits for the bot list before showing a group, so the remote calls do not give way to the first bot', () => {
    env.instancesLoading = true
    env.records = [remoteCall('order-42')]

    const first = sessions()
    expect(first).toContain('animate-spin')
    expect(first).not.toContain('order-42')

    env.instancesLoading = false
    env.instances = [bot]

    expect(sessions()).toContain('data-bot-sessions="bot-uuid-1"')
  })

  it('shows the remote calls of a digital human without a bot once its bot list is known', () => {
    env.instancesLoading = true
    env.records = [remoteCall('order-42')]
    expect(sessions()).not.toContain('order-42')

    env.instancesLoading = false

    expect(sessions()).toContain('order-42')
  })

  it('keeps the first bot shown when the remote calls are read after it', () => {
    env.instances = [bot]
    env.feedLoading = true

    expect(sessions()).toContain('data-bot-sessions="bot-uuid-1"')

    env.feedLoading = false
    env.records = [remoteCall('order-42')]

    const html = sessions()
    expect(html).toContain('Remote calls')
    expect(html).toContain('data-bot-sessions="bot-uuid-1"')
  })
})
