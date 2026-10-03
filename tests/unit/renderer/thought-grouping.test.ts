import { describe, expect, it } from 'vitest'
import { groupChildThoughts } from '../../../src/renderer/components/chat/thought-utils'
import type { Thought } from '../../../src/renderer/types'

const step = (id: string, parentToolUseId?: string): Thought =>
  ({ id, type: 'tool_use', content: '', timestamp: '', parentToolUseId }) as Thought

describe('groupChildThoughts', () => {
  it('groups sub-agent steps under their parent step', () => {
    const groups = groupChildThoughts([step('task-a'), step('a1', 'task-a'), step('task-b'), step('b1', 'task-b'), step('a2', 'task-a')])
    expect(groups.get('task-a')!.map(t => t.id)).toEqual(['a1', 'a2'])
    expect(groups.get('task-b')!.map(t => t.id)).toEqual(['b1'])
    expect(groups.has('task-c')).toBe(false)
  })

  it('keeps the previous array of a parent whose steps did not change', () => {
    const a1 = step('a1', 'task-a')
    const b1 = step('b1', 'task-b')
    const first = groupChildThoughts([a1, b1])
    const second = groupChildThoughts([a1, b1, step('b2', 'task-b')], first)
    expect(second.get('task-a')).toBe(first.get('task-a'))
    expect(second.get('task-b')).not.toBe(first.get('task-b'))
  })

  it('replaces a parent whose step was updated in place', () => {
    const a1 = step('a1', 'task-a')
    const first = groupChildThoughts([a1])
    const second = groupChildThoughts([{ ...a1, content: 'done' }], first)
    expect(second.get('task-a')).not.toBe(first.get('task-a'))
  })
})
