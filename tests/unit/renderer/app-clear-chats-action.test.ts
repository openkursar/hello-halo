/**
 * "Clear all conversations" in a digital human's settings: it says how many
 * conversations (and how many IM chats) will be cleared before anything is,
 * clears them only once confirmed, and reports what happened.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as unknown as HookRunner,
  api: { appChatsClearable: vi.fn(), appChatsClearAll: vi.fn() },
}))

class HookRunner {
  values: unknown[] = []
  index = 0
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [this.values[index], (update: unknown) => {
      this.values[index] = typeof update === 'function' ? (update as (value: unknown) => unknown)(this.values[index]) : update
    }]
  }
  render<T>(component: () => T): T {
    this.index = 0
    env.runner = this
    return component()
  }
}

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')),
  }),
}))

import { AppClearChatsAction } from '../../../src/renderer/components/apps/AppClearChatsAction'

type Node = { type?: unknown; props?: { children?: unknown; onClick?: () => unknown } }

function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}

const text = (tree: unknown) => nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string').join(' ')
const button = (tree: unknown, label: string) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))!
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** Click, then let the handler's request settle. */
async function click(tree: unknown, label: string): Promise<void> {
  button(tree, label).props!.onClick!()
  await settle()
}

function open() {
  const runner = new HookRunner()
  const view = () => AppClearChatsAction({ appId: 'person' })
  return { runner, view, tree: runner.render(view) }
}

beforeEach(() => {
  env.api.appChatsClearable.mockReset().mockResolvedValue({ success: true, data: { total: 7, im: 5 } })
  env.api.appChatsClearAll.mockReset().mockResolvedValue({ success: true, data: { cleared: 7, failed: 0 } })
})

describe('AppClearChatsAction', () => {
  it('says what will be cleared, clears only once confirmed, and reports it', async () => {
    const { runner, view, tree } = open()

    await click(tree, 'Clear all conversations')
    const confirm = runner.render(view)
    expect(text(confirm)).toContain('Clear the history of 7 conversations (5 of them IM chats)?')
    expect(text(confirm)).toContain('This cannot be undone. Memory and reminders are kept.')
    expect(env.api.appChatsClearAll).not.toHaveBeenCalled()

    await click(confirm, 'Confirm Clear')
    expect(env.api.appChatsClearAll).toHaveBeenCalledWith('person')
    expect(text(runner.render(view))).toContain('Cleared 7 conversations.')
  })

  it('clears nothing when cancelled', async () => {
    const { runner, view, tree } = open()

    await click(tree, 'Clear all conversations')
    button(runner.render(view), 'Cancel').props!.onClick!()

    expect(text(runner.render(view))).toContain('Clear all conversations')
    expect(env.api.appChatsClearAll).not.toHaveBeenCalled()
  })

  it('says when there is nothing to clear, and when some could not be cleared', async () => {
    env.api.appChatsClearable.mockResolvedValueOnce({ success: true, data: { total: 0, im: 0 } })
    const first = open()
    await click(first.tree, 'Clear all conversations')
    expect(text(first.runner.render(first.view))).toContain('No conversation has history to clear.')

    env.api.appChatsClearAll.mockResolvedValueOnce({ success: true, data: { cleared: 6, failed: 1 } })
    const second = open()
    await click(second.tree, 'Clear all conversations')
    await click(second.runner.render(second.view), 'Confirm Clear')
    expect(text(second.runner.render(second.view))).toContain('Cleared 6 conversations; 1 could not be cleared. Try again.')
  })
})
