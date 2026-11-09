import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpContextPreferences } from '../../../src/shared/apps/mcp-context'

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
vi.mock('../../../src/renderer/components/apps/CapabilityImpact', () => ({ CapabilityChangeDialog: () => null }))

import { McpContextSettings } from '../../../src/renderer/components/apps/McpContextSettings'
import { CapabilityChangeDialog } from '../../../src/renderer/components/apps/CapabilityImpact'

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}
const text = (tree: unknown): string => nodes(tree)
  .flatMap(node => [node.props?.children].flat(Infinity).filter(child => typeof child === 'string')).join(' ')
const field = (tree: unknown, type: unknown) => nodes(tree).find(node => node.type === type)!
const button = (tree: unknown, label: string) => nodes(tree).find(node => node.type === 'button' && text(node) === label)!

let onSave = vi.fn(async (_patch: Record<string, unknown>): Promise<boolean> => true)
const render = (value?: McpContextPreferences) => {
  env.index = 0
  return McpContextSettings({ appId: 'fixture', value, onSave })
}

beforeEach(() => {
  env.states = []
  onSave = vi.fn(async (_patch: Record<string, unknown>): Promise<boolean> => true)
})

describe('MCP context settings', () => {
  it('offers on-demand by default without an active connection or session', () => {
    const tree = render()
    expect(field(tree, 'select').props?.value).toBe('deferred')
    expect(field(tree, 'select').props?.disabled).toBe(false)
    expect(text(tree)).toContain('Other engines use their own tool-loading behavior')
    expect(text(tree)).toContain('Older conversations keep their original tool context')
    expect(button(tree, 'Save').props?.disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('waits for shared-impact confirmation and saves only the changed field', async () => {
    const value: McpContextPreferences = { summary: 'Order lookup' }
    field(render(value), 'select').props?.onChange({ target: { value: 'eager' } })
    button(render(value), 'Save').props?.onClick()
    expect(onSave).not.toHaveBeenCalled()
    const dialog = field(render(value), CapabilityChangeDialog)
    expect(dialog.props?.appId).toBe('fixture')
    await dialog.props?.onConfirm()
    expect(onSave).toHaveBeenCalledWith({ loading: 'eager' })
  })

  it('clears a summary with null and retains the draft after a failed write', async () => {
    const value: McpContextPreferences = { loading: 'eager', summary: 'Order lookup' }
    field(render(value), 'textarea').props?.onChange({ target: { value: ' \n ' } })
    button(render(value), 'Save').props?.onClick()
    onSave.mockResolvedValue(false)
    await expect(field(render(value), CapabilityChangeDialog).props?.onConfirm()).rejects.toThrow('save failed')
    expect(onSave).toHaveBeenCalledWith({ summary: null })
    expect(field(render(value), 'textarea').props?.value).toBe(' \n ')
  })

  it('counts Unicode characters without cutting surrogate pairs', () => {
    field(render(), 'textarea').props?.onChange({ target: { value: '🧩'.repeat(512) } })
    expect(button(render(), 'Save').props?.disabled).toBe(false)
    expect(text(render())).toContain('512 / 512 characters')
    field(render(), 'textarea').props?.onChange({ target: { value: '🧩'.repeat(513) } })
    expect(button(render(), 'Save').props?.disabled).toBe(true)
    expect(field(render(), 'textarea').props?.['aria-invalid']).toBe(true)
  })

  it('does not overwrite another client\'s loading change while editing the description', async () => {
    field(render({ loading: 'deferred' }), 'textarea').props?.onChange({ target: { value: 'New description' } })
    const updated: McpContextPreferences = { loading: 'eager' }
    expect(field(render(updated), 'select').props?.value).toBe('eager')
    button(render(updated), 'Save').props?.onClick()
    await field(render(updated), CapabilityChangeDialog).props?.onConfirm()
    expect(onSave).toHaveBeenCalledWith({ summary: 'New description' })
  })

  it('cancels without applying the draft', () => {
    field(render(), 'select').props?.onChange({ target: { value: 'eager' } })
    button(render(), 'Cancel').props?.onClick()
    expect(field(render(), 'select').props?.value).toBe('deferred')
    expect(onSave).not.toHaveBeenCalled()
  })
})
