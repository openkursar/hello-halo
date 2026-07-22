/**
 * The terminal MCP server is the per-space isolation boundary for pty access:
 * every tool resolves sessions through getScoped, which drops a session owned by
 * a foreign space. These tests pin that guard (foreign-space session is invisible
 * to write/read/kill/wait), the model-supplied timeout clamp, and the write status
 * string mapping the model reads to decide its next move.
 *
 * resolved-sdk is mocked so tool()/createSdkMcpServer just capture the handlers,
 * letting us invoke them directly with a fake TerminalContext.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string; handler: Function }> }) => opts
}))

import { createTerminalMcpServer, type TerminalToolScope } from '../../../../src/main/services/ai-terminal/sdk-mcp-server'

type Tool = { name: string; handler: (args: any) => Promise<{ content: { text: string }[]; isError?: boolean }> }

const SCOPE: TerminalToolScope = { spaceId: 'space-A', workDir: '/w' }

/** Configurable fake session; write() echoes whatever result the test sets. */
function fakeSession(spaceId: string, writeResult?: Record<string, unknown>) {
  return {
    id: 'sess-1',
    info: { spaceId, title: 't', shell: 'zsh', cwd: '/w', cols: 80, rows: 24 },
    write: vi.fn(async () => writeResult ?? { reason: 'idle', output: 'ok', running: false, awaitingInput: false, awaitingContinuation: false, exitCode: null }),
    read: vi.fn(() => ({ mode: 'new', content: 'x' })),
    kill: vi.fn()
  }
}

/** Build the tool map plus the fake ctx it closes over. */
function build(session?: ReturnType<typeof fakeSession>) {
  const ctx = {
    get: vi.fn((id: string) => (session && id === session.id ? session : undefined)),
    list: vi.fn(() => []),
    create: vi.fn(),
    kill: vi.fn(() => true),
    markAiActivity: vi.fn(),
    markAiTouched: vi.fn()
  }
  const server = createTerminalMcpServer(ctx as any, SCOPE) as unknown as { tools: Tool[] }
  const tools = Object.fromEntries(server.tools.map(t => [t.name, t]))
  return { ctx, tools, session }
}

beforeEach(() => vi.clearAllMocks())

describe('scope guard — foreign-space session is invisible', () => {
  // Session exists in the context but belongs to space-B; getScoped must reject it.
  const foreign = () => build(fakeSession('space-B'))

  it('terminal_write rejects a foreign-space session and never writes', async () => {
    const { tools, session } = foreign()
    const res = await tools.terminal_write.handler({ session: 'sess-1', input: 'ls' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('No such terminal session')
    expect(session!.write).not.toHaveBeenCalled()
  })

  it('terminal_read rejects a foreign-space session', async () => {
    const { tools, session } = foreign()
    const res = await tools.terminal_read.handler({ session: 'sess-1' })
    expect(res.isError).toBe(true)
    expect(session!.read).not.toHaveBeenCalled()
  })

  it('terminal_kill rejects a foreign-space session and never kills', async () => {
    const { ctx, tools } = foreign()
    const res = await tools.terminal_kill.handler({ session: 'sess-1' })
    expect(res.isError).toBe(true)
    expect(ctx.kill).not.toHaveBeenCalled()
  })

  it('terminal_wait_for rejects a foreign-space session', async () => {
    const { tools } = foreign()
    const res = await tools.terminal_wait_for.handler({ session: 'sess-1', text: 'done' })
    expect(res.isError).toBe(true)
  })

  it('own-space session passes the guard (write proceeds)', async () => {
    const { tools, session } = build(fakeSession('space-A'))
    const res = await tools.terminal_write.handler({ session: 'sess-1', input: 'ls' })
    expect(res.isError).toBeUndefined()
    expect(session!.write).toHaveBeenCalled()
  })
})

describe('timeout clamp', () => {
  it('clamps a huge timeout to the 600s ceiling (ms passed to write)', async () => {
    const { tools, session } = build(fakeSession('space-A'))
    await tools.terminal_write.handler({ session: 'sess-1', input: 'x', timeout: 999999 })
    expect(session!.write).toHaveBeenCalledWith('x', 600 * 1000, true)
  })

  it('clamps a zero/negative timeout up to the 1s floor', async () => {
    const { tools, session } = build(fakeSession('space-A'))
    await tools.terminal_write.handler({ session: 'sess-1', input: 'x', timeout: 0 })
    expect(session!.write).toHaveBeenCalledWith('x', 1 * 1000, true)
  })

  it('falls back to the 10s default when no timeout is given', async () => {
    const { tools, session } = build(fakeSession('space-A'))
    await tools.terminal_write.handler({ session: 'sess-1', input: 'x' })
    expect(session!.write).toHaveBeenCalledWith('x', 10 * 1000, true)
  })
})

describe('terminal_write status mapping', () => {
  async function statusFor(result: Record<string, unknown>): Promise<string> {
    const { tools } = build(fakeSession('space-A', { output: 'out', exitCode: null, ...result }))
    const res = await tools.terminal_write.handler({ session: 'sess-1', input: 'x' })
    return res.content[0].text
  }

  it('maps reason "exited" to "session exited"', async () => {
    expect(await statusFor({ reason: 'exited' })).toContain('[session exited]')
  })

  it('maps awaitingContinuation to the wedged-shell guidance', async () => {
    expect(await statusFor({ awaitingContinuation: true })).toContain('[awaiting continuation')
  })

  it('maps running to "running (command still in progress)"', async () => {
    expect(await statusFor({ running: true })).toContain('[running (command still in progress)]')
  })

  it('maps awaitingInput to "awaiting input"', async () => {
    expect(await statusFor({ awaitingInput: true })).toContain('[awaiting input]')
  })

  it('maps a clean settle to "done" and includes the exit code when present', async () => {
    expect(await statusFor({ exitCode: 0 })).toContain('[done (exit 0)]')
  })

  it('omits the exit code from "done" when the shell emitted none', async () => {
    const text = await statusFor({ exitCode: null })
    expect(text).toContain('[done]')
    expect(text).not.toContain('exit')
  })
})
