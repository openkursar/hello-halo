/**
 * A reader polling a running turn receives only the thoughts changed since its
 * previous read, and putting them in place gives exactly the turn's thoughts.
 * Changes are known from the same events the live view relies on.
 */

import { describe, it, expect } from 'vitest'
import { emitAgentEvent } from '../../../../src/main/services/agent/events'
import { noteThoughtChanged, readLiveThoughts } from '../../../../src/main/services/agent/live-thought-changes'
import { thoughtsAfterRead } from '../../../../src/renderer/components/team/workbench/execution-state'
import type { SessionState, Thought } from '../../../../src/main/services/agent/types'

const thought = (id: string, extra: Partial<Thought> = {}): Thought => ({ id, type: 'tool_use', content: '', timestamp: 't', toolName: 'Bash', ...extra })

function turn(conversationId: string) {
  const state = { thoughts: [] as Thought[] } as SessionState
  const add = (item: Thought) => {
    state.thoughts.push(item)
    emitAgentEvent('agent:thought', 's', conversationId, { thought: item })
  }
  const change = (id: string, update: Partial<Thought>) => {
    Object.assign(state.thoughts.find(item => item.id === id)!, update)
    emitAgentEvent('agent:thought-delta', 's', conversationId, { thoughtId: id, ...update })
  }
  return { state, add, change }
}

/** A polling reader as the workbench holds it. */
function reader(conversationId: string, state: SessionState) {
  let held: Thought[] = []
  let revision = ''
  return {
    poll() {
      const read = readLiveThoughts(conversationId, state, revision)
      const next = thoughtsAfterRead(held, { isActive: true, ...read })
      expect(next).not.toBeNull()
      held = next!
      revision = read.thoughtsRevision
      return read
    },
    get held() { return held },
  }
}

describe('live thought changes', () => {
  it('sends everything first, then only what was added or changed', () => {
    const { state, add, change } = turn('conv-a')
    add(thought('a'))
    add(thought('b'))
    const watcher = reader('conv-a', state)
    const first = watcher.poll()
    expect(first.thoughtsDelta).toBeUndefined()
    expect(watcher.held).toEqual(state.thoughts)

    add(thought('c'))
    change('a', { toolResult: { output: 'done', isError: false, timestamp: 't' } })
    const second = watcher.poll()
    expect(second.thoughts.map(item => item.id)).toEqual(['a', 'c'])
    expect(second.thoughtsDelta).toEqual({ total: 3, at: [0, 2] })
    expect(watcher.held).toEqual(state.thoughts)

    const idle = watcher.poll()
    expect(idle.thoughts).toEqual([])
    expect(watcher.held).toBe(watcher.held)
  })

  it('stays equal to the turn through a long run of changes, including one no event announced', () => {
    const { state, add, change } = turn('conv-b')
    const watcher = reader('conv-b', state)
    for (let step = 0; step < 300; step++) {
      add(thought(`t${step}`))
      if (step % 3 === 0) change(`t${Math.floor(step / 2)}`, { taskProgress: { taskId: 'x', status: 'running', toolCount: step, durationMs: step } })
      if (step % 7 === 0) {
        const item = state.thoughts[step >> 1]
        item.toolResult = { output: `drained ${step}`, isError: false, timestamp: 't' }
        noteThoughtChanged(state, item.id)
      }
      if (step % 5 === 0) {
        const read = watcher.poll()
        if (step > 50) expect(read.thoughts.length).toBeLessThan(12)
        expect(watcher.held).toEqual(state.thoughts)
      }
    }
    watcher.poll()
    expect(watcher.held).toEqual(state.thoughts)
  })

  it('reads a new turn whole when the token is from another turn', () => {
    const first = turn('conv-c')
    first.add(thought('old'))
    const read = readLiveThoughts('conv-c', first.state, '')
    const second = turn('conv-c')
    second.add(thought('new'))
    const next = readLiveThoughts('conv-c', second.state, read.thoughtsRevision)
    expect(next.thoughtsDelta).toBeUndefined()
    expect(next.thoughts.map(item => item.id)).toEqual(['new'])
  })

  it('a read that does not fit what is held asks for everything', () => {
    expect(thoughtsAfterRead([], { isActive: true, thoughts: [thought('x')], thoughtsDelta: { total: 3, at: [2] } })).toBeNull()
    expect(thoughtsAfterRead([thought('a')], { isActive: true, thoughts: [], thoughtsDelta: { total: 0, at: [] } })).toBeNull()
    const held = [thought('a')]
    expect(thoughtsAfterRead(held, { isActive: false, thoughts: [] })).toEqual([])
  })
})
