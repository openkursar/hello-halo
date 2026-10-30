import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { join } from 'path'
import { deleteChatSessionId, deleteRunTranscript, loadChatEngineState, loadChatSessionId, openSessionWriter, readChatHandoffHistory, saveChatEngineBinding, saveChatEngineRouting, saveChatSessionId } from '../../../../src/main/apps/runtime/session-store'
import type { EngineSessionBinding } from '../../../../src/shared/types/engine-session'

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), readFileSync: vi.fn(actual.readFileSync) }
})

const binding = (engineId: EngineSessionBinding['engineId'], sessionId: string): EngineSessionBinding => ({ version: 1, engineId, sessionId })
const paths = () => ({ root: globalThis.__HALO_TEST_DIR__, file: join(globalThis.__HALO_TEST_DIR__, '.halo/apps/app/runs/run.jsonl'), map: join(globalThis.__HALO_TEST_DIR__, '.halo/apps/app/runs/_session-ids.json') })
afterEach(() => { vi.restoreAllMocks() })

describe('app engine session bindings', () => {
  it('persists first-start routing without inventing a native session and commits its acknowledged replacement with CAS', () => {
    const { root, map } = paths()
    const route = saveChatEngineRouting(root, 'app', 'run', 'codex', {})
    expect(route).toEqual({ routingEngine: 'codex' })
    expect(loadChatSessionId(root, 'app', 'run')).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(map, 'utf8')).run).toEqual({ version: 1, engineId: 'codex' })
    const rename = vi.spyOn(fs, 'renameSync')
    rename.mockClear()
    expect(saveChatEngineRouting(root, 'app', 'run', 'codex', {})).toEqual(route)
    expect(saveChatEngineRouting(root, 'app', 'run', 'halo', route)).toEqual(route)
    expect(rename).not.toHaveBeenCalled()
    saveChatSessionId(root, 'app', 'run', 'late-unbound-id')
    expect(loadChatEngineState(root, 'app', 'run')).toEqual(route)
    expect(saveChatEngineBinding(root, 'app', 'run', binding('codex', 'first-native'), {})).toBe(false)
    expect(saveChatEngineBinding(root, 'app', 'run', binding('codex', 'first-native'), route)).toBe(true)
    expect(loadChatEngineState(root, 'app', 'run')).toEqual({ sessionId: 'first-native', binding: binding('codex', 'first-native') })
  })

  it('does not backfill an existing legacy row while reading or pinning another session', () => {
    const { root, map } = paths()
    saveChatSessionId(root, 'app', 'other', 'legacy-native')
    saveChatEngineRouting(root, 'app', 'run', 'halo', {})
    expect(saveChatEngineRouting(root, 'app', 'other', 'halo', { sessionId: 'legacy-native' })).toEqual({ sessionId: 'legacy-native' })
    expect(JSON.parse(fs.readFileSync(map, 'utf8')).other).toBe('legacy-native')
  })

  it('removes routing and native bindings when their run transcripts are retained no longer', () => {
    const { root, map } = paths()
    saveChatEngineRouting(root, 'app', 'pending', 'halo', {})
    saveChatEngineBinding(root, 'app', 'run', binding('codex', 'native'))
    saveChatSessionId(root, 'app', 'chat', 'chat-native')
    openSessionWriter(root, 'app', 'run').writeTrigger('Old task')
    deleteRunTranscript(root, 'app', 'run')
    deleteRunTranscript(root, 'app', 'pending')
    expect(JSON.parse(fs.readFileSync(map, 'utf8'))).toEqual({ chat: 'chat-native' })
  })

  it('keeps legacy rows intact and persists one current engine binding across module-independent reads', () => {
    const { root, map } = paths()
    saveChatSessionId(root, 'app', 'other', 'legacy')
    saveChatSessionId(root, 'app', 'run', 'old-a')
    const expected = loadChatEngineState(root, 'app', 'run')
    expect(expected).toEqual({ sessionId: 'old-a' })
    expect(saveChatEngineBinding(root, 'app', 'run', binding('codex', 'new-b'), expected)).toBe(true)
    expect(JSON.parse(fs.readFileSync(map, 'utf8'))).toEqual({ other: 'legacy', run: binding('codex', 'new-b') })
    expect(loadChatSessionId(root, 'app', 'run')).toBe('new-b')
    saveChatSessionId(root, 'app', 'run', 'late-a')
    expect(saveChatEngineBinding(root, 'app', 'run', binding('anthropic', 'late-a'), expected)).toBe(false)
    expect(loadChatEngineState(root, 'app', 'run')).toEqual({ sessionId: 'new-b', binding: binding('codex', 'new-b') })
    deleteChatSessionId(root, 'app', 'run')
    expect(loadChatEngineState(root, 'app', 'run')).toEqual({})
    expect(loadChatSessionId(root, 'app', 'other')).toBe('legacy')
  })

  it('skips disk writes for unchanged bindings after validating the expected owner', () => {
    const { root } = paths()
    saveChatEngineBinding(root, 'app', 'run', binding('halo', 'h'), {})
    const state = loadChatEngineState(root, 'app', 'run')
    const rename = vi.spyOn(fs, 'renameSync')
    rename.mockClear()
    expect(saveChatEngineBinding(root, 'app', 'run', binding('halo', 'h'), state)).toBe(true)
    expect(rename).not.toHaveBeenCalled()
    expect(saveChatEngineBinding(root, 'app', 'run', binding('halo', 'h'), {})).toBe(false)
  })

  it('preserves the old binding and transcript on an atomic write failure', () => {
    const { root, file, map } = paths()
    saveChatEngineBinding(root, 'app', 'run', binding('halo', 'h'))
    openSessionWriter(root, 'app', 'run').writeTrigger('Keep this history')
    const beforeMap = fs.readFileSync(map, 'utf8')
    const beforeTranscript = fs.readFileSync(file, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('Disk unavailable') })
    expect(() => saveChatEngineBinding(root, 'app', 'run', binding('codex', 'c'), loadChatEngineState(root, 'app', 'run'))).toThrow('Could not save')
    expect(fs.readFileSync(map, 'utf8')).toBe(beforeMap)
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeTranscript)
    expect(fs.readdirSync(join(root, '.halo/apps/app/runs')).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('sets a torn binding file aside, keeping its bytes, and lets every chat continue', () => {
    const { root, map } = paths()
    const runs = join(root, '.halo/apps/app/runs')
    saveChatSessionId(root, 'app', 'run', 'old')
    fs.writeFileSync(map, '{"run":"old","other":"se')
    expect(loadChatEngineState(root, 'app', 'run')).toEqual({})
    const aside = fs.readdirSync(runs).filter(name => name.startsWith('_session-ids.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(join(runs, aside[0]), 'utf8')).toBe('{"run":"old","other":"se')
    expect(saveChatEngineBinding(root, 'app', 'run', binding('halo', 'h'), {})).toBe(true)
    expect(loadChatEngineState(root, 'app', 'run')).toEqual({ sessionId: 'h', binding: binding('halo', 'h') })
  })

  it('treats an empty or non-object binding file as torn', () => {
    const { root, map } = paths()
    for (const content of ['', '[]', 'null']) {
      fs.mkdirSync(join(map, '..'), { recursive: true })
      fs.writeFileSync(map, content)
      expect(saveChatEngineRouting(root, 'app', 'run', 'halo', {})).toEqual({ routingEngine: 'halo' })
      fs.rmSync(map)
    }
  })

  it('keeps the file and fails only this turn when it cannot be read right now', () => {
    const { root, map } = paths()
    saveChatSessionId(root, 'app', 'run', 'old')
    const locked = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw locked })
    expect(() => loadChatEngineState(root, 'app', 'run')).toThrow('unavailable')
    expect(JSON.parse(fs.readFileSync(map, 'utf8'))).toEqual({ run: 'old' })
    expect(loadChatEngineState(root, 'app', 'run')).toEqual({ sessionId: 'old' })
  })
})

describe('bounded app handoff history', () => {
  it('retains recent user/assistant/tool results without reasoning and does not build a line index', () => {
    const { root, file } = paths()
    const writer = openSessionWriter(root, 'app', 'run')
    writer.writeTrigger('Fix /workspace/a.ts')
    writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/workspace/a.ts' } }] } })
    writer.writeEvent({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'File content' }] } })
    writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it' }] } })
    const history = readChatHandoffHistory(root, 'app', 'run')
    expect(history.truncated).toBe(false)
    expect(history.messages.map(message => message.content)).toEqual(['Fix /workspace/a.ts', 'Fixed it'])
    expect(history.messages[1].thoughts?.find(thought => thought.type === 'tool_use')?.toolResult?.output).toBe('File content')
    expect(JSON.stringify(history)).not.toContain('PRIVATE_REASONING')
    expect(history.latestMessageId).toMatch(/^session-byte-\d+$/)
    expect(history.transcriptPath).toBe(file)
    expect(fs.readdirSync(join(root, '.halo/apps/app/runs'))).toEqual(['run.jsonl'])
  })

  it('marks a limited or partially corrupt tail and keeps the latest available context', () => {
    const { root, file } = paths()
    const writer = openSessionWriter(root, 'app', 'run')
    for (let i = 0; i < 200; i++) writer.writeTrigger(`${i}: ${'padding'.repeat(100)}`)
    fs.appendFileSync(file, 'invalid record\n')
    writer.writeTrigger('Latest decision made in engine B')
    const history = readChatHandoffHistory(root, 'app', 'run', { maxBytes: 4096, limit: 2 })
    expect(history.truncated).toBe(true)
    expect(history.messages).toHaveLength(2)
    expect(history.messages.at(-1)?.content).toBe('Latest decision made in engine B')
    expect(history.transcriptPath).toBe(file)
  })

  it('distinguishes an empty transcript from missing history', () => {
    const { root, file } = paths()
    expect(() => readChatHandoffHistory(root, 'app', 'missing')).toThrow('history is unavailable')
    openSessionWriter(root, 'app', 'run')
    fs.writeFileSync(file, '')
    expect(readChatHandoffHistory(root, 'app', 'run')).toMatchObject({ messages: [], truncated: false })
  })
})
