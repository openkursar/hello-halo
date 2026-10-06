/**
 * A run that did not start because a connection it declares is unusable says
 * so on the timeline in the user's language — which connection, why, and
 * where to fix it — instead of an English error and a process with nothing in it.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/stores/apps.store', () => {
  const state = { appStates: {}, continueApp: vi.fn() }
  const useAppsStore = (select: (value: typeof state) => unknown) => select(state)
  useAppsStore.getState = () => state
  return { useAppsStore }
})
vi.mock('../../../src/renderer/stores/apps-page.store', () => {
  const state = { openSessionDetail: vi.fn(), openAppConfigAt: vi.fn() }
  const useAppsPageStore = (select: (value: typeof state) => unknown) => select(state)
  useAppsPageStore.getState = () => state
  return { useAppsPageStore }
})
vi.mock('../../../src/renderer/hooks/useDataContent', () => ({ useDataContent: () => undefined }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => content }))
vi.mock('../../../src/renderer/components/apps/ActivitySource', () => ({ ActivitySource: () => null }))
vi.mock('../../../src/renderer/components/apps/EscalationCard', () => ({ EscalationCard: () => null }))
vi.mock('../../../src/renderer/components/apps/UpgradeNote', () => ({ UpgradeNote: () => null }))

import { ActivityEntryCard } from '../../../src/renderer/components/apps/ActivityEntryCard'

const notStarted: ActivityEntry = {
  id: 'entry-1', appId: 'app-1', runId: 'run-1', type: 'run_error', ts: 0, sessionKey: 'sk-1',
  content: {
    summary: 'Did not run: connections it declares are unavailable: "Team Docs" (not installed), "Mail" (turned off).',
    status: 'error',
    durationMs: 0,
    missingConnections: [
      { id: 'docs', name: 'Team Docs', state: 'not_installed' },
      { id: 'mail', name: 'Mail', state: 'disabled' },
    ],
  },
}

describe('ActivityEntryCard — a run short of a declared connection', () => {
  it('names each connection and why, and points to where to fix it', () => {
    const html = renderToStaticMarkup(createElement(ActivityEntryCard, { entry: notStarted, appId: 'app-1' }))

    expect(html).toContain('Not started')
    expect(html).toContain('This run did not start: a connection it needs is unavailable.')
    expect(html).toContain('Team Docs: not installed')
    expect(html).toContain('Mail: turned off')
    expect(html).toContain('Open Tools &amp; Resources')
    // Neither the English fallback nor a process view that has nothing in it.
    expect(html).not.toContain('Did not run:')
    expect(html).not.toContain('View process')
  })
})
