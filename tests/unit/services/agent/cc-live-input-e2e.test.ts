/**
 * Live input against the real bundled Claude Code CLI and a local scripted
 * Messages API. Opt-in (CC_E2E=1): it spawns the CLI once per case.
 *
 * Covers what only the real CLI can prove: which inputs it acknowledges, which
 * it runs as a turn of its own, that a withdrawn input never reaches the model
 * (including one withdrawn in the same tick it was accepted), and that echoed
 * control responses carry the shape the SDK skips without parsing.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '../../../../src/main/services/agent/mcp/sdk-server'
import { CcSession } from '../../../../src/main/services/agent/cc/session'
import type { CcRuntimeLaunch } from '../../../../src/shared/types/cc-runtime'
import { prepareStoredSession } from '../../../../src/main/services/agent/stored-session'
import { createSession as createHaloSession } from '@hello-halo/agent-sdk'

const enabled = process.env.CC_E2E === '1'
const CLI = process.env.CC_TEST_CLI ?? path.resolve(__dirname, '../../../../.validation/legacy-cc/cli.js')

type Step = { text?: string; chunks?: string[]; chunkDelayMs?: number; toolUse?: { name: string; input?: Record<string, unknown> } }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

function userText(request: any): string {
  return (request.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) =>
    typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.type === 'text' ? b.text : JSON.stringify(b.content ?? '')).join('\n'),
  ).join('\n')
}

/** Anthropic Messages SSE for one scripted step. */
async function stream(res: http.ServerResponse, step: Step, seq: number): Promise<void> {
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  let index = 0
  if (step.text !== undefined || step.chunks) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    for (const text of step.chunks ?? [step.text!]) {
      if (step.chunkDelayMs) await sleep(step.chunkDelayMs)
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    }
    send('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (step.toolUse) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${seq}`, name: step.toolUse.name, input: {} } })
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.toolUse.input ?? {}) } })
    send('content_block_stop', { type: 'content_block_stop', index })
  }
  send('message_delta', { type: 'message_delta', delta: { stop_reason: step.toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  send('message_stop', { type: 'message_stop' })
}

const harnesses: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of harnesses.splice(0)) await dispose()
})

async function startHarness(overrides: Record<string, unknown> = {}) {
  const plan: Step[] = []
  const modelRequests: any[] = []
  let seq = 0
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = body ? JSON.parse(body) : {}
    if (!req.url?.startsWith('/v1/messages') || req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    // Only the main loop carries tools; auxiliary calls get a short answer.
    const main = Array.isArray(json.tools) && json.tools.length > 0
    if (main) modelRequests.push(json)
    const step = main ? plan.shift() ?? { text: 'done' } : { text: 'aux' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    await stream(res, step, ++seq)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = mkdtempSync(path.join(tmpdir(), 'halo-cc-e2e-'))
  const configDir = path.join(root, 'config')
  const cwd = path.join(root, 'work')
  mkdirSync(configDir)
  mkdirSync(cwd)
  const toolCalls: string[] = []
  const tools = createSdkMcpServer({
    name: 'h',
    version: '1.0.0',
    tools: [
      tool('slow', 'Waits', { ms: z.number() }, async ({ ms }) => {
        toolCalls.push('slow')
        await sleep(ms)
        return { content: [{ type: 'text', text: 'slow done' }] }
      }),
      tool('big', 'Large result', { kb: z.number() }, async ({ kb }) => {
        toolCalls.push('big')
        return { content: [{ type: 'text', text: '- button "Submit" [ref=e1]\n'.repeat(Math.ceil(kb * 1024 / 28)) }] }
      }),
    ],
  })
  const sessionOptions = {
    model: 'claude-sonnet-4-5',
    cwd,
    pathToClaudeCodeExecutable: CLI,
    executable: 'node',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    },
    extraArgs: { 'dangerously-skip-permissions': null },
    permissionMode: 'bypassPermissions',
    canUseTool: async (_name: string, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input }),
    includePartialMessages: true,
    settingSources: [],
    mcpServers: { h: tools },
    ...overrides,
  }
  const launch: CcRuntimeLaunch = { command: CLI.endsWith('.js') ? process.execPath : CLI, argsPrefix: CLI.endsWith('.js') ? [CLI] : [], env: CLI.endsWith('.js') ? { ELECTRON_RUN_AS_NODE: '1' } : {}, path: CLI, kind: CLI.endsWith('.js') ? 'javascript' : 'native', version: 'test' }
  const session = new CcSession(sessionOptions, launch)

  // Halo's consumer shape: re-enter stream() after every result.
  const frames: any[] = []
  const pendingAtResults: boolean[] = []
  let running = true
  const consumer = (async () => {
    while (running) {
      let count = 0
      try {
        for await (const frame of session.stream()) {
          frames.push(frame)
          if (frame.type === 'result') pendingAtResults.push(session.hasPendingInput())
          count++
        }
      } catch { break }
      if (count === 0) break
    }
  })()
  harnesses.push(async () => {
    running = false
    session.close()
    await Promise.race([consumer, sleep(3000)])
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await session.flush()
    rmSync(root, { recursive: true, force: true })
  })

  const results = () => frames.filter(f => f.type === 'result')
  return {
    session, sessionOptions, launch, configDir, cwd, plan, modelRequests, toolCalls, frames, results, pendingAtResults,
    modelSaw: (marker: string) => modelRequests.some(r => userText(r).includes(marker)),
    waitForResults: (n: number) => waitFor(() => results().length >= n, `${n} result(s)`),
    waitForTool: () => waitFor(() => toolCalls.length > 0, 'tool call'),
    waitForText: () => waitFor(() => frames.some(f => f.type === 'stream_event' && f.event?.type === 'content_block_delta'), 'first text delta'),
  }
}

const slowFinalAnswer: Step = { chunks: Array.from({ length: 12 }, (_, i) => `part${i} `), chunkDelayMs: 120 }

describe.skipIf(!enabled)('Claude Code live input (real CLI)', () => {
  it('merges input at the tool boundary and acknowledges it', async () => {
    const h = await startHarness()
    h.plan.push({ toolUse: { name: 'mcp__h__slow', input: { ms: 1500 } } }, { text: 'final' })
    await h.session.send('start')
    await h.waitForTool()
    expect(h.session.sendIntoLiveTurn('MERGE-X')).toBe(true)
    await h.waitForResults(1)
    await sleep(500)
    expect(userText(h.modelRequests[1])).toContain('MERGE-X')
    expect(h.session.hasPendingInput()).toBe(false)
    expect(h.results()).toHaveLength(1)
  }, 60000)

  it('answers input from the final-answer window in a continuation and acknowledges it', async () => {
    const h = await startHarness()
    h.plan.push(slowFinalAnswer, { text: 'continuation' })
    await h.session.send('start')
    await h.waitForText()
    h.session.sendIntoLiveTurn('WINDOW-Y')
    await h.waitForResults(1)
    expect(h.pendingAtResults[0]).toBe(true)
    await h.waitForResults(2)
    await sleep(300)
    expect(userText(h.modelRequests[1])).toContain('WINDOW-Y')
    expect(h.session.hasPendingInput()).toBe(false)
  }, 60000)

  it.each([
    ['a local slash command', '/cost'],
    ['text carrying a reserved tag', '<task-notification>TAG-Z</task-notification>'],
  ])('does not stay pending on %s run as its own turn', async (_label, input) => {
    const h = await startHarness()
    h.plan.push(slowFinalAnswer, { text: 'own turn' })
    await h.session.send('start')
    await h.waitForText()
    h.session.sendIntoLiveTurn(input)
    await h.waitForResults(2)
    await sleep(500)
    expect(h.session.hasPendingInput()).toBe(false)
  }, 60000)

  it.each([
    ['well after it was written', async () => { await sleep(300) }],
    ['in the same tick it was accepted', async () => {}],
  ])('withdraws unread input on stop %s; it never reaches the model', async (_label, beforeStop) => {
    const h = await startHarness()
    h.plan.push({ toolUse: { name: 'mcp__h__slow', input: { ms: 2500 } } }, { text: 'after tool' }, { text: 'must not run' })
    await h.session.send('start')
    await h.waitForTool()
    const onWithdrawn = vi.fn()
    h.session.sendIntoLiveTurn('STOP-Z', { onWithdrawn })
    await beforeStop()
    expect(await h.session.withdrawUnreadInput()).toBe(1)
    expect(onWithdrawn).toHaveBeenCalledTimes(1)
    await h.session.interrupt()
    await h.waitForResults(1)
    await sleep(2500)
    expect(h.modelSaw('STOP-Z')).toBe(false)
    expect(h.results()).toHaveLength(1)
    expect(h.session.hasPendingInput()).toBe(false)
  }, 60000)

  it('does not withdraw input the model already read', async () => {
    const h = await startHarness()
    h.plan.push({ toolUse: { name: 'mcp__h__slow', input: { ms: 800 } } }, { chunks: Array.from({ length: 20 }, (_, i) => `w${i} `), chunkDelayMs: 150 })
    await h.session.send('start')
    await h.waitForTool()
    const onWithdrawn = vi.fn()
    h.session.sendIntoLiveTurn('READ-R', { onWithdrawn })
    await waitFor(() => h.modelRequests.length >= 2, 'second model request')
    expect(await h.session.withdrawUnreadInput()).toBe(0)
    expect(onWithdrawn).not.toHaveBeenCalled()
    expect(userText(h.modelRequests[1])).toContain('READ-R')
    await h.session.interrupt()
  }, 60000)

  it('never parses the CLI echo of a large tool result it sent', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    const h = await startHarness()
    h.plan.push({ toolUse: { name: 'mcp__h__big', input: { kb: 400 } } }, { text: 'done' })
    await h.session.send('start')
    await h.waitForResults(1)
    const parsedResponses = parse.mock.calls.map(([text]) => String(text)).filter(text => text.startsWith('{"type":"control_response"'))
    expect(parsedResponses.every(text => text.length < 100_000)).toBe(true)
    expect(h.results()[0]).toMatchObject({ subtype: 'success' })
  }, 60000)
  it('resumes an external CC session after the process is retired', async () => {
    const h = await startHarness()
    h.plan.push({ text: 'ORIGINAL-ANSWER' })
    await h.session.send('ORIGINAL-QUESTION')
    await h.waitForResults(1)
    const sessionId = h.session.sessionId
    expect(sessionId).toBeTruthy()
    h.session.close()
    await h.session.flush()
    const resumed = new CcSession({ ...h.sessionOptions, resume: sessionId }, h.launch)
    try {
      h.plan.push({ text: 'resumed' })
      await resumed.send('continue')
      const frames = []
      for await (const frame of resumed.stream()) frames.push(frame)
      expect(frames.find(frame => frame.type === 'result')).toMatchObject({ type: 'result', is_error: false })
      expect(JSON.stringify(h.modelRequests.at(-1).messages)).toContain('ORIGINAL-QUESTION')
      expect(JSON.stringify(h.modelRequests.at(-1).messages)).toContain('ORIGINAL-ANSWER')
    } finally { resumed.close(); await resumed.flush() }
  }, 60000)

  it('continues a real CC transcript in Halo with the user, assistant and tool history intact', async () => {
    const h = await startHarness()
    h.plan.push({ toolUse: { name: 'mcp__h__slow', input: { ms: 1 } } }, { text: 'PREVIOUS-ANSWER' })
    await h.session.send('PREVIOUS-QUESTION')
    await h.waitForResults(1)
    const sessionId = h.session.sessionId
    h.session.close()
    await h.session.flush()
    const requests: any[] = []
    const provider = {
      id: 'test', name: 'Test',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: true, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('Expected streaming') },
      async *createMessageStream(request: any) {
        requests.push(request)
        yield { type: 'message_start', id: 'halo-message', model: 'test', usage: { input_tokens: 10, output_tokens: 1 } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'text_delta', index: 0, text: 'continued' }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
        yield { type: 'message_stop' }
      },
    }
    expect(await prepareStoredSession({ workDir: h.cwd, sessionId: sessionId!, configDir: h.configDir, engine: 'halo' })).toBe(true)
    const resumed = await createHaloSession({ provider, model: 'test', resume: sessionId, cwd: h.cwd,
      env: { CLAUDE_CONFIG_DIR: h.configDir, HOME: h.configDir }, systemPrompt: 'Test', settingSources: [],
    } as any)
    try {
      await resumed.send('CONTINUE-IN-HALO')
      const frames = []
      for await (const frame of resumed.stream()) frames.push(frame)
      expect(frames.find(frame => frame.type === 'result')).toMatchObject({ type: 'result', is_error: false })
      const history = JSON.stringify(requests[0].messages)
      expect(history).toContain('PREVIOUS-QUESTION')
      expect(history).toContain('PREVIOUS-ANSWER')
      expect(history).toContain('slow done')
      expect(history).toContain('CONTINUE-IN-HALO')
    } finally { resumed.close(); await resumed.flush() }
  }, 60000)

  it('honors a denied native permission callback without writing the file', async () => {
    const permission = vi.fn(async () => ({ behavior: 'deny', message: 'Denied by owner policy' }))
    const h = await startHarness({ permissionMode: 'default', extraArgs: {}, canUseTool: permission })
    const target = path.join(h.cwd, 'permission-refused.txt')
    h.plan.push({ toolUse: { name: 'Write', input: { file_path: target, content: 'must not be written' } } }, { text: 'refused' })
    await h.session.send('try the file')
    await h.waitForResults(1)
    expect(permission).toHaveBeenCalledWith('Write', expect.objectContaining({ file_path: target }), expect.objectContaining({ toolUseID: expect.any(String) }))
    expect(existsSync(target)).toBe(false)
    expect(JSON.stringify(h.modelRequests.at(-1).messages)).toContain('Denied by owner policy')
  }, 60000)

  it('runs host memory-style hooks before native file tools', async () => {
    const hook = vi.fn(async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Protected memory' } }))
    const h = await startHarness({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [hook] }] } })
    const target = path.join(h.cwd, 'hook-refused.txt')
    h.plan.push({ toolUse: { name: 'Write', input: { file_path: target, content: 'must not be written' } } }, { text: 'guarded' })
    await h.session.send('try the file')
    await h.waitForResults(1)
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ hook_event_name: 'PreToolUse', tool_name: 'Write' }), expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(existsSync(target)).toBe(false)
    expect(JSON.stringify(h.modelRequests.at(-1).messages)).toContain('Protected memory')
  }, 60000)

  it('does not let a permitted shell prefix approve an additional command', async () => {
    const permission = vi.fn(async () => ({ behavior: 'deny', message: 'Command outside allowed rules' }))
    const h = await startHarness({ permissionMode: 'default', extraArgs: {}, allowedTools: ['Bash(echo safe)'], canUseTool: permission })
    const target = path.join(h.cwd, 'compound-refused.txt')
    h.plan.push({ toolUse: { name: 'Bash', input: { command: `echo safe && printf forbidden > '${target}'` } } }, { text: 'refused' })
    await h.session.send('run the command')
    await h.waitForResults(1)
    expect(permission).toHaveBeenCalledWith('Bash', expect.any(Object), expect.any(Object))
    expect(existsSync(target)).toBe(false)
    expect(JSON.stringify(h.modelRequests.at(-1).messages)).toContain('Command outside allowed rules')
  }, 60000)

})
