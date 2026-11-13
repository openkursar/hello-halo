import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { PendingQuestion } from '../../../src/renderer/types'

const env = vi.hoisted(() => ({ runner: null as unknown as HookRunner }))
class HookRunner {
  values: unknown[] = []
  index = 0
  effects: Array<() => void> = []
  deps = new Map<number, unknown[]>()
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = initial
    return [this.values[index], (update: unknown) => {
      this.values[index] = typeof update === 'function' ? update(this.values[index]) : update
    }]
  }
  ref(initial: unknown) {
    const index = this.index++
    this.values[index] ??= { current: initial }
    return this.values[index]
  }
  effect(effect: () => void, deps: unknown[]) {
    const index = this.index++
    if (!this.deps.has(index) || deps.some((value, at) => value !== this.deps.get(index)![at])) this.effects.push(effect)
    this.deps.set(index, deps)
  }
  render(component: () => ReactElement | null): ReactElement | null {
    env.runner = this
    this.index = 0
    this.effects = []
    const result = component()
    if (this.effects.length) {
      for (const effect of this.effects) effect()
      return this.render(component)
    }
    return result
  }
}
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useRef: (initial: unknown) => env.runner.ref(initial),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void, deps: unknown[]) => env.runner.effect(effect, deps),
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))
import { AskUserQuestionCard } from '../../../src/renderer/components/chat/AskUserQuestionCard'

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}
function text(tree: unknown): string {
  return nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(value => typeof value === 'string').join(' ')
}
function fixture() {
  const runner = new HookRunner()
  const onAnswer = vi.fn()
  const pendingQuestion: PendingQuestion = { id: 'first', status: 'active', questions: [
    { question: 'Which scope?', header: 'Same', multiSelect: false, options: [{ label: 'DDL only', description: '' }, { label: 'All scripts', description: '' }] },
    { question: 'Which records?', header: 'Same', multiSelect: true, options: [{ label: 'SQL', description: '' }, { label: 'Audit', description: '' }] },
    { question: 'Which recipient?', header: 'Same', multiSelect: false, options: [{ label: 'Owner', description: '' }, { label: 'Team', description: '' }] },
  ] }
  const render = () => runner.render(() => AskUserQuestionCard({ pendingQuestion, onAnswer }))
  const button = (label: string) => nodes(render()).find(node => node.type === 'button' && text(node).trim() === label)!
  return { pendingQuestion, onAnswer, render, button }
}

describe('question card answers', () => {
  it('submits full-question keys for single, multiple and custom answers despite repeated headings', () => {
    const f = fixture()
    f.button('DDL only').props!.onClick()
    f.button('SQL').props!.onClick()
    f.button('Audit').props!.onClick()
    nodes(f.render()).filter(node => node.type === 'button' && text(node).trim() === 'Other...')[2].props!.onClick()
    nodes(f.render()).find(node => node.type === 'input')!.props!.onChange({ target: { value: '  Release operator  ' } })
    f.button('Submit').props!.onClick()
    expect(f.onAnswer).toHaveBeenCalledWith({ 'Which scope?': 'DDL only', 'Which records?': 'SQL, Audit', 'Which recipient?': 'Release operator' })
  })

  it('disables submission of an empty question set', () => {
    const f = fixture()
    f.pendingQuestion.questions = []
    expect(f.button('Submit').props!.disabled).toBe(true)
    f.button('Submit').props!.onClick()
    expect(f.onAnswer).not.toHaveBeenCalled()
  })

  it('retains choices on failure, disables controls during submission, and clears choices for a new question id', () => {
    const f = fixture()
    f.pendingQuestion.questions = [f.pendingQuestion.questions[0]]
    f.button('DDL only').props!.onClick()
    f.pendingQuestion.submitting = true
    expect(f.button('Submitting...').props!.disabled).toBe(true)
    f.button('Submitting...').props!.onClick()
    expect(f.onAnswer).not.toHaveBeenCalled()
    f.pendingQuestion.submitting = false
    f.pendingQuestion.error = true
    expect(text(f.render())).toContain('Your answer could not be submitted. Please try again.')
    expect(f.button('Submit').props!.disabled).toBeFalsy()
    f.pendingQuestion.id = 'second'
    expect(f.button('Submit').props!.disabled).toBe(true)
  })
})
