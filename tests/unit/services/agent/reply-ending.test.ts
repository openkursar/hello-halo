/**
 * How a finished stream left its reply, as the record keeps it: the same cases
 * the end-of-turn notice speaks about, and nothing for a failure (the reply's
 * error says it) or for a stop Halo made to wait for the person's answer.
 */

import { describe, expect, it } from 'vitest'
import { replyEndingOf } from '../../../../src/main/services/agent/reply-ending'

const finished = { hasErrorThought: false, drainTimedOut: false, reachedMaxTurns: false, wasAborted: false, isInterrupted: false }

describe('replyEndingOf', () => {
  it('says nothing about a reply that finished', () => {
    expect(replyEndingOf(finished)).toBeUndefined()
  })

  it('records a stop by the person or by the collaborator that assigned the work', () => {
    expect(replyEndingOf({ ...finished, wasAborted: true, isInterrupted: true, stopReason: 'user' })).toBe('stopped')
    expect(replyEndingOf({ ...finished, wasAborted: true, stopReason: 'controller' })).toBe('stopped')
    expect(replyEndingOf({ ...finished, wasAborted: true })).toBe('stopped')
  })

  it('records a reply that was cut off, including a stop the engine never acknowledged', () => {
    expect(replyEndingOf({ ...finished, isInterrupted: true })).toBe('interrupted')
    expect(replyEndingOf({ ...finished, wasAborted: true, stopReason: 'user', drainTimedOut: true })).toBe('interrupted')
  })

  it('records the step limit, however the turn was closed', () => {
    expect(replyEndingOf({ ...finished, reachedMaxTurns: true, isInterrupted: true })).toBe('step-limit')
    expect(replyEndingOf({ ...finished, reachedMaxTurns: true, wasAborted: true, stopReason: 'internal' })).toBe('step-limit')
  })

  it('leaves a failure to the reply’s error and a deliberate pause unmarked', () => {
    expect(replyEndingOf({ ...finished, hasErrorThought: true, isInterrupted: true })).toBeUndefined()
    expect(replyEndingOf({ ...finished, wasAborted: true, stopReason: 'internal', isInterrupted: true })).toBeUndefined()
  })
})
