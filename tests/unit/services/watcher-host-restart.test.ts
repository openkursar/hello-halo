/**
 * Worker crash-restart pacing. A worker that dies on the same replayed input
 * used to restart every second forever; restarts now back off and stop at a cap.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('child_process', () => ({ fork: vi.fn() }))

import {
  RestartBackoff,
  RESTART_BASE_DELAY_MS,
  RESTART_MAX_DELAY_MS,
  MAX_RESTARTS_IN_WINDOW,
  RESTART_WINDOW_MS,
} from '../../../src/main/services/watcher-host.service'

describe('RestartBackoff', () => {
  it('doubles the delay per crash up to the maximum', () => {
    const backoff = new RestartBackoff()
    const delays: Array<number | null> = []
    for (let i = 0; i < MAX_RESTARTS_IN_WINDOW; i++) delays.push(backoff.nextDelay(i * 10))

    expect(delays[0]).toBe(RESTART_BASE_DELAY_MS)
    expect(delays[1]).toBe(RESTART_BASE_DELAY_MS * 2)
    for (const d of delays) expect(d).toBeLessThanOrEqual(RESTART_MAX_DELAY_MS)
  })

  it('stops restarting once the crash cap is reached within the window', () => {
    const backoff = new RestartBackoff()
    for (let i = 0; i < MAX_RESTARTS_IN_WINDOW; i++) expect(backoff.nextDelay(i)).not.toBeNull()
    expect(backoff.nextDelay(MAX_RESTARTS_IN_WINDOW)).toBeNull()
  })

  it('forgets crashes older than the window', () => {
    const backoff = new RestartBackoff()
    for (let i = 0; i < MAX_RESTARTS_IN_WINDOW; i++) backoff.nextDelay(i)
    expect(backoff.nextDelay(RESTART_WINDOW_MS + MAX_RESTARTS_IN_WINDOW)).toBe(RESTART_BASE_DELAY_MS)
  })
})
