/**
 * Pins the terminal view's end-of-life latch.
 *
 * The session mirror legitimately drops an entry once the main process forgets
 * the session, so absence of an entry is not evidence of life. Everything the
 * view gates on death — the ended banner, the keyboard, the touch key bar —
 * hangs off this fold, so a session that reverts to "not ended" hands the user
 * a live-looking terminal wired to a dead pty.
 */

import { describe, it, expect } from 'vitest'
import { latchTerminalEnd } from '../../../../src/renderer/lib/terminal-liveness'

const running = { state: 'running' as const, exitCode: null }
const exited = (exitCode: number | null) => ({ state: 'exited' as const, exitCode })

describe('latchTerminalEnd', () => {
  it('reports nothing while the session is running', () => {
    expect(latchTerminalEnd(null, running)).toBeNull()
  })

  it('reports nothing when the session was never in the mirror', () => {
    // A view opened on a session main no longer knows about relies on the
    // failed replay instead, which carries the more accurate message.
    expect(latchTerminalEnd(null, undefined)).toBeNull()
  })

  it('records the exit code when the session ends', () => {
    expect(latchTerminalEnd(null, exited(130))).toEqual({ exitCode: 130 })
  })

  it('records an end with no exit code (the pty host died with it)', () => {
    expect(latchTerminalEnd(null, exited(null))).toEqual({ exitCode: null })
  })

  it('stays ended after the entry is dropped from the mirror', () => {
    const end = latchTerminalEnd(null, exited(0))
    expect(latchTerminalEnd(end, undefined)).toBe(end)
  })

  it('keeps the first end it saw rather than re-reading the mirror', () => {
    const end = latchTerminalEnd(null, exited(0))
    expect(latchTerminalEnd(end, running)).toBe(end)
    expect(latchTerminalEnd(end, exited(1))).toBe(end)
  })
})
