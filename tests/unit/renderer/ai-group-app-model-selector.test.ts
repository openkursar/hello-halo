/**
 * A digital human can be set to run on a load-balancing group, from the same
 * picker it uses for an account's model.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, appState: {} as any }))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: () => env.appState }))
vi.mock('../../../src/renderer/hooks/useFreshModelCatalogs', () => ({ useFreshModelCatalogs: () => {} }))

import { AppModelSelector } from '../../../src/renderer/components/apps/AppModelSelector'
import type { AIGroup, AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'

class ComponentRunner {
  values: any[] = []
  index = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props))
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
function textOf(node: any): string {
  if (node && typeof node === 'object' && typeof node.type === 'function') return textOf(node.type(node.props))
  return [node?.props?.children].flat(Infinity).map(child => typeof child === 'string' ? child : child && typeof child === 'object' ? textOf(child) : '').join('')
}
const buttonWith = (tree: any, text: string) => nodes(tree).find(node => node.type === 'button' && textOf(node).includes(text))
const paragraphs = (tree: any) => nodes(tree).filter(node => node.type === 'p').map(textOf)

function account(id: string): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} one` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
const group: AIGroup = {
  id: 'g1', name: 'Daily', strategy: 'priority',
  members: [{ sourceId: 'main', modelId: 'main-m1' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const sources: AISourcesConfig = { version: 2, currentId: 'main', sources: [account('main')], groups: [group] }
const onChange = vi.fn()

function open(selection: { modelSourceId?: string; modelId?: string } = {}) {
  env.appState = { config: { aiSources: sources } }
  const runner = new ComponentRunner()
  return { draw: () => runner.render(() => AppModelSelector({ ...selection, onChange })) }
}

beforeEach(() => onChange.mockReset())

describe('picking a group for a digital human', () => {
  it('reads as following the global selection until something is chosen', () => {
    const tree = open().draw()
    expect(nodes(tree).some(node => node.type === 'span' && textOf(node) === 'Follow global (main one)')).toBe(true)
    expect(paragraphs(tree).join(' ')).toContain('Uses the globally selected model')
  })

  it('shows a group it is set to by its name and Auto mark, and says what that means', () => {
    const tree = open({ modelSourceId: 'g1', modelId: 'halo-auto' }).draw()
    expect(nodes(tree).some(node => node.type === 'span' && textOf(node) === 'Daily · Auto')).toBe(true)
    expect(paragraphs(tree).join(' ')).toContain('This app uses a load-balancing group, independent of the global selection')
  })

  it('lists the group after the accounts and sets it with the one fixed model id', () => {
    const { draw } = open()
    nodes(draw()).find(node => node.type === 'button' && node.props['aria-expanded'] === false).props.onClick()
    const dropdown = draw()
    const headings = nodes(dropdown).filter(node => node.type === 'button' && node.props['aria-expanded'] !== undefined).map(textOf)
    expect(headings.at(-1)).toContain('Daily')

    const groupHeader = nodes(dropdown).filter(node => node.type === 'button' && node.props['aria-expanded'] !== undefined).at(-1)
    groupHeader.props.onClick()
    buttonWith(draw(), 'Choose automatically').props.onClick()
    expect(onChange).toHaveBeenCalledWith('g1', 'halo-auto')
  })

  it('can be taken off the group again, back to following the global selection', () => {
    const tree = open({ modelSourceId: 'g1', modelId: 'halo-auto' }).draw()
    nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Reset to global').props.onClick()
    expect(onChange).toHaveBeenCalledWith(undefined, undefined)
  })

  it('says a group that was deleted is no longer followed', () => {
    const tree = open({ modelSourceId: 'gone', modelId: 'halo-auto' }).draw()
    expect(paragraphs(tree).join(' ')).toContain('The account it was set to use was removed, so it follows the global selection.')
  })
})
