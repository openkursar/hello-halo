import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CcSession } from '../../../../src/main/services/agent/cc/session'
import { buildCcArguments } from '../../../../src/main/services/agent/cc/options'

const sessions: CcSession[] = []
const directories: string[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) { session.close(); await session.flush() }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createSession(options: Record<string, any> = {}, mode = 'normal') {
  const directory = mkdtempSync(join(tmpdir(), 'halo-cc-protocol-'))
  directories.push(directory)
  const entry = join(directory, 'runtime.cjs')
  writeFileSync(entry, `
const readline = require('node:readline');
const write = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
let hooks;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const request = frame.request;
    if (request.subtype === 'initialize') {
      hooks = request.hooks;
      write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [{ name: 'cost' }], models: [], prompt: request.systemPrompt, append: request.appendSystemPrompt, argv: process.argv.slice(2), autoUpdate: process.env.DISABLE_AUTOUPDATER } } });
    } else write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { mcpServers: [{ name: 'bridge', status: 'connected' }] } } });
    return;
  }
  if (frame.type === 'control_response') {
    if (frame.response.request_id === 'permission') {
      write({ type: 'system', subtype: 'permission_answer', answer: frame.response });
      write({ type: 'control_request', request_id: 'hook', request: { subtype: 'hook_callback', callback_id: hooks.PreToolUse[0].hookCallbackIds[0], input: { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'file' } }, tool_use_id: 'tool-1' } });
    } else {
      write({ type: 'system', subtype: 'hook_answer', answer: frame.response });
      write({ type: 'result', subtype: 'success', session_id: 'native-session', result: 'done' });
    }
    return;
  }
  if (frame.type === 'user') {
    if (${JSON.stringify(mode)} === 'malformed') { process.stdout.write('invalid frame\\n'); return; }
    if (${JSON.stringify(mode)} === 'crash') { process.exit(7); return; }
    write({ type: 'system', subtype: 'init', session_id: 'native-session', tools: [], mcp_servers: [] });
    write({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'file' }, tool_use_id: 'tool-1', blocked_path: 'file', permission_suggestions: [], agent_id: 'subagent-1' } });
  }
});
`)
  const session = new CcSession({ cwd: directory, env: process.env, ...options }, {
    command: process.execPath, argsPrefix: [entry], env: { ELECTRON_RUN_AS_NODE: '1' }, path: entry, kind: 'javascript', version: '2.1.89',
  })
  sessions.push(session)
  return session
}

async function turn(session: CcSession) {
  const frames = []
  for await (const frame of session.stream()) frames.push(frame)
  return frames
}

describe('external Claude Code protocol', () => {
  it('carries prompt, resume, model and permissions into the native session', async () => {
    const canUseTool = vi.fn(async (_name, input) => ({ behavior: 'allow', updatedInput: { ...input, content: 'approved' } }))
    const hook = vi.fn(async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'protected' } }))
    const session = createSession({ model: 'test-model', resume: 'previous-session', systemPrompt: 'host context', permissionMode: 'default', canUseTool, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [hook] }] } })
    await session.ready()
    const initialized = await session.query.initializationResult()
    expect(initialized.prompt).toBe('host context')
    expect(initialized.autoUpdate).toBe('1')
    expect(initialized.argv).toEqual(expect.arrayContaining(['--resume', 'previous-session', '--model', 'test-model', '--permission-prompt-tool', 'stdio']))
    expect(await session.query.supportedCommands()).toEqual([{ name: 'cost' }])
    await session.send('write')
    const frames = await turn(session)
    expect(canUseTool).toHaveBeenCalledWith('Write', { file_path: 'file' }, expect.objectContaining({ toolUseID: 'tool-1', agentID: 'subagent-1', blockedPath: 'file' }))
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ hook_event_name: 'PreToolUse' }), 'tool-1', { signal: expect.any(AbortSignal) })
    expect(frames.find(frame => frame.subtype === 'permission_answer').answer.response.updatedInput.content).toBe('approved')
    expect(frames.find(frame => frame.subtype === 'hook_answer').answer.response.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(frames.at(-1).type).toBe('result')
    expect(session.sessionId).toBe('native-session')
    expect(session.query.transport.isReady()).toBe(true)
    await session.setMaxThinkingTokens(2000)
    await session.setPermissionMode('plan')
    await session.interrupt()
    expect(await session.mcpServerStatus()).toEqual([{ name: 'bridge', status: 'connected' }])
  })

  it('maps a preset append onto the native append field without replacing its default prompt', async () => {
    const session = createSession({ systemPrompt: { type: 'preset', preset: 'default', append: 'additional context' } })
    const initialized = await session.query.initializationResult()
    expect(initialized).not.toHaveProperty('prompt')
    expect(initialized.append).toBe('additional context')
  })

  it('reports denied permissions and callback errors without approving the tool', async () => {
    const session = createSession({ canUseTool: async () => ({ behavior: 'deny', message: 'No access' }), hooks: { PreToolUse: [{ hooks: [async () => { throw new Error('guard unavailable') }] }] } })
    await session.send('write')
    const frames = await turn(session)
    expect(frames.find(frame => frame.subtype === 'permission_answer').answer.response.behavior).toBe('deny')
    expect(frames.find(frame => frame.subtype === 'hook_answer').answer).toMatchObject({ subtype: 'error', error: 'guard unavailable' })
  })

  it.each(['crash', 'malformed'])('ends a broken stream and releases its process on %s', async mode => {
    const session = createSession({}, mode)
    const onExit = vi.fn()
    session.query.transport.onExit(onExit)
    await session.send('start')
    await expect(turn(session)).rejects.toThrow(mode === 'crash' ? 'code=7' : 'Invalid CC stream-json frame')
    expect(session.query.transport.isReady()).toBe(false)
    await session.flush()
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(expect.any(Error))
  })

  it('preserves CLI configuration instead of launching a different tool set', () => {
    const args = buildCcArguments({
      maxTurns: 20, includePartialMessages: true, settingSources: ['user', 'project'],
      allowedTools: ['Read'], disallowedTools: ['Write'], additionalDirectories: ['/workspace'],
      thinking: { type: 'enabled', budgetTokens: 1234 }, effort: 'high', extraArgs: { 'dangerously-skip-permissions': null },
    }, { example: { type: 'sse', url: 'http://127.0.0.1/mcp' } })
    expect(args).toEqual(expect.arrayContaining(['--include-partial-messages', '--replay-user-messages', '--allowedTools', 'Read', '--disallowedTools', 'Write', '--max-thinking-tokens', '1234', '--setting-sources=user,project']))
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { example: { type: 'sse', url: 'http://127.0.0.1/mcp' } } })
  })
})
