import { readFileSync } from 'fs'
import { join } from 'path'
/**
 * Transcript scrolling primitives: the history window's reset rule, row
 * containment classes, and message-relative reading positions.
 *
 * Layout is stubbed (the unit tier has no DOM); the live follow/detach and
 * paging behavior is covered by the perf S3 scenario in a real window.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { windowStartAfterCountChange, pageUp, pageDown, liveAround, liveAtEnd, liveRangeAfterKeysChange, recoverViewport, rowIndexAt, type LiveRange } from '../../../src/renderer/components/chat/transcript/useHistoryWindow'
import { estimatedRowHeight, transcriptRowClass } from '../../../src/renderer/components/chat/transcript/row'
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

describe('live-row cap', () => {
  const CAP = 300
  const keys = (n: number, prefix = 'k') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

  it('paging up past the cap mounts older rows and retires the newest', () => {
    // 2,000 rows, reader has paged up to 300 live rows at the tail.
    let range: LiveRange = { start: 1700, liveStart: 1700, liveEnd: null }
    range = pageUp(range, 2000, 30, CAP)
    expect(range).toEqual({ start: 1670, liveStart: 1670, liveEnd: 1970 })
    range = pageUp(range, 2000, 30, CAP)
    expect(range).toEqual({ start: 1640, liveStart: 1640, liveEnd: 1940 })
  })

  it('paging down brings retired rows back and retires the oldest; reaching the end follows it again', () => {
    let range: LiveRange = { start: 1640, liveStart: 1640, liveEnd: 1940 }
    range = pageDown(range, 2000, 30, CAP)
    expect(range).toEqual({ start: 1640, liveStart: 1670, liveEnd: 1970 })
    range = pageDown(range, 2000, 30, CAP)
    expect(range).toEqual({ start: 1640, liveStart: 1700, liveEnd: null })
  })

  it('paging up first brings back retired rows above before mounting older history', () => {
    const range = pageUp({ start: 1640, liveStart: 1700, liveEnd: null }, 2000, 30, CAP)
    expect(range).toEqual({ start: 1640, liveStart: 1670, liveEnd: 1970 })
  })

  it('never keeps more than the cap live, and below the cap never retires anything', () => {
    expect(pageUp({ start: 100, liveStart: 100, liveEnd: null }, 200, 30, CAP)).toEqual({ start: 70, liveStart: 70, liveEnd: null })
    const far = liveAround({ start: 1700, liveStart: 1700, liveEnd: null }, 2000, 10, CAP)
    expect(far).toEqual({ start: 5, liveStart: 5, liveEnd: 305 })
  })

  it('jumping to the end makes the newest rows live and leaves mounted rows as placeholders', () => {
    expect(liveAtEnd({ start: 5, liveStart: 5, liveEnd: 305 }, 2000, CAP)).toEqual({ start: 5, liveStart: 1700, liveEnd: null })
  })

  it('rows appended while following the end push the oldest live rows out', () => {
    const prev = { start: 1700, liveStart: 1700, liveEnd: null, count: 2000, firstKey: 'k0' }
    const next = liveRangeAfterKeysChange(prev, keys(2002), 40, CAP)
    expect(next).toMatchObject({ start: 1700, liveStart: 1702, liveEnd: null, prepended: 0 })
  })

  it('rows appended while the reader is far up stay outside the live range', () => {
    const prev = { start: 1640, liveStart: 1640, liveEnd: 1940, count: 2000, firstKey: 'k0' }
    expect(liveRangeAfterKeysChange(prev, keys(2003), 40, CAP)).toMatchObject({ liveStart: 1640, liveEnd: 1940 })
  })

  it('a page prepended in front shifts the live range with the rows it showed', () => {
    const prev = { start: 10, liveStart: 20, liveEnd: 200, count: 400, firstKey: 'k0' }
    const next = liveRangeAfterKeysChange(prev, [...keys(50, 'old'), ...keys(400)], 40, CAP)
    expect(next).toMatchObject({ start: 60, liveStart: 70, liveEnd: 250, prepended: 50 })
  })

  it('a cleared list starts again from the tail with everything live', () => {
    const prev = { start: 1640, liveStart: 1700, liveEnd: null, count: 2000, firstKey: 'k0' }
    expect(liveRangeAfterKeysChange(prev, keys(3, 'new'), 40, CAP)).toMatchObject({ start: 0, liveStart: 0, liveEnd: null })
  })
})

describe('row height estimates', () => {
  it('tier replies by length, and the class matches the estimate', () => {
    const reply = (n: number) => ({ role: 'assistant' as const, content: 'x'.repeat(n) })
    expect(estimatedRowHeight({ role: 'user', content: 'x'.repeat(5000) })).toBe(96)
    expect(estimatedRowHeight(reply(100))).toBe(240)
    expect(estimatedRowHeight(reply(1400))).toBe(600)
    expect(estimatedRowHeight(reply(8000))).toBe(1000)
    for (const n of [100, 1400, 8000]) {
      expect(transcriptRowClass(reply(n))).toContain(`auto_${estimatedRowHeight(reply(n))}px`)
    }
  })
})

describe('viewport that jumped past the live rows', () => {
  const CAP = 300
  const view = (probe: Partial<{ showsLive: boolean; rowAtTop: number | null; atEnd: boolean }>) =>
    ({ showsLive: false, rowAtTop: null, atEnd: false, ...probe })

  it('jump far below (scrollbar drag into retired rows): the rows under the viewport come back', () => {
    const range: LiveRange = { start: 0, liveStart: 0, liveEnd: 300 }
    expect(recoverViewport(range, 2000, view({ rowAtTop: 1500 }), CAP)).toEqual({ start: 0, liveStart: 1495, liveEnd: 1795 })
  })

  it('jump far above (Home, or a click high in the track): the rows under the viewport come back', () => {
    const range: LiveRange = { start: 1000, liveStart: 1700, liveEnd: null }
    expect(recoverViewport(range, 2000, view({ rowAtTop: 1100 }), CAP)).toEqual({ start: 1000, liveStart: 1095, liveEnd: 1395 })
  })

  it('reaching the end while the newest rows are retired makes them live, so following resumes on real rows', () => {
    const range: LiveRange = { start: 0, liveStart: 0, liveEnd: 300 }
    expect(recoverViewport(range, 2000, view({ atEnd: true, rowAtTop: 1990 }), CAP)).toEqual({ start: 0, liveStart: 1700, liveEnd: null })
  })

  it('rows appended afterwards are live, not placeholders', () => {
    const atEnd = recoverViewport({ start: 0, liveStart: 0, liveEnd: 300 }, 2000, view({ atEnd: true }), CAP)!
    const next = liveRangeAfterKeysChange({ ...atEnd, count: 2000, firstKey: 'k0' }, Array.from({ length: 2002 }, (_, i) => `k${i}`), 40, CAP)
    expect(next.liveEnd).toBeNull()
  })

  it('leaves the window alone while the viewport shows live rows', () => {
    expect(recoverViewport({ start: 0, liveStart: 100, liveEnd: 400 }, 2000, view({ showsLive: true, rowAtTop: 150 }), CAP)).toBeNull()
  })

  it('with no row under the viewport and newer rows retired, goes to the end', () => {
    expect(recoverViewport({ start: 0, liveStart: 0, liveEnd: 300 }, 2000, view({}), CAP)).toEqual({ start: 0, liveStart: 1700, liveEnd: null })
  })
})

describe('finding the row at the viewport top', () => {
  // Rows 100..119, 50 px each, starting at y = 1000.
  const bottomOf = (index: number) => (index >= 100 && index <= 119 ? 1000 + (index - 99) * 50 : null)

  it('uses row geometry, so an overlay over the transcript cannot hide the row', () => {
    // An overlay covering y = 1201 is irrelevant: no hit-testing is involved.
    expect(rowIndexAt(100, 119, bottomOf, 1201)).toBe(104)
    expect(rowIndexAt(100, 119, bottomOf, 1000)).toBe(100)
    expect(rowIndexAt(100, 119, bottomOf, 1049)).toBe(100)
    expect(rowIndexAt(100, 119, bottomOf, 1050)).toBe(101)
  })

  it('returns null below every row or for an empty range', () => {
    expect(rowIndexAt(100, 119, bottomOf, 2000)).toBeNull()
    expect(rowIndexAt(5, 4, bottomOf, 0)).toBeNull()
  })

  it('the history window does not hit-test for it', () => {
    const source = readFileSync(join(__dirname, '../../../src/renderer/components/chat/transcript/useHistoryWindow.ts'), 'utf8')
    expect(source).not.toMatch(/elementFromPoint/)
  })
})
