/**
 * Unit tests for apps/runtime/turn-ending — how a turn that stopped before its
 * answer was done is recognized, and what an IM chat is told.
 *
 * The chat only has the text it is sent: a turn cut off at the step limit used
 * to arrive as a complete-looking answer, or as nothing at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { settings } = vi.hoisted(() => ({ settings: { maxTurns: undefined as number | undefined } }))

vi.mock('../../../../src/main/services/agent/user-agent-settings', () => ({
  readUserAgentSettings: () => ({ maxTurns: settings.maxTurns, digitalHumansEnabled: true }),
}))

import {
  AppChatTurnInterrupted,
  turnEndingOf,
  withTurnEndingNote,
} from '../../../../src/main/apps/runtime/turn-ending'
import type { StreamResult } from '../../../../src/main/services/agent/stream-processor'

function result(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    finalContent: 'text',
    hasMeaningfulContent: true,
    thoughts: [],
    tokenUsage: null,
    isInterrupted: false,
    wasAborted: false,
    hasErrorThought: false,
    reachedMaxTurns: false,
    ...overrides,
  } as StreamResult
}

beforeEach(() => {
  settings.maxTurns = undefined
})

describe('turnEndingOf', () => {
  it('names the step limit and an unexpected cut, and nothing else', () => {
    expect(turnEndingOf(result())).toBeUndefined()
    expect(turnEndingOf(result({ reachedMaxTurns: true }))).toBe('max_turns')
    expect(turnEndingOf(result({ isInterrupted: true }))).toBe('interrupted')
    expect(turnEndingOf(result({ reachedMaxTurns: true, isInterrupted: true }))).toBe('max_turns')
  })

  it('does not treat a stop the person asked for as one', () => {
    expect(turnEndingOf(result({ wasAborted: true, isInterrupted: true }))).toBeUndefined()
    expect(turnEndingOf(result({ wasAborted: true, reachedMaxTurns: true }))).toBeUndefined()
  })
})

describe('withTurnEndingNote', () => {
  it('follows what was written with the step limit the person can raise', () => {
    settings.maxTurns = 3

    expect(withTurnEndingNote('First half of the work.\n\n', 'max_turns'))
      .toBe('First half of the work.\n\n（已达到单次最多 3 步的上限，回复“继续”可接着做）')
  })

  it('names the default limit when none is set', () => {
    expect(withTurnEndingNote('', 'max_turns')).toBe('（已达到单次最多 999 步的上限，回复“继续”可接着做）')
  })

  it('stands alone when nothing was written', () => {
    expect(withTurnEndingNote('  \n', 'interrupted')).toBe('（本轮意外中断，回复“继续”可接着做）')
  })

  it('says a cut-off turn can be carried on', () => {
    expect(withTurnEndingNote('Partial', 'interrupted')).toBe('Partial\n\n（本轮意外中断，回复“继续”可接着做）')
  })
})

describe('AppChatTurnInterrupted', () => {
  it('is an error its catcher can tell apart from a model error', () => {
    const error = new AppChatTurnInterrupted()
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('The model response was interrupted.')
  })
})
