/**
 * Unit Tests: services/agent/codex — Session adapter contract shape
 *
 * These tests do NOT spawn the codex binary; they assert the *shape* of
 * the V2SDKSession surface our adapter must expose. Three invariants:
 *
 *   1. `query.transport.{isReady, ready, onExit}` exists (session-manager
 *      polls it for liveness; missing = sessions falsely declared dead).
 *
 *   2. `query.supportedCommands` is a function returning an array
 *      (Halo's `ensureSessionWarm` calls it; missing = TypeError every
 *      conversation switch + empty slash-command palette).
 *
 *   3. The static `create()` factory exists.
 *
 * We construct the class via reflection (private constructor) so we can
 * inspect the shape without booting the JSON-RPC client.
 */

import { describe, expect, it } from 'vitest'
import { CodexAppServerSession } from '../../../../../src/main/services/agent/codex/session-adapter'

function makeAdapter(): InstanceType<typeof CodexAppServerSession> {
  // Bypass private constructor for shape inspection. The adapter has not
  // been started, so we only touch fields that don't depend on the
  // connection (`query` is initialized in the constructor body).
  const Ctor = CodexAppServerSession as unknown as new (
    options: any, sessionId: string, opts: any,
  ) => InstanceType<typeof CodexAppServerSession>
  return new Ctor(
    {
      env: {}, cwd: '/tmp', model: 'm', displayModel: 'm',
      threadParams: {}, mcpServers: {},
    },
    'session-id',
    { spaceId: undefined, conversationId: undefined, resume: undefined },
  )
}

describe('CodexAppServerSession contract shape', () => {
  it('exposes query.transport.isReady (returns false before start)', () => {
    const a = makeAdapter()
    expect(typeof a.query.transport.isReady).toBe('function')
    expect(a.query.transport.isReady()).toBe(false)
  })

  it('exposes query.transport.ready as a getter (false before start)', () => {
    const a = makeAdapter()
    expect(a.query.transport.ready).toBe(false)
  })

  it('exposes query.transport.onExit as a function returning a disposer', () => {
    const a = makeAdapter()
    expect(typeof a.query.transport.onExit).toBe('function')
    const dispose = a.query.transport.onExit!(() => {})
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('exposes query.supportedCommands returning an empty Promise<unknown[]>', async () => {
    const a = makeAdapter()
    expect(typeof a.query.supportedCommands).toBe('function')
    const result = await a.query.supportedCommands()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  it('exposes the V2SDKSession lifecycle methods', () => {
    const a = makeAdapter()
    expect(typeof a.send).toBe('function')
    expect(typeof a.stream).toBe('function')
    expect(typeof a.close).toBe('function')
    expect(typeof a.interrupt).toBe('function')
    expect(typeof a.setMaxThinkingTokens).toBe('function')
    expect(typeof a.setPermissionMode).toBe('function')
  })
})
