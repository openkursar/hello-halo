/**
 * Opening the process of a run whose transcript the retention rule cleared
 * says so, and offers neither "Continue" nor a box to reply into: nothing is
 * left to continue it from.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as unknown as HookRunner,
  api: { appGetSession: vi.fn(), appInjectRun: vi.fn() },
  apps: { appStates: {}, activityEntries: {}, continueApp: vi.fn() } as Record<string, unknown>,
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
  ref(initial: unknown) {
    const index = this.index++
    this.values[index] ??= { current: initial }
    return this.values[index]
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
  useRef: (initial: unknown) => env.runner.ref(initial),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void) => { env.runner.effects.push(effect) },
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: (state: unknown) => unknown) => select(env.apps) }))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')),
  }),
}))
vi.mock('../../../src/renderer/components/chat/MessageList', () => ({ MessageList: function MessageList() { return null } }))
vi.mock('../../../src/renderer/components/chat/ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }))
vi.mock('../../../src/renderer/components/chat/InputArea', () => ({ InputArea: function InputArea() { return null } }))

import { SessionDetailView } from '../../../src/renderer/components/apps/SessionDetailView'

type Node = { type?: unknown; props?: { children?: unknown } }

function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}

function text(tree: unknown): string {
  return nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string').join(' ')
}

const named = (tree: unknown, name: string) => nodes(tree).some(node => typeof node.type === 'function' && node.type.name === name)

/** Render, run the effects (the transcript load), let it settle, render again. */
async function openProcess(): Promise<unknown> {
  const runner = new HookRunner()
  const view = () => SessionDetailView({ appId: 'app-1', runId: 'run-1' })
  runner.render(view)
  for (const effect of runner.effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  return runner.render(view)
}

describe('SessionDetailView', () => {
  beforeEach(() => {
    env.api.appGetSession.mockReset()
    env.apps.activityEntries = {
      'app-1': [{ id: 'e1', runId: 'run-1', type: 'run_error', content: { summary: 'Failed', resumeAvailable: true } }],
    }
  })

  it('says a cleared run’s process is gone and offers nothing to continue it', async () => {
    env.api.appGetSession.mockResolvedValue({ success: false, error: 'cleared', code: 'RUN_PROCESS_CLEARED' })

    const tree = await openProcess()

    expect(text(tree)).toContain('The detailed process of this run was cleared under the retention rule. Its result stays on the timeline.')
    expect(text(tree)).not.toContain('Continue')
    expect(named(tree, 'InputArea')).toBe(false)
  })

  it('shows how many tokens the run used, over every execution of it', async () => {
    env.apps.activityEntries = {
      'app-1': [
        { id: 'e1', runId: 'run-1', type: 'milestone', content: { summary: 'Half way', tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 3000, cacheCreationTokens: 350 } } },
        { id: 'e2', runId: 'run-1', type: 'run_complete', content: { summary: 'Done', tokenUsage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 0 } } },
        { id: 'e3', runId: 'run-2', type: 'run_complete', content: { summary: 'Other', tokenUsage: { inputTokens: 9999, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } },
      ],
    }
    env.api.appGetSession.mockResolvedValue({ success: true, data: [{ id: 'm1', role: 'user', content: 'go', timestamp: '' }] })

    const tree = await openProcess()

    expect(text(tree)).toContain('Tokens used by this run: 4.5K')
  })

  it('still shows a kept run’s process with its reply box', async () => {
    env.api.appGetSession.mockResolvedValue({ success: true, data: [{ id: 'm1', role: 'user', content: 'go', timestamp: '' }] })

    const tree = await openProcess()

    expect(named(tree, 'MessageList')).toBe(true)
    expect(named(tree, 'InputArea')).toBe(true)
    expect(text(tree)).not.toContain('cleared under the retention rule')
  })
})
