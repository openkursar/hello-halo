/**
 * canUseTool is only reached for interactive tools. These tests pin the branch
 * table (auto-allow / deny / block-then-answer) and the pending-question registry
 * lifecycle: every terminal transition (resolve/reject/rejectAll/abort) must delete
 * the entry so getActivePendingQuestion only ever surfaces a still-unanswered one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))

import {
  createCanUseTool,
  resolveQuestion,
  rejectQuestion,
  rejectAllQuestions,
  getActivePendingQuestion,
  type AskUserQuestionItem
} from '../../../../src/main/services/agent/permission-handler'

const noAbort = { signal: new AbortController().signal }

function question(): AskUserQuestionItem {
  return { question: 'q?', header: 'h', options: [{ label: 'a', description: 'd' }], multiSelect: false }
}

/** Drain any still-pending questions so registry state never leaks between tests. */
beforeEach(() => {
  rejectAllQuestions()
  emitAgentEvent.mockClear()
})

describe('createCanUseTool — branch table', () => {
  it('auto-allows any non-AskUserQuestion tool with the input untouched', async () => {
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c' })
    const input = { command: 'ls' }
    const res = await fn('Bash', input, noAbort)
    expect(res).toEqual({ behavior: 'allow', updatedInput: input })
    expect(emitAgentEvent).not.toHaveBeenCalled()
  })

  it('auto-allows AskUserQuestion with empty answers when no deps supplied', async () => {
    const fn = createCanUseTool()
    const res = await fn('AskUserQuestion', { questions: [question()] }, noAbort)
    expect(res.behavior).toBe('allow')
    expect(res.updatedInput.answers).toEqual({})
  })

  it('denies AskUserQuestion in a non-interactive session without emitting', async () => {
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c', nonInteractive: true })
    const res = await fn('AskUserQuestion', { questions: [question()] }, noAbort)
    expect(res.behavior).toBe('deny')
    expect(typeof (res as { message?: string }).message).toBe('string')
    expect((res as { message: string }).message.length).toBeGreaterThan(0)
    expect(emitAgentEvent).not.toHaveBeenCalled()
  })

  it('blocks on AskUserQuestion, emits the card, then resolves with the answers merged in', async () => {
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c' })
    const input = { questions: [question()] }
    const pending = fn('AskUserQuestion', input, noAbort)

    // The card is pushed before the promise settles.
    expect(emitAgentEvent).toHaveBeenCalledWith(
      'agent:ask-question',
      's',
      'c',
      expect.objectContaining({ questions: input.questions })
    )
    const active = getActivePendingQuestion('c')
    expect(active).not.toBeNull()

    expect(resolveQuestion(active!.id, { h: 'a' })).toBe(true)
    const res = await pending
    expect(res).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { h: 'a' } } })
    // Registry cleared after resolve.
    expect(getActivePendingQuestion('c')).toBeNull()
  })

  it('denies when the pending question is rejected', async () => {
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c' })
    const input = { questions: [question()] }
    const pending = fn('AskUserQuestion', input, noAbort)

    const id = getActivePendingQuestion('c')!.id
    expect(rejectQuestion(id, 'cancelled')).toBe(true)
    const res = await pending
    expect(res.behavior).toBe('deny')
    expect(typeof (res as { message?: string }).message).toBe('string')
    expect(getActivePendingQuestion('c')).toBeNull()
  })

  it('denies when the abort signal fires before an answer arrives', async () => {
    const controller = new AbortController()
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c' })
    const pending = fn('AskUserQuestion', { questions: [question()] }, { signal: controller.signal })

    expect(getActivePendingQuestion('c')).not.toBeNull()
    controller.abort()
    const res = await pending
    expect(res.behavior).toBe('deny')
    expect(getActivePendingQuestion('c')).toBeNull()
  })

  it('denies immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c' })
    const res = await fn('AskUserQuestion', { questions: [question()] }, { signal: controller.signal })
    expect(res.behavior).toBe('deny')
    expect(getActivePendingQuestion('c')).toBeNull()
  })
})

describe('pending-question registry', () => {
  it('resolveQuestion / rejectQuestion return false for an unknown id', () => {
    expect(resolveQuestion('nope', {})).toBe(false)
    expect(rejectQuestion('nope')).toBe(false)
  })

  it('rejectAllQuestions clears every conversation and denies each caller', async () => {
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c1' })
    const other = createCanUseTool({ spaceId: 's', conversationId: 'c2' })
    const p1 = fn('AskUserQuestion', { questions: [question()] }, noAbort)
    const p2 = other('AskUserQuestion', { questions: [question()] }, noAbort)

    expect(getActivePendingQuestion('c1')).not.toBeNull()
    expect(getActivePendingQuestion('c2')).not.toBeNull()

    rejectAllQuestions()
    expect((await p1).behavior).toBe('deny')
    expect((await p2).behavior).toBe('deny')
    expect(getActivePendingQuestion('c1')).toBeNull()
    expect(getActivePendingQuestion('c2')).toBeNull()
  })

  it('getActivePendingQuestion returns null when the conversation has no in-flight ask', () => {
    expect(getActivePendingQuestion('never-asked')).toBeNull()
  })
})

describe('deny results satisfy the SDK PermissionResult contract (#271)', () => {
  // Mirrors the SDK's discriminated union (sdk.d.ts PermissionResult): the
  // deny variant carries a required message; the CLI zod-parses the control
  // response, so a deny without message throws ZodError at runtime.
  const permissionResultSchema = z.discriminatedUnion('behavior', [
    z.object({ behavior: z.literal('allow'), updatedInput: z.record(z.string(), z.unknown()).optional() }),
    z.object({ behavior: z.literal('deny'), message: z.string() }),
  ])

  it('non-interactive deny validates against the SDK schema', async () => {
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c', nonInteractive: true })
    const res = await fn('AskUserQuestion', { questions: [question()] }, noAbort)
    const parsed = permissionResultSchema.safeParse(res)
    expect(parsed.success).toBe(true)
  })

  it('cancel-path deny validates against the SDK schema', async () => {
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c' })
    const pending = fn('AskUserQuestion', { questions: [question()] }, noAbort)
    rejectQuestion(getActivePendingQuestion('c')!.id, 'cancelled')
    const res = await pending
    const parsed = permissionResultSchema.safeParse(res)
    expect(parsed.success).toBe(true)
  })

  it('abort-path deny validates against the SDK schema', async () => {
    const controller = new AbortController()
    const fn = createCanUseTool({ spaceId: 's', conversationId: 'c' })
    const pending = fn('AskUserQuestion', { questions: [question()] }, { signal: controller.signal })
    controller.abort()
    const res = await pending
    const parsed = permissionResultSchema.safeParse(res)
    expect(parsed.success).toBe(true)
  })
})
