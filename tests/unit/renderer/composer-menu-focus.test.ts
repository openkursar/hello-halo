/**
 * The "+" panel takes the keyboard only when the user opened it. Opened by an
 * AI request it shows the requested switch but leaves focus in the composer
 * and preselects nothing, so the space or Enter of someone typing can never
 * flip a capability on for them.
 *
 * No DOM here: React's hooks are replaced by a small runner; effects are run
 * by hand and the returned element tree is searched for rows and handlers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, effects: [] as Array<() => unknown>, layoutEffects: [] as Array<() => unknown> }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useMemo: (compute: any) => compute(),
  useCallback: (fn: any) => fn,
  useEffect: (effect: () => unknown) => { env.effects.push(effect) },
  useLayoutEffect: (effect: () => unknown) => { env.layoutEffects.push(effect) },
}))

import { ComposerMenu, type ComposerMenuSection } from '../../../src/renderer/components/chat/composer-menu/ComposerMenu'

class ComponentRunner {
  values: any[] = []; index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; env.effects = []; env.layoutEffects = []; return component() }
}
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const key = (name: string) => ({ key: name, preventDefault: vi.fn(), stopPropagation: vi.fn() })

/** Mounts the panel, lets it place itself, and runs its effects; returns the settled tree and the panel's focus spy. */
function open(takeFocus: boolean | undefined, onChange: () => void) {
  const sections: ComposerMenuSection[] = [{
    id: 'capabilities',
    title: 'Capabilities',
    items: [
      { id: 'toolset:ai-browser', icon: null, label: 'Web Control', description: '', toggle: { checked: false, onChange: vi.fn() } },
      { id: 'toolset:ai-terminal', icon: null, label: 'AI Terminal', description: '', toggle: { checked: false, onChange }, attention: true },
    ],
  }]
  const anchor = { getBoundingClientRect: () => ({ top: 600, bottom: 700 }) }
  const props = { sections, anchorRef: { current: anchor }, triggerRef: { current: null }, onClose: vi.fn(), radiusClassName: '', takeFocus } as any
  const runner = new ComponentRunner()
  runner.render(() => ComposerMenu(props))
  const focus = vi.fn()
  runner.values[0].current = { focus, contains: () => false, parentElement: null }
  env.layoutEffects.forEach(run => run())
  const tree = runner.render(() => ComposerMenu(props))
  env.effects.forEach(run => run())
  return { tree, focus }
}

beforeEach(() => {
  vi.stubGlobal('window', { innerHeight: 900, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the "+" panel and the keyboard', () => {
  it('opened by an AI request: focus stays in the composer, nothing is preselected, keys flip nothing', () => {
    const onChange = vi.fn()
    const { tree, focus } = open(false, onChange)
    expect(focus).not.toHaveBeenCalled()
    const rows = nodes(tree).filter(node => node.props?.item)
    expect(rows.map(row => row.props.active)).toEqual([false, false])
    expect(rows[1].props.item.attention).toBe(true)
    tree.props.onKeyDown(key(' '))
    tree.props.onKeyDown(key('Enter'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opened by the user: the panel takes the keyboard on the highlighted row, as before', () => {
    const onChange = vi.fn()
    const { tree, focus } = open(undefined, onChange)
    expect(focus).toHaveBeenCalledOnce()
    expect(nodes(tree).filter(node => node.props?.item).map(row => row.props.active)).toEqual([false, true])
    tree.props.onKeyDown(key(' '))
    expect(onChange).toHaveBeenCalledOnce()
  })
})
