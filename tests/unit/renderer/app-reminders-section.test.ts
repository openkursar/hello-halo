/**
 * A digital human's page lists the reminders it set in its conversations —
 * what each is for, when it comes due, where it returns and who asked — and
 * cancels one in place.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationReminderView } from '../../../src/shared/apps/conversation-reminders'

const env = vi.hoisted(() => ({
  runner: null as unknown as HookRunner,
  api: { appListReminders: vi.fn(), appCancelReminder: vi.fn() },
}))

class HookRunner {
  values: unknown[] = []
  index = 0
  effects: Array<() => void> = []
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [this.values[index], (update: unknown) => {
      this.values[index] = typeof update === 'function' ? (update as (value: unknown) => unknown)(this.values[index]) : update
    }]
  }
  render<T>(component: () => T): T {
    this.index = 0
    this.effects = []
    env.runner = this
    return component()
  }
}

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void) => { env.runner.effects.push(effect) },
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')),
  }),
  getCurrentLanguage: () => 'en',
}))

import { AppRemindersSection } from '../../../src/renderer/components/apps/AppRemindersSection'

type Node = { type?: unknown; props?: { children?: unknown; onClick?: () => void } }

function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}

function text(tree: unknown): string {
  return nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string').join(' ')
}

const NOW = new Date(2026, 9, 6, 10, 30).getTime()

const REMINDERS: ConversationReminderView[] = [
  {
    id: 'r-1', appId: 'app-1', conversationId: 'app-chat:app-1:wecom-bot:group:g-1',
    conversation: { kind: 'im', name: 'Ops group' }, message: 'Tell the group the hour is up.',
    schedule: { kind: 'once', at: NOW + 3_600_000 }, nextAt: NOW + 3_600_000, createdAt: NOW, setBy: 'Li',
  },
  {
    id: 'r-2', appId: 'app-1', conversationId: 'app-chat:app-1',
    conversation: { kind: 'default' }, message: 'Drink water.',
    schedule: { kind: 'every', every: '2h' }, nextAt: NOW + 7_200_000, createdAt: NOW,
  },
]

/** Render, run the effects (the list load), let it settle, render again. */
async function open(runner = new HookRunner()): Promise<{ runner: HookRunner; tree: unknown }> {
  const view = () => AppRemindersSection({ appId: 'app-1' })
  runner.render(view)
  for (const effect of runner.effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  return { runner, tree: runner.render(view) }
}

describe('AppRemindersSection', () => {
  beforeEach(() => {
    env.api.appListReminders.mockReset().mockResolvedValue({ success: true, data: REMINDERS })
    env.api.appCancelReminder.mockReset().mockResolvedValue({ success: true })
  })

  it('lists each reminder with when it is due, where it returns and who asked', async () => {
    const { tree } = await open()
    const shown = text(tree)

    expect(env.api.appListReminders).toHaveBeenCalledWith('app-1')
    expect(shown).toContain('Tell the group the hour is up.')
    expect(shown).toContain('Ops group')
    expect(shown).toContain('asked by Li')
    expect(shown).toContain('Drink water.')
    expect(shown).toContain('Main chat')
    expect(shown).toMatch(/Every 2h, next /)
    expect(shown).toMatch(/Once, /)
  })

  it('cancels one and reads the list again', async () => {
    const { tree } = await open()
    const [firstCancel] = nodes(tree).filter(node => node.type === 'button')

    firstCancel.props!.onClick!()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(env.api.appCancelReminder).toHaveBeenCalledWith('app-1', 'r-1')
    expect(env.api.appListReminders).toHaveBeenCalledTimes(2)
  })

  it('says how to get one when there are none', async () => {
    env.api.appListReminders.mockResolvedValue({ success: true, data: [] })

    const { tree } = await open()

    expect(text(tree)).toContain('None. Ask this digital human in a conversation to remind you of something, and the reminder shows here.')
  })
})
