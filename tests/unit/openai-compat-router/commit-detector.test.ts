import { describe, expect, it } from 'vitest'
import { StreamCommitDetector, judgeMessageReply } from '../../../src/main/openai-compat-router/server/commit-detector'

function event(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

const messageStart = event('message_start', { message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } })
const textStart = event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
const textDelta = (text: string) => event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })

describe('StreamCommitDetector', () => {
  it('stays undecided through the frames that precede an answer', () => {
    const detector = new StreamCommitDetector()
    expect(detector.push(messageStart).kind).toBe('pending')
    expect(detector.push(event('ping', {})).kind).toBe('pending')
    expect(detector.push(textStart).kind).toBe('pending')
    expect(detector.push(textDelta('')).kind).toBe('pending')
  })

  it('commits on the first piece of text', () => {
    const detector = new StreamCommitDetector()
    detector.push(messageStart + textStart)
    expect(detector.push(textDelta('Hi')).kind).toBe('content')
  })

  it('waits through leading blank text for the words', () => {
    const detector = new StreamCommitDetector()
    detector.push(messageStart + textStart)
    expect(detector.push(textDelta('\n\n')).kind).toBe('pending')
    expect(detector.push(textDelta('Hi')).kind).toBe('content')
  })

  it.each([
    ['a tool call starting', event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } })],
    ['a server tool starting', event('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 't', name: 'web_search' } })],
    ['redacted reasoning', event('content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'x' } })],
    ['reasoning text', event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } })],
    ['tool input', event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"a"' } })],
    ['text carried by the block start', event('content_block_start', { index: 0, content_block: { type: 'text', text: 'Hi' } })],
  ])('commits on %s', (_name, frame) => {
    const detector = new StreamCommitDetector()
    expect(detector.push(messageStart + frame).kind).toBe('content')
  })

  it.each([
    ['an empty reasoning delta', event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '' } })],
    ['blank text', event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' \n' } })],
    ['blank reasoning', event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '  ' } })],
    ['a signature alone', event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } })],
    ['empty tool input', event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '' } })],
    ['a stop frame', event('message_stop', {})],
  ])('does not commit on %s', (_name, frame) => {
    const detector = new StreamCommitDetector()
    expect(detector.push(messageStart + frame).kind).toBe('pending')
  })

  it('reports an error event that comes before any content', () => {
    const detector = new StreamCommitDetector()
    detector.push(messageStart)
    expect(detector.push(event('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })))
      .toEqual({ kind: 'error', errorType: 'overloaded_error', message: 'Overloaded' })
  })

  it('keeps its first verdict, however much follows', () => {
    const detector = new StreamCommitDetector()
    detector.push(messageStart + textStart + textDelta('Hi'))
    expect(detector.push(event('error', { error: { type: 'api_error', message: 'late' } })).kind).toBe('content')
    expect(detector.verdict.kind).toBe('content')
  })

  it('reads events split across chunks and written with CRLF line ends', () => {
    const detector = new StreamCommitDetector()
    const frame = textDelta('Hello').replace(/\n/g, '\r\n')
    const cut = Math.floor(frame.length / 2)
    expect(detector.push(messageStart + frame.slice(0, cut)).kind).toBe('pending')
    expect(detector.push(frame.slice(cut)).kind).toBe('content')
  })

  it('reads bytes, including a character split between chunks', () => {
    const detector = new StreamCommitDetector()
    const bytes = Buffer.from(textDelta('你好'))
    const cut = bytes.indexOf(Buffer.from('你')) + 1
    expect(detector.push(bytes.subarray(0, cut)).kind).toBe('pending')
    expect(detector.push(bytes.subarray(cut)).kind).toBe('content')
  })

  it('ignores lines that are not data and data that is not JSON', () => {
    const detector = new StreamCommitDetector()
    expect(detector.push(': keep-alive\n\ndata: not json\n\nretry: 1000\n\n').kind).toBe('pending')
  })
})

describe('judgeMessageReply', () => {
  const message = (content: unknown[]) => JSON.stringify({ type: 'message', role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1 } })

  it('accepts a reply with text, a tool call or reasoning', () => {
    expect(judgeMessageReply(message([{ type: 'text', text: 'Hi' }])).kind).toBe('content')
    expect(judgeMessageReply(message([{ type: 'tool_use', id: 't', name: 'Read', input: {} }])).kind).toBe('content')
    expect(judgeMessageReply(message([{ type: 'thinking', thinking: 'hm' }])).kind).toBe('content')
  })

  it('treats a reply with nothing in it as empty', () => {
    expect(judgeMessageReply(message([])).kind).toBe('empty')
    expect(judgeMessageReply(message([{ type: 'text', text: '' }])).kind).toBe('empty')
    expect(judgeMessageReply(message([{ type: 'text', text: ' ' }])).kind).toBe('empty')
  })

  it('treats an error object delivered with a success status as an error', () => {
    expect(judgeMessageReply(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })))
      .toEqual({ kind: 'error', errorType: 'overloaded_error', message: 'busy' })
    expect(judgeMessageReply(JSON.stringify({ error: { message: 'quota exceeded' } })))
      .toEqual({ kind: 'error', errorType: undefined, message: 'quota exceeded' })
  })

  it('treats anything that is not a message as unusable', () => {
    expect(judgeMessageReply('<html>').kind).toBe('empty')
    expect(judgeMessageReply('null').kind).toBe('empty')
    expect(judgeMessageReply(JSON.stringify({ choices: [] })).kind).toBe('empty')
  })
})
