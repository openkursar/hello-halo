/**
 * Tests for the terminal context's lifecycle policy around kill and worker
 * exit events. The renderer store reconciles exclusively on the 'exited'
 * lifecycle event (SSOT), so every termination path — user kill, instant shell
 * death racing create, worker crash — must emit exactly one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TerminalInfo } from '../../../../src/main/services/ai-terminal'

type Handler<T> = (arg: T) => void

const hostMock = vi.hoisted(() => {
  const state: {
    eventHandler: Handler<unknown> | null
    crashHandler: (() => void) | null
  } = { eventHandler: null, crashHandler: null }
  return {
    state,
    ptyHostNotify: vi.fn(),
    ptyHostRequest: vi.fn(),
    shutdownPtyHost: vi.fn(async () => {})
  }
})

vi.mock('../../../../src/main/services/ai-terminal/host', () => ({
  ptyHostNotify: hostMock.ptyHostNotify,
  ptyHostRequest: hostMock.ptyHostRequest,
  shutdownPtyHost: hostMock.shutdownPtyHost,
  setPtyHostEventHandler: (h: Handler<unknown>) => { hostMock.state.eventHandler = h },
  setPtyHostCrashHandler: (h: () => void) => { hostMock.state.crashHandler = h }
}))

vi.mock('../../../../src/main/services/ai-terminal/shell', () => ({
  resolveShell: () => ({ file: '/bin/zsh', args: [], family: 'posix' })
}))

import { TerminalContext } from '../../../../src/main/services/ai-terminal/context'

function makeInfo(id: string, state: 'running' | 'exited' = 'running'): TerminalInfo {
  return {
    id,
    title: 'zsh',
    shell: '/bin/zsh',
    cwd: '/tmp',
    cols: 80,
    rows: 30,
    owner: 'user',
    aiTouched: false,
    state,
    exitCode: state === 'exited' ? 0 : null,
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
    spaceId: 'space-1'
  }
}

let ctx: TerminalContext
let lifecycle: Array<{ sessionId: string; type: string; info?: TerminalInfo }>

async function createSession(id: string): Promise<void> {
  hostMock.ptyHostRequest.mockResolvedValueOnce({ info: makeInfo(id) })
  await ctx.create({ owner: 'user', spaceId: 'space-1' })
}

const workerExit = (id: string): void => {
  hostMock.state.eventHandler?.({ type: 'exit', sessionId: id, exitCode: 0, info: makeInfo(id, 'exited') })
}

beforeEach(() => {
  vi.clearAllMocks()
  ctx = new TerminalContext('/tmp')
  lifecycle = []
  ctx.on('lifecycle', (e) => lifecycle.push(e))
})

describe('TerminalContext kill / exit lifecycle', () => {
  it('emits exited exactly once when the worker confirms a kill', async () => {
    await createSession('t1')
    expect(ctx.kill('t1')).toBe(true)
    // The proxy stays registered until the worker's exit event arrives.
    expect(ctx.get('t1')).toBeDefined()
    expect(lifecycle.filter(e => e.type === 'exited')).toHaveLength(0)

    workerExit('t1')
    const exited = lifecycle.filter(e => e.type === 'exited')
    expect(exited).toHaveLength(1)
    expect(exited[0].info?.state).toBe('exited')
    // Killed sessions are not retained for replay.
    expect(ctx.get('t1')).toBeUndefined()
  })

  it('retains naturally-exited sessions for replay', async () => {
    await createSession('t1')
    workerExit('t1')
    expect(lifecycle.filter(e => e.type === 'exited')).toHaveLength(1)
    expect(ctx.get('t1')?.info.state).toBe('exited')
  })

  it('emits exited for an exit event that outran the create response', () => {
    workerExit('ghost')
    const exited = lifecycle.filter(e => e.type === 'exited')
    expect(exited).toHaveLength(1)
    expect(exited[0].sessionId).toBe('ghost')
    expect(exited[0].info?.state).toBe('exited')
  })

  it('emits exited via the crash sweep when the worker dies after a kill', async () => {
    await createSession('t1')
    ctx.kill('t1')
    hostMock.state.crashHandler?.()
    const exited = lifecycle.filter(e => e.type === 'exited')
    expect(exited).toHaveLength(1)
    expect(exited[0].sessionId).toBe('t1')
  })

  it('removes an already-exited session immediately on kill', async () => {
    await createSession('t1')
    workerExit('t1')
    expect(ctx.kill('t1')).toBe(true)
    expect(ctx.get('t1')).toBeUndefined()
    // Only the original exit emitted a lifecycle event.
    expect(lifecycle.filter(e => e.type === 'exited')).toHaveLength(1)
  })
})
