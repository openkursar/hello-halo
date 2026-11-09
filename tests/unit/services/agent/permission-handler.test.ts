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
  return { question: 'q?', header: 'h', options: [{ label: 'a', description: 'd' }, { label: 'b', description: 'other' }], multiSelect: false }
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

  it('denies AskUserQuestion without an answer channel instead of inventing an empty answer', async () => {
    const fn = createCanUseTool()
    const res = await fn('AskUserQuestion', { questions: [question()] }, noAbort)
    expect(res).toMatchObject({ behavior: 'deny', message: expect.stringContaining('No user answer channel') })
    expect(emitAgentEvent).not.toHaveBeenCalled()
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

    expect(resolveQuestion(active!.id, { 'q?': 'a' })).toBe(true)
    const res = await pending
    expect(res).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'q?': 'a' } } })
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

  it.each<Record<string, string>>([{}, { '0': 'a' }, { 'q?': '' }, { 'q?': '   ' }, { unrelated: 'a' }, { 'q?': 'a', extra: 'b' }])('keeps an invalid submission pending for correction: %j', async answers => {
    const pending = createCanUseTool({ spaceId: 's', conversationId: 'c' })('AskUserQuestion', { questions: [question()] }, noAbort)
    const id = getActivePendingQuestion('c')!.id
    expect(resolveQuestion(id, answers)).toBe(false)
    expect(getActivePendingQuestion('c')?.id).toBe(id)
    expect(resolveQuestion(id, { 'q?': 'a' })).toBe(true)
    expect((await pending).behavior).toBe('allow')
    expect(resolveQuestion(id, { 'q?': 'a' })).toBe(false)
  })

  it('requires an answer for every question and preserves custom and multi-select values', async () => {
    const questions = [question(), { ...question(), question: 'Other question?', multiSelect: true }]
    const pending = createCanUseTool({ spaceId: 's', conversationId: 'c' })('AskUserQuestion', { questions }, noAbort)
    const id = getActivePendingQuestion('c')!.id
    expect(resolveQuestion(id, { 'q?': 'Custom answer' })).toBe(false)
    const answers = { 'q?': 'Custom answer', 'Other question?': 'a, b' }
    expect(resolveQuestion(id, answers)).toBe(true)
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { questions, answers } })
  })

  it.each([{ questions: [] }, { questions: [question(), question()] }, { questions: [{ ...question(), question: '' }] }, { questions: [{ ...question(), options: [] }] }])('refuses unanswerable questions before publishing a card: %j', async ({ questions }) => {
    const result = await createCanUseTool({ spaceId: 's', conversationId: 'c' })('AskUserQuestion', { questions }, noAbort)
    expect(result.behavior).toBe('deny')
    expect(emitAgentEvent).not.toHaveBeenCalled()
    expect(getActivePendingQuestion('c')).toBeNull()
  })

  it('logs correlation and counts without recording private questions or answers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const remove = vi.spyOn(noAbort.signal, 'removeEventListener')
    const questions = [{ ...question(), question: 'PRIVATE_QUESTION' }]
    const pending = createCanUseTool({ spaceId: 's', conversationId: 'c' })('AskUserQuestion', { questions }, { ...noAbort, toolUseID: 'tool-correlation' })
    resolveQuestion(getActivePendingQuestion('c')!.id, { PRIVATE_QUESTION: 'PRIVATE_ANSWER' })
    await pending
    const output = JSON.stringify(log.mock.calls)
    expect(output).toContain('toolUseId=tool-correlation')
    expect(output).toContain('questions=1, answers=1')
    expect(output).not.toContain('PRIVATE_QUESTION')
    expect(output).not.toContain('PRIVATE_ANSWER')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    log.mockRestore()
    remove.mockRestore()
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
