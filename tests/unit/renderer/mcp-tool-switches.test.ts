/**
 * The per-tool switches on an MCP server card: each switch saves the whole list
 * of turned-off tools, "all on/off" keep tools the server no longer lists as
 * they were, and a failed save puts the switches back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = env.index++
    if (!(index in env.states)) env.states[index] = initial
    return [env.states[index], (next: unknown) => { env.states[index] = next }]
  },
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  }),
}))

import { McpToolSwitches } from '../../../src/renderer/components/apps/McpToolSwitches'
import { Switch } from '../../../src/renderer/components/ui/Switch'

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}
const text = (tree: unknown): string =>
  nodes(tree).flatMap(node => [node.props?.children].flat(Infinity).filter(child => typeof child === 'string')).join(' ')

let onSave = vi.fn(async (_disabledTools: string[]): Promise<boolean> => true)
const tools = ['query', 'drop_table', 'run_sql']
const render = (disabledTools: string[] = []) => {
  env.index = 0
  return McpToolSwitches({ tools, disabledTools, onSave })
}
const switchFor = (tree: unknown, tool: string) => nodes(tree).find(node => node.type === Switch && node.props?.ariaLabel === tool)!
const button = (tree: unknown, label: string) => nodes(tree).find(node => node.type === 'button' && text(node) === label)!

beforeEach(() => {
  env.states = []
  onSave = vi.fn(async (_disabledTools: string[]): Promise<boolean> => true)
})

describe('McpToolSwitches', () => {
  it('shows each tool with its switch and how many are on', () => {
    const tree = render(['drop_table'])

    expect(text(tree)).toContain('2 of 3 tools on')
    expect(switchFor(tree, 'query').props!.checked).toBe(true)
    expect(switchFor(tree, 'drop_table').props!.checked).toBe(false)
  })

  it('saves the whole list when one tool is turned off or on', async () => {
    await switchFor(render(['drop_table']), 'run_sql').props!.onCheckedChange(false)
    expect(onSave).toHaveBeenLastCalledWith(['drop_table', 'run_sql'])

    env.states = []
    await switchFor(render(['drop_table', 'run_sql']), 'drop_table').props!.onCheckedChange(true)
    expect(onSave).toHaveBeenLastCalledWith(['run_sql'])
  })

  it('turns everything listed off or on, keeping a tool the server no longer lists off', async () => {
    await button(render(['retired_tool']), 'Turn all off').props!.onClick()
    expect(onSave).toHaveBeenLastCalledWith(['retired_tool', 'query', 'drop_table', 'run_sql'])

    env.states = []
    await button(render(['retired_tool', 'query']), 'Turn all on').props!.onClick()
    expect(onSave).toHaveBeenLastCalledWith(['retired_tool'])
  })

  it('puts the switches back and says so when the change could not be saved', async () => {
    onSave = vi.fn(async (_disabledTools: string[]): Promise<boolean> => false)
    await switchFor(render([]), 'query').props!.onCheckedChange(false)

    const tree = render([])
    expect(switchFor(tree, 'query').props!.checked).toBe(true)
    expect(text(tree)).toContain('Could not save the change. Please try again.')
  })
})
