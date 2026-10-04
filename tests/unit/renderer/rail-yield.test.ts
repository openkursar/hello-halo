/**
 * The resource rail steps aside while the canvas shows a view with its own
 * file list, or while an open rail would squeeze the canvas; it comes back by
 * itself when neither holds, a user who opens it keeps it until the canvas
 * context changes, and files the AI touches do not reopen it meanwhile.
 */

import { describe, it, expect } from 'vitest'
import {
  MIN_CANVAS_WIDTH,
  canvasTooNarrow,
  choiceIn,
  railContext,
  railMayAutoOpen,
  railYields,
  userSetRail,
  type CanvasRoom,
  type RailChoice,
} from '../../../src/renderer/utils/rail-yield'

const RAIL = 325

const room = (overrides: Partial<CanvasRoom> = {}): CanvasRoom => ({
  canvasOpen: true,
  bringsFileList: false,
  tooNarrow: false,
  ...overrides,
})

/** The choice after the canvas shows `tabId` (or closes, for null). */
const show = (choice: RailChoice, tabId: string | null): RailChoice =>
  choiceIn(choice, railContext(tabId !== null, tabId))

const fresh = (tabId: string | null): RailChoice => ({ context: railContext(tabId !== null, tabId), kept: false })

describe('when the rail steps aside', () => {
  it('steps aside for a view that brings its own file list', () => {
    expect(railYields(fresh('changes'), room({ bringsFileList: true }))).toBe(true)
  })

  it('steps aside when an open rail would leave the canvas too narrow', () => {
    // 900-wide window with the canvas open: about 370 px left for the canvas beside a 325 px rail.
    const shared = 370 + RAIL
    expect(canvasTooNarrow(shared, RAIL)).toBe(true)
    expect(railYields(fresh('code'), room({ tooNarrow: canvasTooNarrow(shared, RAIL) }))).toBe(true)
  })

  it('stays when neither holds', () => {
    expect(canvasTooNarrow(MIN_CANVAS_WIDTH + RAIL, RAIL)).toBe(false)
    expect(railYields(fresh('code'), room())).toBe(false)
  })

  it('never steps aside while no canvas sits beside the chat (closed, or a phone)', () => {
    const closed = room({ canvasOpen: false, bringsFileList: true, tooNarrow: true })
    expect(railYields(fresh(null), closed)).toBe(false)
  })
})

describe('coming back', () => {
  it('comes back when the canvas closes', () => {
    let choice = fresh('changes')
    expect(railYields(choice, room({ bringsFileList: true }))).toBe(true)
    choice = show(choice, null)
    expect(railYields(choice, room({ canvasOpen: false }))).toBe(false)
  })

  it('comes back on a tab without its own list, and steps aside again on the way back', () => {
    let choice = fresh('changes')
    choice = show(choice, 'readme')
    expect(railYields(choice, room())).toBe(false)
    choice = show(choice, 'changes')
    expect(railYields(choice, room({ bringsFileList: true }))).toBe(true)
  })

  it('comes back when the window grows and the rail fits again', () => {
    const choice = fresh('code')
    expect(railYields(choice, room({ tooNarrow: canvasTooNarrow(700, RAIL) }))).toBe(true)
    expect(railYields(choice, room({ tooNarrow: canvasTooNarrow(MIN_CANVAS_WIDTH + RAIL, RAIL) }))).toBe(false)
  })
})

describe('the user opening the rail', () => {
  it('keeps it open beside a view with its own list, and beside a narrow canvas', () => {
    const kept = userSetRail(fresh('changes'), true)
    expect(railYields(kept, room({ bringsFileList: true }))).toBe(false)
    expect(railYields(kept, room({ bringsFileList: true, tooNarrow: true }))).toBe(false)
  })

  it('keeps it while the window narrows in the same context', () => {
    const kept = userSetRail(fresh('code'), true)
    expect(railYields(choiceIn(kept, 'code'), room({ tooNarrow: true }))).toBe(false)
  })

  it('lets go when the active tab changes, and does not come back with the old tab', () => {
    let choice = userSetRail(fresh('changes'), true)
    choice = show(choice, 'other-changes')
    expect(railYields(choice, room({ bringsFileList: true }))).toBe(true)
    choice = show(choice, 'changes')
    expect(choice.kept).toBe(false)
    expect(railYields(choice, room({ bringsFileList: true }))).toBe(true)
  })

  it('lets go when the canvas closes, so reopening it starts over', () => {
    let choice = userSetRail(fresh('changes'), true)
    choice = show(choice, null)
    choice = show(choice, 'changes')
    expect(railYields(choice, room({ bringsFileList: true }))).toBe(true)
  })

  it('lets go when the user closes it again', () => {
    const choice = userSetRail(userSetRail(fresh('changes'), true), false)
    expect(railYields(choice, room({ bringsFileList: true }))).toBe(true)
  })

  it('keeps nothing while the canvas is closed', () => {
    expect(userSetRail(fresh(null), true).kept).toBe(false)
  })

  it('returns the same choice when nothing changes, so the page does not re-render', () => {
    const choice = fresh('changes')
    expect(choiceIn(choice, 'changes')).toBe(choice)
    expect(userSetRail(choice, false)).toBe(choice)
    const kept = userSetRail(choice, true)
    expect(userSetRail(kept, true)).toBe(kept)
  })
})

describe('files the AI touched', () => {
  it('do not open the rail while it steps aside for either reason', () => {
    expect(railMayAutoOpen(fresh('changes'), room({ bringsFileList: true }))).toBe(false)
    expect(railMayAutoOpen(fresh('code'), room({ tooNarrow: true }))).toBe(false)
  })

  it('open it as before otherwise, and once the user kept it', () => {
    expect(railMayAutoOpen(fresh(null), room({ canvasOpen: false }))).toBe(true)
    expect(railMayAutoOpen(fresh('code'), room())).toBe(true)
    expect(railMayAutoOpen(userSetRail(fresh('changes'), true), room({ bringsFileList: true }))).toBe(true)
  })
})
