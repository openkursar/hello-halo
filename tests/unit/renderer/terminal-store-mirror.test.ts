/**
 * Pins the renderer session mirror to the one rule that keeps it honest: an
 * entry leaves the map only when the main process says so.
 *
 * The mirror has no way to work out which sessions the pty host kept. The host
 * exempts the session that just exited from its own pruning, and orders the
 * rest by `lastActivityAt`, which an exit does not refresh — so a terminal that
 * idled for hours before dying is simultaneously the one the host retains and
 * the "oldest" one any local retention rule would evict first. A mirror that
 * guesses drops the entry the user is looking at, and the viewer reading that
 * entry silently reverts to looking alive.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { setTerminalTitle: vi.fn(), openTerminal: vi.fn() }
}))

const { useTerminalStore } = await import('../../../src/renderer/stores/terminal.store')

type Info = ReturnType<typeof info>

function info(id: string, state: 'running' | 'exited', lastActivityAt: number) {
  return {
    id,
    title: id,
    shell: '/bin/zsh',
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    owner: 'user' as const,
    aiTouched: false,
    state,
    exitCode: state === 'exited' ? 0 : null,
    lastActivityAt,
    createdAt: 0
  }
}

const apply = (e: Parameters<ReturnType<typeof useTerminalStore.getState>['applyLifecycle']>[0]) =>
  useTerminalStore.getState().applyLifecycle(e)

/** Run a session through create → (exit), the way main reports it. */
function live(s: Info): void {
  apply({ sessionId: s.id, type: 'created', info: { ...s, state: 'running' } })
  if (s.state === 'exited') apply({ sessionId: s.id, type: 'exited', info: s })
}

const sessions = () => useTerminalStore.getState().sessions

describe('terminal store / mirror of the main-process registry', () => {
  beforeEach(() => {
    useTerminalStore.setState({ sessions: new Map(), operating: new Set(), operators: new Map() })
  })

  it('keeps a long-idle session that exits behind many fresher ones', () => {
    // The pty host's retention is full of terminals that were busy recently...
    for (let i = 0; i < 8; i++) live(info(`busy-${i}`, 'exited', 1_000 + i))
    // ...when a terminal that has been sitting idle since startup finally dies.
    // The host keeps it (it is the session that just exited); so must the mirror.
    live(info('idle', 'exited', 1))

    expect(sessions().has('idle')).toBe(true)
    expect(sessions().get('idle')?.state).toBe('exited')
  })

  it('never drops an entry on its own, however many sessions have ended', () => {
    for (let i = 0; i < 40; i++) live(info(`dead-${i}`, 'exited', i))
    expect(sessions().size).toBe(40)
  })

  it('shrinks to whatever main kept, once main reports the removals', () => {
    for (let i = 0; i < 40; i++) live(info(`dead-${i}`, 'exited', i))
    for (let i = 0; i < 32; i++) apply({ sessionId: `dead-${i}`, type: 'removed' })

    expect(sessions().size).toBe(8)
    expect(sessions().has('dead-0')).toBe(false)
    expect(sessions().has('dead-39')).toBe(true)
  })

  it('tracks whether the AI is operating a session and whose conversation it is', () => {
    live(info('t1', 'running', 0))
    apply({ sessionId: 't1', type: 'ai-activity', info: info('t1', 'running', 0), operating: true, conversationId: 'conv-1' })
    expect(useTerminalStore.getState().operating.has('t1')).toBe(true)
    expect(useTerminalStore.getState().operators.get('t1')).toBe('conv-1')

    apply({ sessionId: 't1', type: 'ai-activity', info: info('t1', 'running', 0), operating: false })
    expect(useTerminalStore.getState().operating.has('t1')).toBe(false)
    expect(useTerminalStore.getState().operators.get('t1')).toBe('conv-1')
  })

  it('forgets the operating state of a session that ended or was removed', () => {
    live(info('t1', 'running', 0))
    apply({ sessionId: 't1', type: 'ai-activity', info: info('t1', 'running', 0), operating: true, conversationId: 'conv-1' })
    apply({ sessionId: 't1', type: 'exited', info: info('t1', 'exited', 0) })
    expect(useTerminalStore.getState().operating.size).toBe(0)
    expect(useTerminalStore.getState().operators.size).toBe(0)

    live(info('t2', 'running', 0))
    apply({ sessionId: 't2', type: 'ai-activity', info: info('t2', 'running', 0), operating: true, conversationId: 'conv-2' })
    apply({ sessionId: 't2', type: 'removed' })
    expect(sessions().has('t2')).toBe(false)
    expect(useTerminalStore.getState().operating.size).toBe(0)
    expect(useTerminalStore.getState().operators.size).toBe(0)
  })

  it('reconciles an authenticated client snapshot with a running operator and newer lifecycle events', () => {
    live(info('old', 'running', 0))
    live(info('removed-during-read', 'running', 0))
    apply({ type: 'removed', sessionId: 'removed-during-read' })
    apply({ type: 'created', sessionId: 'new-live', info: info('new-live', 'running', 2) })
    const state = useTerminalStore.getState()
    state.applySnapshot([
      { ...info('removed-during-read', 'running', 0), operating: true },
      { ...info('still-working', 'running', 4), operating: true, conversationId: 'active-chat' },
      { ...info('idle', 'running', 1), operating: false, conversationId: 'previous-chat' },
    ], new Set(['session:removed-during-read', 'activity:removed-during-read', 'session:new-live']))
    expect([...sessions().keys()].sort()).toEqual(['idle', 'new-live', 'still-working'])
    expect(useTerminalStore.getState().operating).toEqual(new Set(['still-working']))
    expect(useTerminalStore.getState().operators).toEqual(new Map([['still-working', 'active-chat'], ['idle', 'previous-chat']]))
  })

  it('ignores a removal for a session it never saw', () => {
    live(info('t1', 'running', 0))
    apply({ sessionId: 'unknown', type: 'removed' })
    expect(sessions().size).toBe(1)
    expect(useTerminalStore.getState().runningSessions().map(s => s.id)).toEqual(['t1'])
  })
})
