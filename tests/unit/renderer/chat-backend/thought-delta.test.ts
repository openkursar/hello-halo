/**
 * A thought delta updates one step: the step it names gets a new object and
 * every other step keeps its identity, so only that step re-renders. Partial
 * tool input changes nothing on screen and leaves the store untouched.
 */
import { describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))
vi.mock('../../../../src/renderer/stores/team.store', () => ({ isRemoteMemberAppId: () => false }))
vi.mock('../../../../src/renderer/stores/goal.store', () => ({ useGoalStore: { getState: () => ({ forget: () => {} }) } }))
vi.mock('../../../../src/renderer/stores/goal-ui.store', () => ({ useGoalUiStore: { getState: () => ({ forget: () => {} }) } }))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))

import { createAgentEventsSlice } from '../../../../src/renderer/stores/chat/agent-events'
import type { ChatState } from '../../../../src/renderer/stores/chat/internal'
import type { Thought } from '../../../../src/renderer/types'

const CONVERSATION = 'conv-1'

function makeStore(thoughts: Thought[]) {
  return create<ChatState>((set, get) => ({
    sessions: new Map([[CONVERSATION, { thoughts, isGenerating: true, isThinking: true } as never]]),
    ...createAgentEventsSlice(set as never, get as never),
  }) as unknown as ChatState)
}

const step = (id: string, fields: Partial<Thought> = {}): Thought =>
  ({ id, type: 'thinking', content: '', timestamp: '', ...fields }) as Thought

describe('thought deltas in the chat store', () => {
  it('replace only the step they name', () => {
    const first = step('a', { content: 'done' })
    const tool = step('b', { type: 'tool_use', toolName: 'Bash', toolInput: {}, isStreaming: true, isReady: false })
    const thinking = step('c', { content: 'Let', isStreaming: true })
    const store = makeStore([first, tool, thinking])

    store.getState().handleAgentThoughtDelta({ conversationId: CONVERSATION, thoughtId: 'c', delta: ' me think' } as never)
    const thoughts = store.getState().sessions.get(CONVERSATION)!.thoughts
    expect(thoughts[2]).toMatchObject({ content: 'Let me think', isStreaming: true })
    expect(thoughts[0]).toBe(first)
    expect(thoughts[1]).toBe(tool)

    store.getState().handleAgentThoughtDelta({ conversationId: CONVERSATION, thoughtId: 'b', toolInput: { command: 'ls' }, isComplete: true, isReady: true, isToolInput: true } as never)
    const completed = store.getState().sessions.get(CONVERSATION)!.thoughts
    expect(completed[1]).toMatchObject({ toolInput: { command: 'ls' }, isStreaming: false, isReady: true })
    expect(completed[2]).toBe(thoughts[2])
  })

  it('leave the store untouched for partial tool input and unknown steps', () => {
    const tool = step('b', { type: 'tool_use', toolName: 'Write', toolInput: {}, isStreaming: true, isReady: false })
    const store = makeStore([tool])
    const before = store.getState().sessions
    const listener = vi.fn()
    store.subscribe(listener)

    store.getState().handleAgentThoughtDelta({ conversationId: CONVERSATION, thoughtId: 'b', delta: '{"file_path":', isToolInput: true } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.getState().handleAgentThoughtDelta({ conversationId: CONVERSATION, thoughtId: 'missing', delta: 'x' } as never)
    warn.mockRestore()

    expect(store.getState().sessions).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })
})
