/**
 * What the user sees of a long automation run: while it goes, when it started,
 * how long it has been going, and that the person's scheduled times are being
 * skipped meanwhile; once it ends, how many were skipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityEntry, AutomationAppState } from '../../../src/shared/apps/app-types'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

const env = vi.hoisted(() => ({ appState: undefined as AutomationAppState | undefined }))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/stores/apps.store', () => {
  const state = () => ({
    activityEntries: {}, pendingEntries: {}, pendingHasMore: {}, activityHasMore: {}, activityErrors: {},
    appStates: { 'app-1': env.appState }, continueApp: vi.fn(),
  })
  const useAppsStore = (select: (value: ReturnType<typeof state>) => unknown) => select(state())
  useAppsStore.getState = state
  return { useAppsStore }
})
vi.mock('../../../src/renderer/stores/apps-page.store', () => {
  const state = { openSessionDetail: vi.fn() }
  const useAppsPageStore = (select: (value: typeof state) => unknown) => select(state)
  useAppsPageStore.getState = () => state
  return { useAppsPageStore }
})
vi.mock('../../../src/renderer/stores/people-view.store', () => {
  const state = { focusEntry: null, scrolls: {}, saveScroll: vi.fn() }
  const usePeopleViewStore = (select: (value: typeof state) => unknown) => select(state)
  usePeopleViewStore.getState = () => state
  usePeopleViewStore.setState = vi.fn()
  return { usePeopleViewStore }
})
vi.mock('../../../src/renderer/hooks/useDataContent', () => ({ useDataContent: () => undefined }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => content }))
vi.mock('../../../src/renderer/components/apps/ActivitySource', () => ({ ActivitySource: () => null }))
vi.mock('../../../src/renderer/components/apps/EscalationCard', () => ({ EscalationCard: () => null }))
vi.mock('../../../src/renderer/components/apps/UpgradeNote', () => ({ UpgradeNote: () => null }))
vi.mock('../../../src/renderer/components/apps/BlockedCard', () => ({ BlockedCard: () => null }))
vi.mock('../../../src/renderer/components/apps/RunsSummaryBand', () => ({ RunsSummaryBand: () => null }))
vi.mock('../../../src/renderer/components/apps/PersonTeamWork', () => ({ PersonTeamWork: () => null }))

import { RunningSince } from '../../../src/renderer/components/apps/RunningSince'
import { ActivityEntryCard } from '../../../src/renderer/components/apps/ActivityEntryCard'
import { ActivityThread } from '../../../src/renderer/components/apps/ActivityThread'

const NOW = new Date(2026, 9, 6, 10, 10, 0).getTime()
const MIN = 60_000

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  env.appState = undefined
})

describe('RunningSince', () => {
  it('shows when the run started and how long it has been going', () => {
    const html = renderToStaticMarkup(createElement(RunningSince, { startedAt: NOW - 70 * MIN }))

    expect(html).toContain('Started at ')
    expect(html).toContain('running for 1:10:00')
  })
})

describe('ActivityThread in-progress card', () => {
  const running: AutomationAppState = {
    status: 'running', runningAtMs: NOW - 70 * MIN, runningRunId: 'run-1', runningSessionKey: 'sk-1', nextRunAtMs: NOW + 5 * MIN,
  }

  it('shows the start, the running time and that scheduled times are skipped meanwhile', () => {
    env.appState = running
    const html = renderToStaticMarkup(createElement(ActivityThread, { appId: 'app-1' }))

    expect(html).toContain('running for 1:10:00')
    expect(html).toContain('Scheduled runs that come due meanwhile are skipped.')
    expect(html).toContain('Stop this execution')
  })

  it('does not mention skipped schedules for a person without any', () => {
    env.appState = { ...running, nextRunAtMs: undefined }
    const html = renderToStaticMarkup(createElement(ActivityThread, { appId: 'app-1' }))

    expect(html).toContain('running for 1:10:00')
    expect(html).not.toContain('Scheduled runs that come due meanwhile are skipped.')
  })
})

describe('ActivityEntryCard', () => {
  function entry(skippedSchedules?: number): ActivityEntry {
    return {
      id: 'entry-1', appId: 'app-1', runId: 'run-1', type: 'run_complete', ts: NOW, sessionKey: 'sk-1',
      content: { summary: 'Checked the prices.', status: 'ok', durationMs: 50 * MIN, skippedSchedules },
    }
  }

  function render(value: ActivityEntry): string {
    return renderToStaticMarkup(createElement(ActivityEntryCard, { entry: value, appId: 'app-1' }))
  }

  it('says how many scheduled runs were skipped while the run went on', () => {
    expect(render(entry(3))).toContain('3 scheduled runs came due during this run and were skipped.')
    expect(render(entry(1))).toContain('1 scheduled run came due during this run and was skipped.')
  })

  it('says nothing about skipped runs when none were', () => {
    expect(render(entry())).not.toContain('scheduled run')
  })
})
