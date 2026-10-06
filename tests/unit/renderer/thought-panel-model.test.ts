/**
 * The live thought panel re-derives only the steps that changed: a streamed
 * delta replaces one step, so the panel's lists must equal a full rebuild
 * while every list the change did not touch keeps its identity.
 */

import { describe, expect, it } from 'vitest'
import { nextThoughtPanelModel, type ThoughtPanelModel } from '../../../src/renderer/components/chat/thought-utils'
import type { Thought } from '../../../src/renderer/types'

let seq = 0
const step = (fields: Partial<Thought>): Thought =>
  ({ id: `t${++seq}`, type: 'thinking', content: '', timestamp: new Date(seq * 1000).toISOString(), ...fields }) as Thought

/** The model a panel opening on `thoughts` for the first time would build. */
const fresh = (thoughts: readonly Thought[]) => nextThoughtPanelModel(null, thoughts)

function expectSameModel(actual: ThoughtPanelModel, thoughts: readonly Thought[]) {
  const expected = fresh(thoughts)
  expect(actual.display).toEqual(expected.display)
  expect([...actual.childGroups.entries()]).toEqual([...expected.childGroups.entries()])
  expect(actual.latestTodo).toBe(expected.latestTodo)
  expect(actual.errorCount).toBe(expected.errorCount)
}

describe('thought panel model', () => {
  it('replaces only the streamed step and keeps every untouched list', () => {
    const task = step({ type: 'tool_use', toolName: 'Task' })
    const child = step({ type: 'tool_use', toolName: 'Read', parentToolUseId: task.id })
    const thinking = step({ isStreaming: true })
    const before = [task, child, thinking]
    const first = fresh(before)

    const streamed = { ...thinking, content: 'more reasoning' }
    const after = [task, child, streamed]
    const next = nextThoughtPanelModel(first, after)

    expectSameModel(next, after)
    expect(next.display).not.toBe(first.display)
    expect(next.display[1]).toBe(streamed)
    expect(next.childGroups).toBe(first.childGroups)
    expect(first.display[1]).toBe(thinking)
    expect(nextThoughtPanelModel(next, after)).toBe(next)
  })

  it('keeps the timeline when only a sub-agent step or the todo list changes', () => {
    const task = step({ type: 'tool_use', toolName: 'Task' })
    const child = step({ type: 'tool_use', toolName: 'Read', parentToolUseId: task.id })
    const todo = step({ type: 'tool_use', toolName: 'TodoWrite', toolInput: {} })
    const first = fresh([task, child, todo])

    const done = { ...child, toolResult: { output: 'ok', isError: false, timestamp: '' } }
    const todos = { ...todo, toolInput: { todos: [{ content: 'a', status: 'pending' }] } }
    const after = [task, done, todos]
    const next = nextThoughtPanelModel(first, after)

    expectSameModel(next, after)
    expect(next.display).toBe(first.display)
    expect(next.childGroups.get(task.id)).toEqual([done])
    expect(first.childGroups.get(task.id)).toEqual([child])
    expect(next.latestTodo).toBe(todos)
  })

  it('appends new steps to the lists they belong to', () => {
    const task = step({ type: 'tool_use', toolName: 'Task' })
    const first = fresh([task])
    const after = [task, step({ parentToolUseId: task.id }), step({ type: 'error', content: 'boom' }), step({ type: 'result' })]
    const next = nextThoughtPanelModel(first, after)
    expectSameModel(next, after)
    expect(next.errorCount).toBe(1)
  })

  it('rebuilds when a step changes kind or the list shrinks', () => {
    const plain = step({ type: 'tool_use', toolName: 'Bash' })
    const first = fresh([plain, step({})])
    const renamed = [{ ...plain, toolName: 'TodoWrite', toolInput: { todos: [] } }]
    expectSameModel(nextThoughtPanelModel(first, renamed), renamed)
    expectSameModel(nextThoughtPanelModel(first, []), [])
  })

  it('matches a full rebuild over long random streams of appends and in-place updates', () => {
    let random = 7
    const next = () => (random = (random * 48271) % 2147483647) / 2147483647
    for (let run = 0; run < 25; run++) {
      let thoughts: Thought[] = []
      let model = fresh(thoughts)
      for (let op = 0; op < 120; op++) {
        const roll = next()
        const tasks = thoughts.filter(t => t.toolName === 'Task')
        if (roll < 0.35 || thoughts.length === 0) {
          const kind = next()
          const appended = kind < 0.2 ? step({ type: 'tool_use', toolName: 'Task' })
            : kind < 0.4 && tasks.length ? step({ type: 'tool_use', toolName: 'Grep', parentToolUseId: tasks[Math.floor(next() * tasks.length)].id })
            : kind < 0.5 ? step({ type: 'tool_use', toolName: 'TodoWrite', toolInput: {} })
            : kind < 0.55 ? step({ type: 'error', content: 'e' })
            : kind < 0.6 ? step({ type: 'result' })
            : step({ isStreaming: true })
          thoughts = [...thoughts, appended]
        } else if (roll < 0.97) {
          // A streamed delta or a merged tool result: one step, same place, new object.
          const index = Math.floor(next() * thoughts.length)
          const target = thoughts[index]
          const updated = target.toolName === 'TodoWrite'
            ? { ...target, toolInput: { todos: [{ content: `${op}`, status: 'pending' }] } }
            : { ...target, content: `${target.content}${op}` }
          thoughts = thoughts.map((t, i) => (i === index ? updated : t))
        } else {
          thoughts = thoughts.slice(0, Math.floor(next() * thoughts.length))
        }
        model = nextThoughtPanelModel(model, thoughts)
        expectSameModel(model, thoughts)
      }
    }
  })
})
