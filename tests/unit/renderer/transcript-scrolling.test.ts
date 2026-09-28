/**
 * Transcript scrolling primitives: the history window's reset rule, row
 * containment classes, and message-relative reading positions.
 *
 * Layout is stubbed (the unit tier has no DOM); the live follow/detach and
 * paging behavior is covered by the perf S3 scenario in a real window.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { windowStartAfterCountChange } from '../../../src/renderer/components/chat/transcript/useHistoryWindow'
import { transcriptRowClass } from '../../../src/renderer/components/chat/transcript/row'
import {
  captureTranscriptPosition,
  restoreTranscriptPosition,
  centerRowInView,
} from '../../../src/renderer/components/chat/transcript/position'

describe('history window start', () => {
  it('keeps its start when rows are appended, so the window grows with the conversation', () => {
    expect(windowStartAfterCountChange({ start: 60, count: 100 }, 101, 40)).toBe(60)
  })

  it('keeps already-mounted older pages when a row is appended', () => {
    expect(windowStartAfterCountChange({ start: 0, count: 100 }, 102, 40)).toBe(0)
  })

  it('does not unmount rows when one trailing row is filtered out mid-turn', () => {
    expect(windowStartAfterCountChange({ start: 20, count: 100 }, 99, 40)).toBe(20)
  })

  it('starts from the tail when the first batch arrives into an empty list', () => {
    expect(windowStartAfterCountChange({ start: 0, count: 0 }, 250, 40)).toBe(210)
  })

  it('starts from the tail when the list shrinks to or below the window start', () => {
    expect(windowStartAfterCountChange({ start: 60, count: 100 }, 60, 40)).toBe(20)
    expect(windowStartAfterCountChange({ start: 60, count: 100 }, 10, 40)).toBe(0)
  })

  it('mounts everything when the list is shorter than the initial window', () => {
    expect(windowStartAfterCountChange({ start: 0, count: 0 }, 12, 40)).toBe(0)
  })
})

describe('transcript row containment', () => {
  it('contains every row and estimates user rows shorter than replies', () => {
    const user = transcriptRowClass({ role: 'user' })
    const reply = transcriptRowClass({ role: 'assistant' })
    expect(user).toContain('[content-visibility:auto]')
    expect(reply).toContain('[content-visibility:auto]')
    expect(user).toContain('auto_96px')
    expect(reply).toContain('auto_240px')
  })
})

type Rect = { top: number; left: number; width: number; height: number }

function fakeElement(rect: () => Rect, extra: Record<string, unknown> = {}) {
  return {
    getBoundingClientRect: () => rect(),
    ...extra,
  } as unknown as HTMLElement
}

describe('reading position', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('records "at the end" while following', () => {
    const scroller = fakeElement(() => ({ top: 0, left: 0, width: 800, height: 600 }))
    expect(captureTranscriptPosition(scroller, true)).toBeNull()
  })

  it('records the message under the top edge and how far into it the view is', () => {
    const row = { dataset: { messageId: 'm-7' }, getBoundingClientRect: () => ({ top: 70 }) }
    const hit = { closest: () => row }
    const scroller = {
      getBoundingClientRect: () => ({ top: 100, left: 0, width: 800, height: 600 }),
      contains: () => true,
    } as unknown as HTMLElement
    vi.stubGlobal('document', { elementFromPoint: () => hit })
    expect(captureTranscriptPosition(scroller, false)).toEqual({ messageId: 'm-7', offset: -30 })
  })

  it('falls back to "at the end" when nothing identifiable is under the top edge', () => {
    const scroller = {
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }),
      contains: () => false,
    } as unknown as HTMLElement
    vi.stubGlobal('document', { elementFromPoint: () => null })
    expect(captureTranscriptPosition(scroller, false)).toBeNull()
  })

  it('restores by moving the recorded message back to its recorded offset', () => {
    let scrollTop = 1000
    const row = fakeElement(() => ({ top: 400 - (scrollTop - 1000), left: 0, width: 0, height: 0 }))
    const scroller = {
      getBoundingClientRect: () => ({ top: 100, left: 0, width: 800, height: 600 }),
      querySelector: () => row,
      get scrollTop() { return scrollTop },
      set scrollTop(v: number) { scrollTop = v },
    } as unknown as HTMLElement
    vi.stubGlobal('CSS', { escape: (s: string) => s })
    expect(restoreTranscriptPosition(scroller, { messageId: 'm-7', offset: -30 })).toBe(true)
    expect(row.getBoundingClientRect().top - 100).toBe(-30)
  })

  it('reports a missing message so the caller can fall back to the end', () => {
    const scroller = { querySelector: () => null } as unknown as HTMLElement
    vi.stubGlobal('CSS', { escape: (s: string) => s })
    expect(restoreTranscriptPosition(scroller, { messageId: 'gone', offset: 0 })).toBe(false)
  })

  it('centers a row by scrolling only the transcript', () => {
    const scrollTo = vi.fn()
    const scroller = {
      scrollTop: 500,
      scrollHeight: 10000,
      clientHeight: 600,
      scrollTo,
      getBoundingClientRect: () => ({ top: 100, left: 0, width: 800, height: 600 }),
    } as unknown as HTMLElement
    const row = fakeElement(() => ({ top: 900, left: 0, width: 800, height: 200 }))
    centerRowInView(scroller, row, 'smooth')
    // Row top is 800px below the scroller top; centering a 200px row in 600px leaves 200px above it.
    expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 800 - 200, behavior: 'smooth' })
  })

  it('clamps a centering target to what the transcript can reach', () => {
    const scrollTo = vi.fn()
    const scroller = {
      scrollTop: 100,
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTo,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }),
    } as unknown as HTMLElement
    centerRowInView(scroller, fakeElement(() => ({ top: -80, left: 0, width: 800, height: 40 })))
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
    centerRowInView(scroller, fakeElement(() => ({ top: 5000, left: 0, width: 800, height: 40 })))
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1400, behavior: 'auto' })
  })
})
