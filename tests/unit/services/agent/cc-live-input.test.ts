import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CcSession } from '../../../../src/main/services/agent/cc/session'

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dispose of cleanups.splice(0)) dispose()
})

/**
 * A stand-in CLI speaking the stream-json protocol the patched SDK drives.
 * Inputs whose text starts with:
 *   `hold`  — queued, never acknowledged (cancel_async_message answers cancelled:true;
 *             `hold late` answers only after 2.5 s)
 *   `taken` — dequeued without an acknowledgment yet (cancel answers cancelled:false)
 *   `/`     — run as a turn of its own without an acknowledgment, like a local slash command
 *   `stdout` — answered with the echoed output of a local command
 * Every user text received is logged to `seen.log`.
 */
function sessionWithNativeAcknowledgments() {
  const directory = mkdtempSync(join(tmpdir(), 'halo-live-cc-'))
  const script = join(directory, 'engine.js')
  const seenLog = join(directory, 'seen.log')
  writeFileSync(script, `
const readline = require('node:readline');
const fs = require('node:fs');
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
const held = new Map();
let continuing = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_response') {
    // --replay-user-messages: the CLI echoes every response the SDK writes.
    write(message);
    return;
  }
  if (message.type === 'control_request') {
    const request = message.request;
    if (request.subtype === 'cancel_async_message') {
      if (held.get(request.message_uuid)?.startsWith('hold refused')) {
        write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'queue unavailable' } });
        return;
      }
      const answer = () => {
        const cancelled = held.delete(request.message_uuid);
        write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { cancelled } } });
      };
      if (held.get(request.message_uuid)?.startsWith('hold late')) setTimeout(answer, 2500);
      else answer();
      return;
    }
    write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models: [] } } });
    return;
  }
  if (message.type !== 'user') return;
  const text = typeof message.message.content === 'string' ? message.message.content : message.message.content[0].text;
  fs.appendFileSync(${JSON.stringify(seenLog)}, text + '\\n');
  if (text === 'echo') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: 'cli-request-1', response: { mcp_response: { marker: 'foreign-echo' } } } });
    write({ type: 'system', subtype: 'init', session_id: 'cc-session', tools: [], mcp_servers: [] });
    write({ type: 'result', subtype: 'success', session_id: 'cc-session', result: 'echoed' });
    return;
  }
  if (!message.uuid) {
    write({ type: 'system', subtype: 'init', session_id: 'cc-session', tools: [], mcp_servers: [] });
    if (text === 'final') { write({ type: 'result', subtype: 'success', session_id: 'cc-session', result: 'first' }); continuing = true; }
    return;
  }
  if (text.startsWith('hold')) { held.set(message.uuid, text); return; }
  if (text.startsWith('taken')) return;
  if (text.startsWith('stdout')) {
    write({ type: 'user', message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' }, session_id: 'cc-session', parent_tool_use_id: null, uuid: message.uuid, isReplay: true });
    write({ type: 'result', subtype: 'success', session_id: 'cc-session', result: 'updated' });
    return;
  }
  if (continuing) write({ type: 'system', subtype: 'init', session_id: 'cc-session', tools: [], mcp_servers: [] });
  if (!text.startsWith('/')) write({ ...message, session_id: 'cc-session', isReplay: true });
  write({ type: 'result', subtype: 'success', session_id: 'cc-session', result: 'updated' });
});
`)
  const session = new CcSession({
    model: 'test', pathToClaudeCodeExecutable: script, executable: process.execPath,
    cwd: directory, env: { ...process.env },
  }, { command: process.execPath, argsPrefix: [script], env: {}, path: script, kind: 'javascript', version: 'test' })
  cleanups.push(() => {
    session.close()
    session.query.transport.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const seen = () => existsSync(seenLog) ? readFileSync(seenLog, 'utf8').split('\n').filter(Boolean) : []
  return { session, seen }
}

async function drainTurn(session: any): Promise<any[]> {
  const frames: any[] = []
  for await (const frame of session.stream()) frames.push(frame)
  return frames
}

async function sessionInTurn() {
  const harness = sessionWithNativeAcknowledgments()
  await harness.session.send('start')
  await harness.session.stream()[Symbol.asyncIterator]().next()
  return harness
}

const settle = () => new Promise(resolve => setTimeout(resolve, 100))

describe('Claude Code synchronous live-input ownership', () => {
  it('holds accepted input until the native user acknowledgment is consumed', async () => {
    const { session } = sessionWithNativeAcknowledgments()
    await session.send('start')
    const stream = session.stream()[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'system', subtype: 'init' })
    expect(session.sendIntoLiveTurn('during tool')).toBe(true)
    expect(session.hasPendingInput()).toBe(true)
    expect((await stream.next()).value).toMatchObject({ type: 'result' })
    expect(session.hasPendingInput()).toBe(false)
    expect((await stream.next()).done).toBe(true)
    session.close()
    expect(session.sendIntoLiveTurn('closed')).toBe(false)
  })

  it('keeps the final-result to continuation gap busy', async () => {
    const { session } = sessionWithNativeAcknowledgments()
    await session.send('final')
    const first = session.stream()[Symbol.asyncIterator]()
    await first.next()
    expect(session.sendIntoLiveTurn('after final')).toBe(true)
    expect((await first.next()).value).toMatchObject({ type: 'result', result: 'first' })
    expect(session.hasPendingInput()).toBe(true)
    expect((await first.next()).done).toBe(true)
    const frames = await drainTurn(session)
    expect(frames.map(frame => frame.type)).toEqual(['system', 'result'])
    expect(session.hasPendingInput()).toBe(false)
  })

  it('stops waiting for an input that ran as its own turn without an acknowledgment', async () => {
    const { session } = sessionWithNativeAcknowledgments()
    await session.send('final')
    const first = session.stream()[Symbol.asyncIterator]()
    await first.next()
    expect(session.sendIntoLiveTurn('/cost')).toBe(true)
    expect((await first.next()).value).toMatchObject({ type: 'result', result: 'first' })
    expect(session.hasPendingInput()).toBe(true)
    await first.next()
    const frames = await drainTurn(session)
    expect(frames.at(-1)).toMatchObject({ type: 'result', result: 'updated' })
    expect(session.hasPendingInput()).toBe(false)
  })
})

describe('Claude Code live-input withdrawal', () => {
  it('withdraws input the CLI still queues and calls its handler once', async () => {
    const { session } = await sessionInTurn()
    const onWithdrawn = vi.fn()
    expect(session.sendIntoLiveTurn('hold me', { onWithdrawn })).toBe(true)
    await settle()
    expect(await session.withdrawUnreadInput()).toBe(1)
    expect(onWithdrawn).toHaveBeenCalledTimes(1)
    expect(session.hasPendingInput()).toBe(false)
    expect(await session.withdrawUnreadInput()).toBe(0)
    expect(onWithdrawn).toHaveBeenCalledTimes(1)
  })

  it('drops input still in the SDK queue before it is written, and never lets a cancel overtake its message', async () => {
    const { session, seen } = await sessionInTurn()
    const order: string[] = []
    const first = vi.fn(() => order.push('first'))
    const second = vi.fn(() => order.push('second'))
    // Same tick: the first is handed to the stdin writer, the second waits in the SDK queue.
    session.sendIntoLiveTurn('hold first', { onWithdrawn: first })
    session.sendIntoLiveTurn('hold second', { onWithdrawn: second })
    expect(await session.withdrawUnreadInput()).toBe(2)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    // Handlers run in acceptance order, though the queued one is taken back first.
    expect(order).toEqual(['first', 'second'])
    await settle()
    expect(seen()).toContain('hold first')
    expect(seen()).not.toContain('hold second')
  })

  it('treats input the CLI already dequeued as read', async () => {
    const { session } = await sessionInTurn()
    const onWithdrawn = vi.fn()
    session.sendIntoLiveTurn('taken by the model', { onWithdrawn })
    await settle()
    expect(await session.withdrawUnreadInput()).toBe(0)
    expect(onWithdrawn).not.toHaveBeenCalled()
    expect(session.hasPendingInput()).toBe(true)
  })

  it('reports a cancel the live CLI refused instead of claiming the input was withdrawn', async () => {
    const { session } = await sessionInTurn()
    const onWithdrawn = vi.fn()
    session.sendIntoLiveTurn('hold refused', { onWithdrawn })
    await settle()
    await expect(session.withdrawUnreadInput()).rejects.toThrow('cancel_async_message failed for 1 input(s)')
    expect(onWithdrawn).not.toHaveBeenCalled()
    expect(session.hasPendingInput()).toBe(true)
  })

  it('stops waiting for a cancel the CLI does not answer in time, and still withdraws the input it confirms later', async () => {
    const { session } = await sessionInTurn()
    const onWithdrawn = vi.fn()
    session.sendIntoLiveTurn('hold late', { onWithdrawn })
    await settle()
    const started = Date.now()
    await expect(session.withdrawUnreadInput()).rejects.toThrow('which may still run: cancel_async_message got no answer within 2000ms')
    expect(Date.now() - started).toBeLessThan(2400)
    expect(onWithdrawn).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(onWithdrawn).toHaveBeenCalledTimes(1)
    expect(session.hasPendingInput()).toBe(false)
  }, 10_000)

  it('leaves input accepted after the withdrawal started alone', async () => {
    const { session } = await sessionInTurn()
    const before = vi.fn()
    const after = vi.fn()
    session.sendIntoLiveTurn('hold before', { onWithdrawn: before })
    await settle()
    const withdrawal = session.withdrawUnreadInput()
    session.sendIntoLiveTurn('hold after', { onWithdrawn: after })
    expect(await withdrawal).toBe(1)
    expect(before).toHaveBeenCalledTimes(1)
    expect(after).not.toHaveBeenCalled()
    expect(session.hasPendingInput()).toBe(true)
  })
})

describe('Claude Code input echoes', () => {
  it('acknowledges an echoed input without parsing the echo', async () => {
    const { session } = await sessionInTurn()
    const parse = vi.spyOn(JSON, 'parse')
    expect(session.sendIntoLiveTurn(`big ${'x'.repeat(200_000)}`)).toBe(true)
    const frames = await drainTurn(session)
    expect(frames.map(frame => frame.type)).toEqual(['result'])
    expect(session.hasPendingInput()).toBe(false)
    expect(parse.mock.calls.some(([text]) => String(text).length > 100_000)).toBe(false)
  })

  it('still delivers the echoed output of a local command', async () => {
    const { session } = await sessionInTurn()
    expect(session.sendIntoLiveTurn('stdout please')).toBe(true)
    const frames = await drainTurn(session)
    expect(frames[0]).toMatchObject({ type: 'user', isReplay: true, message: { content: '<local-command-stdout>done</local-command-stdout>' } })
    expect(frames.at(-1)).toMatchObject({ type: 'result' })
    expect(session.hasPendingInput()).toBe(false)
  })
})

describe('Claude Code control-response echoes', () => {
  it('skips an echoed response the SDK never asked for without parsing it, and still parses its own', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    const { session } = sessionWithNativeAcknowledgments()
    await session.send('echo')
    const frames = await drainTurn(session)
    expect(frames.at(-1)).toMatchObject({ type: 'result', result: 'echoed' })
    const parsed = parse.mock.calls.map(([text]) => String(text))
    expect(parsed.some(text => text.includes('foreign-echo'))).toBe(false)
    expect(parsed.some(text => text.startsWith('{"type":"control_response"'))).toBe(true)
  })
})
