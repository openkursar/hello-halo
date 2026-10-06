/**
 * A long user message shows its first lines and "Show all"; opened, it has a
 * "Collapse" at its top and at its end. The text lives in a
 * `[data-message-content]` element of its own, remounted on every open and
 * fold, with the buttons outside it, so search highlighting (which rewrites
 * that element's HTML) never leaves stale buttons or text behind. A search
 * jumping to the message opens it.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useMemo: (compute: any) => compute(),
  useEffect: (effect: any) => env.runner.effect(effect),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, vars?: Record<string, unknown>) => (vars ? text.replace(/{{(\w+)}}/g, (_, key) => String(vars[key])) : text),
  }),
}))

import { UserMessageText } from '../../../src/renderer/components/chat/UserMessageText'

class ComponentRunner {
  values: any[] = []
  index = 0
  effects: Array<() => void | (() => void)> = []
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  effect(effect: () => void | (() => void)) { this.effects.push(effect) }
  render(component: () => any) { this.index = 0; this.effects = []; env.runner = this; return component() }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
const contents = (tree: any) => nodes(tree).filter((node) => node.props?.['data-message-content'])
const shownText = (tree: any) => nodes(contents(tree)[0]).find((node) => node.type === 'span').props.children
const buttons = (tree: any) => nodes(tree).filter((node) => node.type === 'button')
const label = (button: any) => nodes(button).find((node) => node.type === 'span').props.children

function mount(text: string, messageId = 'm1') {
  const runner = new ComponentRunner()
  const render = () => runner.render(() => UserMessageText({ messageId, text }))
  return { runner, render }
}

const LOG = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
const PREVIEW = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('shows a short message whole, with nothing to open', () => {
  const tree = mount('Please fix the login bug').render()
  expect(shownText(tree)).toBe('Please fix the login bug')
  expect(buttons(tree)).toEqual([])
})

it('folds a long message to its first lines, and opens and folds it from either end', () => {
  const { render } = mount(LOG)
  let tree = render()
  expect(shownText(tree)).toBe(`${PREVIEW}…`)
  expect(buttons(tree).map(label)).toEqual(['Show all (20 lines)'])

  buttons(tree)[0].props.onClick()
  tree = render()
  expect(shownText(tree)).toBe(LOG)
  expect(buttons(tree).map(label)).toEqual(['Collapse', 'Collapse'])

  buttons(tree)[1].props.onClick()
  tree = render()
  expect(shownText(tree)).toBe(`${PREVIEW}…`)

  buttons(render())[0].props.onClick()
  buttons(render())[0].props.onClick()
  expect(shownText(render())).toBe(`${PREVIEW}…`)
})

it('offers "Show all" without a line count for one long paragraph', () => {
  const tree = mount('word '.repeat(400).trim()).render()
  expect(buttons(tree).map(label)).toEqual(['Show all'])
})

it('keeps the buttons outside the text element and gives the text a new element on every open and fold', () => {
  const { render } = mount(LOG)
  const folded = render()
  expect(contents(folded)).toHaveLength(1)
  expect(buttons(contents(folded)[0])).toEqual([])
  buttons(folded)[0].props.onClick()
  const opened = render()
  expect(buttons(contents(opened)[0])).toEqual([])
  expect(contents(opened)[0].key).not.toBe(contents(folded)[0].key)
})

it('opens when a search jumps to this message, and only this one', () => {
  const { runner, render } = mount(LOG, 'm1')
  render()
  const cleanups = runner.effects.map((effect) => effect())
  window.dispatchEvent(new CustomEvent('search:navigate-to-message', { detail: { messageId: 'm2', query: 'line' } }))
  expect(shownText(render())).toBe(`${PREVIEW}…`)
  window.dispatchEvent(new CustomEvent('search:navigate-to-message', { detail: { messageId: 'm1', query: 'line 17' } }))
  expect(shownText(render())).toBe(LOG)
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
})

it('listens for searches only when there is something to open', () => {
  const add = vi.spyOn(window, 'addEventListener')
  const { runner, render } = mount('short')
  render()
  runner.effects.forEach((effect) => effect())
  expect(add).not.toHaveBeenCalled()
})
