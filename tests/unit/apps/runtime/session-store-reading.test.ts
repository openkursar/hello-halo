/**
 * Session transcript reading without whole-file loads: appends are parsed from
 * where the last read stopped, and a file above the full-parse size is read in
 * windows through a line index whose message ids match a whole parse.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FULL_PARSE_MAX_BYTES,
  readSessionMessages,
  readSessionMessageThoughts,
  readSessionTranscript,
} from '../../../../src/main/apps/runtime/session-store'
import { convertEventsToMessages } from '../../../../src/main/apps/runtime/session-transcript'
import { LineIndex, scanJsonlLines } from '../../../../src/main/apps/runtime/session-file-reader'

let spacePath: string
let filePath: string

const user = (text: string) => JSON.stringify({ _ts: '2026-01-01T00:00:00.000Z', type: 'user', _isTrigger: true, message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (text: string) => JSON.stringify({ _ts: '2026-01-01T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: `think ${text}` }, { type: 'text', text }] } })

function wholeParse(): ReturnType<typeof convertEventsToMessages> {
  const raw = readFileSync(filePath, 'utf8').split('\n')
  const events: never[] = []
  const lines: number[] = []
  raw.forEach((line, i) => {
    if (!line.trim()) return
    try {
      events.push(JSON.parse(line) as never)
      lines.push(i + 1)
    } catch { /* torn */ }
  })
  return convertEventsToMessages(events, lines)
}

beforeEach(() => {
  spacePath = mkdtempSync(join(tmpdir(), 'halo-session-read-'))
  const dir = join(spacePath, '.halo', 'apps', 'app-1', 'runs')
  mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'run-1.jsonl')
})

afterEach(() => {
  rmSync(spacePath, { recursive: true, force: true })
})

describe('incremental parse of a growing transcript', () => {
  it('matches a whole parse after every append, blank and torn lines included', () => {
    writeFileSync(filePath, `${user('q1')}\n\n${assistant('a1')}\n`)
    expect(readSessionMessages(spacePath, 'app-1', 'run-1')).toEqual(wholeParse())

    appendFileSync(filePath, `${user('q2')}\n${assistant('a2')}`)
    expect(readSessionMessages(spacePath, 'app-1', 'run-1')).toEqual(wholeParse())

    appendFileSync(filePath, `\n${user('q3')}\n`)
    const messages = readSessionMessages(spacePath, 'app-1', 'run-1')
    expect(messages).toEqual(wholeParse())
    expect(messages.map(m => m.content)).toEqual(['q1', 'a1', 'q2', 'a2', 'q3'])
  })

  it('limit returns the newest messages', () => {
    writeFileSync(filePath, `${user('q1')}\n${assistant('a1')}\n${user('q2')}\n${assistant('a2')}\n`)
    expect(readSessionMessages(spacePath, 'app-1', 'run-1', { limit: 2 }).map(m => m.content)).toEqual(['q2', 'a2'])
  })
})

describe('line index', () => {
  it('finds line offsets and line starts across checkpoints', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(i % 700)}"}`)
    writeFileSync(filePath, lines.join('\n') + '\n')
    const raw = readFileSync(filePath)
    const fd = openSync(filePath, 'r')
    try {
      const index = LineIndex.open(filePath + '.idx', fd)
      for (const line of [1, 2, 777, 2500, 4999, 5000]) {
        const offset = index.offsetOfLine(fd, line)!
        expect(raw.toString('utf8', offset, raw.indexOf(10, offset))).toBe(lines[line - 1])
      }
      const middle = index.offsetOfLine(fd, 3000)! + 3
      const next = index.lineStartingAtOrAfter(fd, middle)
      expect(next).toEqual({ byte: index.offsetOfLine(fd, 3001), line: 3001 })
    } finally {
      closeSync(fd)
    }
  })

  it('scans lines in chunks with their physical numbers', () => {
    writeFileSync(filePath, 'a\n\nbb\nccc')
    const fd = openSync(filePath, 'r')
    try {
      const seen: Array<[string, number]> = []
      const result = scanJsonlLines(fd, 0, 9, 1, (text, line) => seen.push([text, line]))
      expect(seen).toEqual([['a', 1], ['', 2], ['bb', 3]])
      expect(result.trailing).toEqual({ text: 'ccc', line: 4 })
      expect(result.endByte).toBe(6)
    } finally {
      closeSync(fd)
    }
  })
})

describe('large transcript read in windows', () => {
  function writeLargeTranscript(): void {
    const pad = 'p'.repeat(4000)
    const chunks: string[] = []
    let bytes = 0
    for (let i = 0; bytes < FULL_PARSE_MAX_BYTES + 4 * 1024 * 1024; i++) {
      const pair = `${user(`q${i} ${pad}`)}\n${assistant(`a${i}`)}\n`
      chunks.push(pair)
      bytes += pair.length
    }
    writeFileSync(filePath, chunks.join(''))
  }

  it('pages newest-first with the same ids as a whole parse, and walks back with before', () => {
    writeLargeTranscript()
    const whole = wholeParse()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = readSessionTranscript(spacePath, 'app-1', 'run-1', { limit: 20 })
    expect(first.hasMoreBefore).toBe(true)
    expect(first.messages.map(m => m.id)).toEqual(whole.slice(-20).map(m => m.id))
    expect(first.messages.filter(m => m.role === 'assistant').every(m => m.thoughts === null)).toBe(true)

    const second = readSessionTranscript(spacePath, 'app-1', 'run-1', { limit: 20, before: first.cursor! })
    expect(second.messages.map(m => m.id)).toEqual(whole.slice(-40, -20).map(m => m.id))
    expect(second.messages.map(m => m.content)).toEqual(whole.slice(-40, -20).map(m => m.content))

    const target = whole[whole.length - 7]
    // Thought ids are numbered per read, so compare the content.
    const strip = (ts: Array<{ id: string }> | null | undefined) => (ts ?? []).map(({ id: _id, ...rest }) => rest)
    expect(strip(readSessionMessageThoughts(spacePath, 'app-1', 'run-1', target.id))).toEqual(strip(target.thoughts))
    expect(target.thoughts?.length).toBeGreaterThan(0)

    expect(existsSync(filePath.replace(/\.jsonl$/, '.lineidx.json'))).toBe(true)
    warn.mockRestore()
  })

  it('limited whole-transcript reads take the newest messages from the last window', () => {
    writeLargeTranscript()
    const whole = wholeParse()
    const recent = readSessionMessages(spacePath, 'app-1', 'run-1', { limit: 10 })
    expect(recent.map(m => m.id)).toEqual(whole.slice(-10).map(m => m.id))
  })
})

describe('a turn larger than a window', () => {
  const thinking = (t: string) => JSON.stringify({ _ts: '2026-01-01T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: t }] } })
  const text = (t: string) => JSON.stringify({ _ts: '2026-01-01T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })

  function writeHugeTurn(): void {
    writeFileSync(filePath, `${user('small q')}\n${text('small a')}\n${user('big q')}\n`)
    const pad = 'x'.repeat(100_000)
    const chunk = Array.from({ length: 50 }, (_, i) => thinking(pad + i)).join('\n') + '\n'
    for (let i = 0; i < 8; i++) appendFileSync(filePath, chunk)
    appendFileSync(filePath, `${text('final answer')}\n`)
  }

  it('never returns an empty page while messages exist', () => {
    writeHugeTurn()
    const page = readSessionTranscript(spacePath, 'app-1', 'run-1', { limit: 50 })
    expect(page.messages.map(m => m.content)).toEqual(['small q', 'small a', 'big q', 'final answer'])
    expect(page.messages.map(m => m.id)).toEqual(wholeParse().map(m => m.id))
  })

  it('limited reads include the huge turn', () => {
    writeHugeTurn()
    expect(readSessionMessages(spacePath, 'app-1', 'run-1', { limit: 2 }).map(m => m.content)).toEqual(['big q', 'final answer'])
  })

  it('loads the full thought process of the huge turn', () => {
    writeHugeTurn()
    const last = wholeParse().at(-1)!
    expect(readSessionMessageThoughts(spacePath, 'app-1', 'run-1', last.id)).toHaveLength(last.thoughts!.length)
  })
})

describe('line index sidecar', () => {
  it('is not reused for a recreated file that got the same inode back', () => {
    const sidecar = filePath + '.idx'
    writeFileSync(filePath, 'a\nbb\nccc\n')
    let fd = openSync(filePath, 'r')
    try { LineIndex.open(sidecar, fd).persist() } finally { closeSync(fd) }
    // Same inode, different content: rewrite in place.
    writeFileSync(filePath, 'xxxxxxxx\ny\nzzzz\nw\n')
    fd = openSync(filePath, 'r')
    try {
      const index = LineIndex.open(sidecar, fd)
      expect(index.offsetOfLine(fd, 2)).toBe(9)
      expect(index.offsetOfLine(fd, 4)).toBe(16)
    } finally { closeSync(fd) }
  })
})

