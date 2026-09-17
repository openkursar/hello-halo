/**
 * Unit tests for the escalation turn-cut rule and the multi-question shape.
 *
 * The behaviour being pinned: a turn that asks the user a question ends at that
 * point, and it ends only once the tool call that asked is complete in the
 * transcript. Cutting earlier leaves a tool call with no result — a transcript
 * some engines refuse to resume, which would strand the very conversation the
 * user's answer is meant to return to.
 */

import { describe, it, expect } from 'vitest'
import { TurnCutPoint } from '../../../../src/main/apps/runtime/escalation-cut'
import {
  getEscalationQuestions,
  formatEscalationAnswer,
} from '../../../../src/shared/apps/app-types'
import type { ActivityEntryContent } from '../../../../src/shared/apps/app-types'

// ============================================
// Helpers
// ============================================

function assistantToolUse(...ids: string[]) {
  return {
    type: 'assistant',
    message: { content: ids.map(id => ({ type: 'tool_use', id, name: 'mcp__halo-report__report_to_user' })) },
  }
}

function toolResults(...toolUseIds: string[]) {
  return {
    type: 'user',
    message: { content: toolUseIds.map(tool_use_id => ({ type: 'tool_result', tool_use_id })) },
  }
}

// ============================================
// TurnCutPoint
// ============================================

describe('TurnCutPoint', () => {
  it('does not offer a cut before the tool call has its result', () => {
    const cut = new TurnCutPoint()
    expect(cut.observe({ type: 'system', subtype: 'init' })).toBe(false)
    expect(cut.observe(assistantToolUse('call-1'))).toBe(false)
  })

  it('offers the cut on the tool result', () => {
    const cut = new TurnCutPoint()
    cut.observe(assistantToolUse('call-1'))
    expect(cut.observe(toolResults('call-1'))).toBe(true)
  })

  it('waits for every parallel call, not just the one that asked', () => {
    // The escalation may be one of several tools invoked in the same step;
    // cutting after the first result would leave the others unanswered.
    const cut = new TurnCutPoint()
    cut.observe(assistantToolUse('call-1', 'call-2'))
    expect(cut.observe(toolResults('call-1'))).toBe(false)
    expect(cut.observe(toolResults('call-2'))).toBe(true)
  })

  it('never offers a cut on an assistant message, however late', () => {
    // A `system` or `assistant` frame can arrive while the escalation tool is
    // still mid-flight, and would otherwise look like a safe stopping point.
    const cut = new TurnCutPoint()
    cut.observe(assistantToolUse('call-1'))
    cut.observe(toolResults('call-1'))
    expect(cut.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] } })).toBe(false)
  })

  it('ignores messages carrying no content blocks', () => {
    const cut = new TurnCutPoint()
    expect(cut.observe(null)).toBe(false)
    expect(cut.observe({ type: 'result' })).toBe(false)
    expect(cut.observe({ type: 'user', message: { content: 'plain text' } })).toBe(true)
  })
})

// ============================================
// Question / answer shape
// ============================================

describe('getEscalationQuestions', () => {
  it('reads a single-question escalation out of the summary', () => {
    const content: ActivityEntryContent = { summary: 'Ship it?', choices: ['Yes', 'No'] }
    expect(getEscalationQuestions(content)).toEqual([{ question: 'Ship it?', choices: ['Yes', 'No'] }])
  })

  it('still reads entries written before the question moved into summary', () => {
    const content: ActivityEntryContent = { summary: 'A decision is needed', question: 'Ship it?' }
    expect(getEscalationQuestions(content)).toEqual([{ question: 'Ship it?' }])
  })

  it('returns the asked decisions when several were asked', () => {
    const content: ActivityEntryContent = {
      summary: 'Three things before I can release',
      questions: [{ question: 'Version?' }, { question: 'Channel?', choices: ['beta', 'stable'] }],
    }
    expect(getEscalationQuestions(content)).toHaveLength(2)
  })
})

describe('formatEscalationAnswer', () => {
  const multi: ActivityEntryContent = {
    summary: 'Two things before I can release',
    questions: [{ question: 'Version?' }, { question: 'Channel?' }],
  }

  it('renders a single answer as plain text', () => {
    const questions = getEscalationQuestions({ summary: 'Ship it?' })
    expect(formatEscalationAnswer(questions, { choice: 'Yes' })).toBe('Yes')
  })

  it('keeps both a chosen option and the typed note', () => {
    const questions = getEscalationQuestions({ summary: 'Ship it?' })
    expect(formatEscalationAnswer(questions, { choice: 'Yes', text: 'but hold the email' }))
      .toBe('Yes — but hold the email')
  })

  it('pairs each answer with the question it belongs to', () => {
    const rendered = formatEscalationAnswer(getEscalationQuestions(multi), {
      answers: [{ text: '2.1.0' }, { choice: 'stable' }],
    })
    expect(rendered).toBe('1. Version?\n   → 2.1.0\n2. Channel?\n   → stable')
  })

  it('names a question left unanswered rather than shifting the ones after it', () => {
    const rendered = formatEscalationAnswer(getEscalationQuestions(multi), {
      answers: [{ text: '2.1.0' }],
    })
    expect(rendered).toContain('2. Channel?\n   → (not answered)')
  })

  it('reads the answer list even when it holds a single answer', () => {
    // A model may send `questions` with one entry; the answer still arrives in
    // `answers`, and reading `choice`/`text` there would render nothing.
    const questions = getEscalationQuestions({ summary: 'Framing', questions: [{ question: 'Ship it?' }] })
    expect(formatEscalationAnswer(questions, { answers: [{ choice: 'Yes' }] })).toBe('Yes')
  })
})
