/**
 * "Only on mainland China working days" in a digital human's trigger settings:
 * the switch shows and changes the schedule's option, changing the time keeps
 * it, and a day the holiday calendar could not decide reads in the user's
 * language on the timeline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SubscriptionDef } from '../../../src/shared/apps/spec-types'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

const env = vi.hoisted(() => ({
  apps: [] as unknown[],
  updateAppSpec: vi.fn(async () => true),
  switches: [] as Array<{ checked: boolean; onCheckedChange: (checked: boolean) => void }>,
}))

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => ({ success: false })) }) }))
vi.mock('../../../src/renderer/stores/apps.store', () => {
  const state = () => ({
    apps: env.apps, updateAppSpec: env.updateAppSpec, updateAppConfig: vi.fn(), updateAppOverrides: vi.fn(), uninstallApp: vi.fn(),
    restartAppAgent: vi.fn(), exportApp: vi.fn(),
    activityEntries: {}, pendingEntries: {}, pendingHasMore: {}, activityHasMore: {}, activityErrors: {}, appStates: {}, continueApp: vi.fn(),
  })
  const useAppsStore = (select?: (value: ReturnType<typeof state>) => unknown) => select ? select(state()) : state()
  useAppsStore.getState = state
  return { useAppsStore }
})
vi.mock('../../../src/renderer/stores/apps-page.store', () => {
  const state = { openSessionDetail: vi.fn() }
  const useAppsPageStore = (select?: (value: typeof state) => unknown) => select ? select(state) : state
  useAppsPageStore.getState = () => state
  return { useAppsPageStore }
})
vi.mock('../../../src/renderer/stores/space.store', () => {
  const state = { spaces: [], currentSpace: null }
  const useSpaceStore = (select?: (value: typeof state) => unknown) => select ? select(state) : state
  useSpaceStore.getState = () => state
  return { useSpaceStore }
})
vi.mock('../../../src/renderer/stores/app.store', () => {
  const state = { config: null }
  const useAppStore = (select?: (value: typeof state) => unknown) => select ? select(state) : state
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('../../../src/renderer/components/ui/Switch', () => ({
  Switch: (props: { checked: boolean; onCheckedChange: (checked: boolean) => void }) => {
    env.switches.push(props)
    return createElement('i', { 'data-switch': env.switches.length - 1 })
  },
}))
for (const path of [
  'AppModelSelector', 'AppNotifyChannelsSection', 'AppCapabilitiesSection', 'AppMcpDepsSection', 'AppSkillsSection',
  'AppSettingsNav', 'AppBotBindingSection', 'AppExternalChannelsCard', 'AppKnowledgeSection', 'SystemPromptEditor', 'SchedulePicker',
]) {
  vi.doMock(`../../../src/renderer/components/apps/${path}`, () => ({ [path]: () => null }))
}
vi.mock('../../../src/renderer/components/memory/MemorySettingsPanel', () => ({ MemorySettingsPanel: () => null }))
vi.mock('../../../src/renderer/components/common/HttpTriggerCard', () => ({ HttpTriggerCard: () => null }))
vi.mock('../../../src/renderer/hooks/useDataContent', () => ({ useDataContent: () => undefined }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => content }))
vi.mock('../../../src/renderer/components/apps/ActivitySource', () => ({ ActivitySource: () => null }))
vi.mock('../../../src/renderer/components/apps/EscalationCard', () => ({ EscalationCard: () => null }))
vi.mock('../../../src/renderer/components/apps/UpgradeNote', () => ({ UpgradeNote: () => null }))

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const { applyScheduleValue, applyWorkdayCalendar } = await import('../../../src/renderer/components/apps/schedule-utils')
const { AppConfigPanel } = await import('../../../src/renderer/components/apps/AppConfigPanel')
const { ActivityEntryCard } = await import('../../../src/renderer/components/apps/ActivityEntryCard')

const LABEL = 'Only on mainland China working days'

function schedule(config: Record<string, unknown>): SubscriptionDef {
  return { id: 'daily', source: { type: 'schedule', config } } as SubscriptionDef
}

function installApp(subscriptions: SubscriptionDef[]): void {
  env.apps = [{
    id: 'app-1', specId: 'daily-report', spaceId: 'space-1', status: 'active', installedAt: 0,
    spec: { spec_version: '1', name: 'Daily report', version: '1.0', author: 'Halo', description: 'Writes the daily report', type: 'automation', system_prompt: 'Write it.', subscriptions },
    userConfig: {}, userOverrides: {}, permissions: { granted: [], denied: [] },
  }]
}

/** The panel's markup, and the switch that sits beside the working-days label. */
function renderPanel(): { html: string; workdaySwitch?: (typeof env.switches)[number] } {
  env.switches = []
  const html = renderToStaticMarkup(createElement(AppConfigPanel, { appId: 'app-1' }))
  const index = html.indexOf(LABEL)
  const match = index < 0 ? null : html.slice(index).match(/data-switch="(\d+)"/)
  return { html, workdaySwitch: match ? env.switches[Number(match[1])] : undefined }
}

beforeEach(() => {
  env.updateAppSpec.mockClear()
})

describe('schedule settings', () => {
  it('keeps the working-days option when the time changes', () => {
    const updated = applyScheduleValue(schedule({ cron: '0 9 * * *', workday_calendar: true }), { type: 'cron', cron: '30 8 * * *' })

    expect(updated.source).toEqual({ type: 'schedule', config: { cron: '30 8 * * *', workday_calendar: true } })
  })

  it('adds and removes the option without touching the time', () => {
    const on = applyWorkdayCalendar(schedule({ every: '1h' }), true)
    expect(on.source).toEqual({ type: 'schedule', config: { every: '1h', workday_calendar: true } })
    expect(applyWorkdayCalendar(on, false).source).toEqual({ type: 'schedule', config: { every: '1h' } })
  })

  it('shows the option beside the schedule, on when the schedule has it, and turns it off', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    const { html, workdaySwitch } = renderPanel()

    expect(html).toContain('Set the schedule to run every day; the holiday calendar decides which days count.')
    expect(workdaySwitch?.checked).toBe(true)

    await workdaySwitch?.onCheckedChange(false)
    expect(env.updateAppSpec).toHaveBeenCalledWith('app-1', { subscriptions: [schedule({ cron: '0 9 * * *' })] })
  })

  it('turns the option on for a schedule without it', async () => {
    installApp([schedule({ cron: '0 9 * * *' })])
    const { workdaySwitch } = renderPanel()

    expect(workdaySwitch?.checked).toBe(false)
    await workdaySwitch?.onCheckedChange(true)
    expect(env.updateAppSpec).toHaveBeenCalledWith('app-1', { subscriptions: [schedule({ cron: '0 9 * * *', workday_calendar: true })] })
  })

  it('does not offer the option without a schedule', () => {
    installApp([])

    expect(renderPanel().html).not.toContain(LABEL)
  })
})

describe('timeline', () => {
  it('says in the user’s language that the calendar did not cover the day', () => {
    const entry: ActivityEntry = {
      id: 'e1', appId: 'app-1', runId: 'run-1', sessionKey: 'sk-1', type: 'run_skipped', ts: 0,
      content: { summary: 'text stored by the runtime', status: 'skipped', workdayCalendarGap: true },
    }
    const html = renderToStaticMarkup(createElement(ActivityEntryCard, { entry, appId: 'app-1' }))

    expect(html).toContain('The holiday calendar does not cover today, so this scheduled run was skipped. Run it manually if needed.')
    expect(html).not.toContain('text stored by the runtime')
  })
})
