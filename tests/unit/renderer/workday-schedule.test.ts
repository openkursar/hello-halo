/**
 * "Only on mainland China working days" in a digital human's trigger settings:
 * the switch is offered to people likely in mainland China (and wherever it is
 * already on), shows and changes the schedule's option, changing the time
 * keeps it, and a day the holiday calendar could not decide reads in the
 * user's language on the timeline.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, isValidElement, type DependencyList, type EffectCallback, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SubscriptionDef } from '../../../src/shared/apps/spec-types'
import type { ActivityEntry, InstalledApp } from '../../../src/shared/apps/app-types'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

const env = vi.hoisted(() => ({
  runner: null as HookRunner | null,
  apps: [] as InstalledApp[],
  language: 'en',
  timeZone: 'Europe/Berlin',
  updateAppSpec: vi.fn<[appId: string, patch: { subscriptions: SubscriptionDef[] }], Promise<boolean>>(),
}))

class HookRunner {
  private values: unknown[] = []
  private dependencies: Array<DependencyList | undefined> = []
  private cleanups: Array<(() => void) | undefined> = []
  private pendingEffects: Array<() => void> = []
  private index = 0
  private dirty = false

  state<T>(initial: T | (() => T)) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial
    return [this.values[index] as T, (update: T | ((previous: T) => T)) => {
      const next = typeof update === 'function' ? (update as (previous: T) => T)(this.values[index] as T) : update
      if (!Object.is(this.values[index], next)) this.dirty = true
      this.values[index] = next
    }] as const
  }

  effect(effect: EffectCallback, deps?: DependencyList) {
    const index = this.index++
    const previous = this.dependencies[index]
    if (deps && previous && deps.length === previous.length && deps.every((value, i) => Object.is(value, previous[i]))) return
    this.pendingEffects.push(() => {
      this.dependencies[index] = deps
      this.cleanups[index]?.()
      this.cleanups[index] = effect() || undefined
    })
  }

  render<T>(component: () => T): T {
    for (let attempt = 0; attempt < 25; attempt++) {
      this.index = 0
      this.dirty = false
      this.pendingEffects = []
      env.runner = this
      let tree: T
      try {
        tree = component()
      } finally {
        env.runner = null
      }
      const effects = this.pendingEffects
      if (this.dirty) continue
      effects.forEach(effect => effect())
      if (!this.dirty) return tree
    }
    throw new Error('Component did not settle')
  }

  unmount() {
    this.cleanups.forEach(cleanup => cleanup?.())
    this.cleanups = []
  }
}

vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => env.runner ? env.runner.state(initial) : actual.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) => env.runner ? env.runner.effect(effect, deps) : actual.useEffect(effect, deps),
    useCallback: (callback: () => unknown, deps: DependencyList) => env.runner ? callback : actual.useCallback(callback, deps),
  }
})

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: env.language } }),
  getCurrentLanguage: () => env.language,
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

const { applyScheduleValue, applyWorkdayCalendar, offersWorkdayCalendar } = await import('../../../src/renderer/components/apps/schedule-utils')
const { AppConfigPanel } = await import('../../../src/renderer/components/apps/AppConfigPanel')
const { ActivityEntryCard } = await import('../../../src/renderer/components/apps/ActivityEntryCard')
const { Switch } = await import('../../../src/renderer/components/ui/Switch')

const LABEL = 'Only on mainland China working days'

function schedule(config: Record<string, unknown>): SubscriptionDef {
  return { id: 'daily', source: { type: 'schedule', config } } as SubscriptionDef
}

function installApp(subscriptions: SubscriptionDef[], appId = 'app-1'): void {
  env.apps.push({
    id: appId, specId: 'daily-report', spaceId: 'space-1', status: 'active', installedAt: 0,
    spec: { spec_version: '1', name: 'Daily report', version: '1.0', author: 'Halo', description: 'Writes the daily report', type: 'automation', system_prompt: 'Write it.', subscriptions },
    userConfig: {}, userOverrides: {}, permissions: { granted: [], denied: [] },
    upgradeStrategy: 'auto', knowledgeSeeded: false,
  })
}

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>

function nodes(tree: ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!isValidElement(tree)) return []
  const node = tree as Node
  return [node, ...nodes(node.props.children)]
}

function text(tree: ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  return isValidElement(tree) ? text((tree as Node).props.children) : ''
}

function workdaySwitch(tree: ReactNode) {
  const row = nodes(tree).find(node => text(node).includes(LABEL)
    && [node.props.children].flat().some(child => isValidElement(child) && child.type === Switch))
  return nodes(row).find(node => node.type === Switch) as ReactElement<Parameters<typeof Switch>[0]> | undefined
}

const panels: Array<{ unmount: () => void }> = []

function mountPanel(initialAppId = 'app-1') {
  const runner = new HookRunner()
  let settingsRunner: HookRunner | undefined
  let settingsIdentity: Pick<Node, 'type' | 'key'> | undefined
  let appId = initialAppId
  let panelTree: ReactNode
  let tree: ReactNode

  const panel = {
    render(nextAppId = appId) {
      appId = nextAppId
      panelTree = runner.render(() => AppConfigPanel({ appId }))
      const settings = nodes(panelTree).find(node => 'onRestartAgent' in node.props)
      if (settings?.type !== settingsIdentity?.type || settings?.key !== settingsIdentity?.key) {
        settingsRunner?.unmount()
        settingsRunner = settings ? new HookRunner() : undefined
        settingsIdentity = settings ? { type: settings.type, key: settings.key } : undefined
      }
      tree = settings && settingsRunner
        ? settingsRunner.render(() => (settings.type as (props: Node['props']) => ReactNode)(settings.props))
        : null
      return { text: text(tree), workdaySwitch: workdaySwitch(tree)?.props }
    },
    selectTab(label: string) {
      const button = nodes(panelTree).find(node => node.type === 'button' && text(node).trim() === label)
      expect(button).toBeDefined()
      button!.props.onClick!()
      return panel.render()
    },
    async toggleWorkday() {
      const control = workdaySwitch(tree)
      expect(control).toBeDefined()
      await control!.props.onCheckedChange(!control!.props.checked)
      return panel.render()
    },
    unmount() {
      settingsRunner?.unmount()
      settingsRunner = undefined
      settingsIdentity = undefined
      runner.unmount()
    },
  }
  panels.push(panel)
  return panel
}

// The panel reads the machine's time zone; each test picks one so the result
// does not depend on where the suite runs.
const machineResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
const timeZoneSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
  .mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...machineResolvedOptions.call(this), timeZone: env.timeZone }
  })

beforeEach(() => {
  env.apps = []
  env.updateAppSpec.mockReset().mockImplementation(async (appId, patch) => {
    env.apps = env.apps.map(app => app.id === appId && app.spec.type === 'automation'
      ? { ...app, spec: { ...app.spec, ...patch } }
      : app)
    return true
  })
  env.language = 'en'
  env.timeZone = 'Europe/Berlin'
  vi.stubGlobal('document', { getElementById: () => null })
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  panels.splice(0).forEach(panel => panel.unmount())
  vi.unstubAllGlobals()
})

afterAll(() => {
  timeZoneSpy.mockRestore()
})

describe('who is offered the option', () => {
  const plain = schedule({ cron: '0 9 * * *' })

  it('offers it in Simplified Chinese, wherever the machine is', () => {
    expect(offersWorkdayCalendar(plain, 'zh-CN', 'Europe/Berlin')).toBe(true)
  })

  it('offers it on a mainland China time zone in any language', () => {
    expect(offersWorkdayCalendar(plain, 'en', 'Asia/Shanghai')).toBe(true)
    expect(offersWorkdayCalendar(plain, 'ja', 'Asia/Urumqi')).toBe(true)
  })

  it('does not offer it elsewhere, Taiwan and Hong Kong included', () => {
    expect(offersWorkdayCalendar(plain, 'en', 'Europe/Berlin')).toBe(false)
    expect(offersWorkdayCalendar(plain, 'zh-TW', 'Asia/Taipei')).toBe(false)
    expect(offersWorkdayCalendar(plain, 'zh-TW', 'Asia/Hong_Kong')).toBe(false)
  })

  it('keeps offering it where it is already on, so it can be turned off', () => {
    expect(offersWorkdayCalendar(schedule({ cron: '0 9 * * *', workday_calendar: true }), 'en', 'Europe/Berlin')).toBe(true)
  })

  it('reads the machine time zone when none is given', () => {
    env.timeZone = 'Asia/Shanghai'
    expect(offersWorkdayCalendar(plain, 'en')).toBe(true)
    env.timeZone = 'America/New_York'
    expect(offersWorkdayCalendar(plain, 'en')).toBe(false)
  })
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

  it('keeps the switch visible outside mainland China after saving off, so it can be turned back on', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    const panel = mountPanel()
    const initial = panel.render()

    expect(initial.text).toContain('Set the schedule to run every day; the holiday calendar decides which days count.')
    expect(initial.workdaySwitch?.checked).toBe(true)

    const disabled = await panel.toggleWorkday()
    expect(env.updateAppSpec).toHaveBeenLastCalledWith('app-1', { subscriptions: [schedule({ cron: '0 9 * * *' })] })
    expect(disabled.text).toContain(LABEL)
    expect(disabled.workdaySwitch?.checked).toBe(false)
    expect(panel.render().workdaySwitch?.checked).toBe(false)

    const enabled = await panel.toggleWorkday()
    expect(env.updateAppSpec).toHaveBeenLastCalledWith('app-1', { subscriptions: [schedule({ cron: '0 9 * * *', workday_calendar: true })] })
    expect(enabled.workdaySwitch?.checked).toBe(true)
    expect(env.updateAppSpec).toHaveBeenCalledTimes(2)
  })

  it('forgets visibility after closing and reopening the panel', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    const panel = mountPanel()
    panel.render()
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(false)
    panel.unmount()

    const reopened = mountPanel().render()
    expect(reopened.workdaySwitch).toBeUndefined()
    expect(reopened.text).not.toContain(LABEL)
  })

  it('does not carry visibility to another app even when the panel is reused', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    installApp([schedule({ cron: '0 10 * * *' })], 'app-2')
    const panel = mountPanel()
    panel.render()
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(false)

    expect(panel.render('app-2').workdaySwitch).toBeUndefined()
    expect(panel.render('app-1').workdaySwitch).toBeUndefined()
    expect(env.updateAppSpec).toHaveBeenCalledTimes(1)
  })

  it('retains visibility while switching between settings and YAML in the same panel', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    const panel = mountPanel()
    panel.render()
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(false)

    panel.selectTab('YAML')
    expect(panel.selectTab('Settings').workdaySwitch?.checked).toBe(false)
  })

  it('resets visibility when the app changes while the YAML tab is open', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    installApp([schedule({ cron: '0 10 * * *' })], 'app-2')
    const panel = mountPanel()
    panel.render()
    await panel.toggleWorkday()
    panel.selectTab('YAML')

    panel.render('app-2')
    expect(panel.selectTab('Settings').workdaySwitch).toBeUndefined()
    expect(panel.render('app-1').workdaySwitch).toBeUndefined()
  })

  it('hides the switch when the schedule is removed and retains eligibility when it is added back', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    const panel = mountPanel()
    panel.render()
    await panel.toggleWorkday()

    await env.updateAppSpec('app-1', { subscriptions: [] })
    expect(panel.render().workdaySwitch).toBeUndefined()
    await env.updateAppSpec('app-1', { subscriptions: [schedule({ every: '1h' })] })
    expect(panel.render().workdaySwitch?.checked).toBe(false)
  })

  it('remembers the option if it first becomes visible during the open panel', async () => {
    installApp([schedule({ cron: '0 9 * * *' })])
    const panel = mountPanel()
    expect(panel.render().workdaySwitch).toBeUndefined()

    await env.updateAppSpec('app-1', { subscriptions: [schedule({ cron: '0 9 * * *', workday_calendar: true })] })
    expect(panel.render().workdaySwitch?.checked).toBe(true)
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(false)
  })

  it('keeps the saved value and a usable control when either save fails', async () => {
    installApp([schedule({ cron: '0 9 * * *', workday_calendar: true })])
    const panel = mountPanel()
    panel.render()

    env.updateAppSpec.mockResolvedValueOnce(false)
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(true)
    expect(env.updateAppSpec).toHaveBeenLastCalledWith('app-1', { subscriptions: [schedule({ cron: '0 9 * * *' })] })
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(false)

    env.updateAppSpec.mockResolvedValueOnce(false)
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(false)
    expect(env.updateAppSpec).toHaveBeenLastCalledWith('app-1', { subscriptions: [schedule({ cron: '0 9 * * *', workday_calendar: true })] })
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(true)
  })

  it.each([
    ['zh-CN', 'Europe/Berlin'],
    ['en', 'Asia/Shanghai'],
    ['ja', 'Asia/Urumqi'],
  ])('still offers an unchecked switch for %s in %s and saves both ways', async (language, timeZone) => {
    env.language = language
    env.timeZone = timeZone
    installApp([schedule({ cron: '0 9 * * *' })])
    const panel = mountPanel()

    expect(panel.render().workdaySwitch?.checked).toBe(false)
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(true)
    expect(env.updateAppSpec).toHaveBeenLastCalledWith('app-1', { subscriptions: [schedule({ cron: '0 9 * * *', workday_calendar: true })] })
    expect((await panel.toggleWorkday()).workdaySwitch?.checked).toBe(false)
    panel.unmount()
    expect(mountPanel().render().workdaySwitch?.checked).toBe(false)
  })

  it('does not offer the option without a schedule', () => {
    env.language = 'zh-CN'
    installApp([])

    const view = mountPanel().render()
    expect(view.workdaySwitch).toBeUndefined()
    expect(view.text).not.toContain(LABEL)
  })

  it('hides the option from people outside mainland China when it was never on', () => {
    installApp([schedule({ cron: '0 9 * * *' })])
    const panel = mountPanel()

    expect(panel.render().workdaySwitch).toBeUndefined()
    expect(panel.render().text).not.toContain(LABEL)
    expect(env.updateAppSpec).not.toHaveBeenCalled()
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
