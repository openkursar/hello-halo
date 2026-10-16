/**
 * Unit tests for the active-run registry + mid-run injection in
 * apps/runtime/active-runs.ts.
 *
 * Behavior under test:
 *   - register / get / isRunActive / unregister lifecycle.
 *   - injectIntoActiveRun persists the supplement to the run JSONL (writer) AND
 *     pushes it into the live SDK session (session.send), in that order.
 *   - Authorization: injecting into a run owned by a different app throws.
 *   - Validation: empty/whitespace text throws; unknown run throws.
 *   - Works when no writer is attached (no space path).
 *
 * The module is self-contained (only a type import), so no mocks are needed —
 * we pass fake session/writer objects with vitest spies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  registerActiveRun,
  unregisterActiveRun,
  getActiveRun,
  isRunActive,
  injectIntoActiveRun,
  tryInjectIntoActiveRun,
  type ActiveRunHandle,
} from '../../../../src/main/apps/runtime/active-runs'
import { openSessionWriter, readSessionMessages } from '../../../../src/main/apps/runtime/session-store'

function makeHandle(overrides: Partial<ActiveRunHandle> = {}) {
  const send = vi.fn(() => true)
  const writeTrigger = vi.fn()
  const writeEvent = vi.fn()
  const handle: ActiveRunHandle = {
    runId: 'run-1',
    appId: 'app-1',
    spaceId: 'space-1',
    triggerType: 'manual',
    startedAt: 0,
    session: { send, sendIntoLiveTurn: send },
    writer: { writeTrigger, writeEvent, writePush: vi.fn(), writeInputOutcome: vi.fn() },
    ...overrides,
  }
  return { handle, send, writeTrigger }
}

describe('active-runs: registry lifecycle', () => {
  beforeEach(() => {
    // Ensure clean state between tests (registry is module-level).
    unregisterActiveRun('run-1')
    unregisterActiveRun('run-2')
  })

  it('register makes a run discoverable; unregister removes it', () => {
    const { handle } = makeHandle()
    expect(isRunActive('run-1')).toBe(false)

    registerActiveRun(handle)
    expect(isRunActive('run-1')).toBe(true)
    expect(getActiveRun('run-1')).toBe(handle)

    unregisterActiveRun('run-1')
    expect(isRunActive('run-1')).toBe(false)
    expect(getActiveRun('run-1')).toBeUndefined()
  })

  it('unregister is idempotent', () => {
    expect(() => unregisterActiveRun('never-registered')).not.toThrow()
  })
})

describe('active-runs: injectIntoActiveRun', () => {
  beforeEach(() => {
    unregisterActiveRun('run-1')
    unregisterActiveRun('run-2')
  })

  it('accepts live input before recording it so refused input cannot appear twice', () => {
    const { handle, send, writeTrigger } = makeHandle()
    registerActiveRun(handle)

    injectIntoActiveRun('app-1', 'run-1', 'check the staging URL')

    expect(writeTrigger).toHaveBeenCalledWith('check the staging URL', undefined, undefined, undefined, undefined)
    expect(send).toHaveBeenCalledWith('check the staging URL', expect.anything())

    // Recording follows ownership transfer; a declined send leaves no false transcript entry.
    const writeOrder = writeTrigger.mock.invocationCallOrder[0]
    const sendOrder = send.mock.invocationCallOrder[0]
    expect(sendOrder).toBeLessThan(writeOrder)
  })

  it('keeps declined input with the caller and writes no transcript row', () => {
    const { handle, send, writeTrigger } = makeHandle()
    send.mockReturnValue(false)
    registerActiveRun(handle)
    expect(tryInjectIntoActiveRun('app-1', 'run-1', [{ text: 'late message' }], () => {})).toBe(false)
    expect(writeTrigger).not.toHaveBeenCalled()
  })

  it('delivers one batch while preserving each original transcript record', () => {
    const { handle, send, writeTrigger } = makeHandle()
    registerActiveRun(handle)
    expect(tryInjectIntoActiveRun('app-1', 'run-1', [{ text: 'first event' }, { text: 'second event' }], () => {})).toBe(true)
    expect(send).toHaveBeenCalledWith('first event\n\nsecond event', expect.objectContaining({ onWithdrawn: expect.any(Function) }))
    expect(writeTrigger.mock.calls.map((call) => call[0])).toEqual(['first event', 'second event'])
  })

  it('hands back the records of input a person stopped before the run read it', () => {
    const { handle, send, writeTrigger } = makeHandle()
    writeTrigger.mockReturnValueOnce({ timestamp: 't1', inputId: 'in-1' }).mockReturnValueOnce({ timestamp: 't2', inputId: 'in-2' })
    registerActiveRun(handle)
    const withdrawn = vi.fn()
    tryInjectIntoActiveRun('app-1', 'run-1', [{ text: 'first' }, { text: 'second' }], withdrawn)
    const options = (send.mock.calls[0] as unknown[])[1] as { onWithdrawn: () => void }
    options.onWithdrawn()
    expect(withdrawn).toHaveBeenCalledWith(['in-1', 'in-2'])
  })

  it('marks a person’s run-detail words a stop left unread', () => {
    const { handle, send, writeTrigger } = makeHandle()
    writeTrigger.mockReturnValueOnce({ timestamp: 't1', inputId: 'in-1' })
    registerActiveRun(handle)
    injectIntoActiveRun('app-1', 'run-1', 'one more thing')
    const options = (send.mock.calls[0] as unknown[])[1] as { onWithdrawn: () => void }
    options.onWithdrawn()
    expect(handle.writer!.writeInputOutcome).toHaveBeenCalledWith('in-1', 'stopped')
  })

  it('trims surrounding whitespace before persist + send', () => {
    const { handle, send, writeTrigger } = makeHandle()
    registerActiveRun(handle)

    injectIntoActiveRun('app-1', 'run-1', '  go back to step 2  \n')

    expect(writeTrigger).toHaveBeenCalledWith('go back to step 2', undefined, undefined, undefined, undefined)
    expect(send).toHaveBeenCalledWith('go back to step 2', expect.anything())
  })

  it('throws on empty / whitespace-only text and does not touch the session', () => {
    const { handle, send, writeTrigger } = makeHandle()
    registerActiveRun(handle)

    expect(() => injectIntoActiveRun('app-1', 'run-1', '   ')).toThrow(/empty/i)
    expect(() => injectIntoActiveRun('app-1', 'run-1', '')).toThrow(/empty/i)
    expect(send).not.toHaveBeenCalled()
    expect(writeTrigger).not.toHaveBeenCalled()
  })

  it('throws when the run is not active', () => {
    expect(() => injectIntoActiveRun('app-1', 'missing-run', 'hi')).toThrow(/No active run/i)
  })

  it('throws when the run belongs to a different app (authorization)', () => {
    const { handle, send, writeTrigger } = makeHandle()
    registerActiveRun(handle)

    expect(() => injectIntoActiveRun('other-app', 'run-1', 'hi')).toThrow(/does not belong/i)
    expect(send).not.toHaveBeenCalled()
    expect(writeTrigger).not.toHaveBeenCalled()
  })

  it('works without a writer (no space path resolved) — still sends to session', () => {
    const send = vi.fn(() => true)
    const { handle } = makeHandle({ writer: undefined, session: { send, sendIntoLiveTurn: send } })
    registerActiveRun(handle)

    expect(() => injectIntoActiveRun('app-1', 'run-1', 'continue please')).not.toThrow()
    expect(send).toHaveBeenCalledWith('continue please', expect.anything())
  })

  it('isolates concurrent runs of different apps', () => {
    const a = makeHandle({ runId: 'run-1', appId: 'app-1' })
    const b = makeHandle({ runId: 'run-2', appId: 'app-2' })
    registerActiveRun(a.handle)
    registerActiveRun(b.handle)

    injectIntoActiveRun('app-2', 'run-2', 'B message')

    expect(b.send).toHaveBeenCalledWith('B message', expect.anything())
    expect(a.send).not.toHaveBeenCalled()

    unregisterActiveRun('run-2')
  })
})

describe('active-runs: injection persistence (real JSONL round-trip)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-inject-'))
    unregisterActiveRun('run-real')
  })
  afterEach(() => {
    unregisterActiveRun('run-real')
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists the supplement so a reload renders it as a user message', () => {
    const appId = 'app-real'
    const runId = 'run-real'
    // Real writer + reader from session-store — exercises the persistence half
    // of injection (what makes a supplement survive reload + reach remote clients).
    const writer = openSessionWriter(dir, appId, runId)
    const send = vi.fn(() => true)
    registerActiveRun({
      runId,
      appId,
      spaceId: 'space-real',
      triggerType: 'manual',
      startedAt: 0,
      session: { send, sendIntoLiveTurn: send },
      writer,
    })

    injectIntoActiveRun(appId, runId, 'Use UTC for all timestamps.')

    // Live half: pushed into the session.
    expect(send).toHaveBeenCalledWith('Use UTC for all timestamps.', expect.anything())

    // Persistence half: the run JSONL now reconstructs a user message bubble.
    const messages = readSessionMessages(dir, appId, runId)
    const userMsg = messages.find(m => m.role === 'user' && m.content.includes('Use UTC for all timestamps.'))
    expect(userMsg).toBeTruthy()
  })
})
