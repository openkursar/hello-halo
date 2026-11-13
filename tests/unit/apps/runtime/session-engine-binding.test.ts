import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { join } from 'path'
import { deleteChatSessionId, deleteRunTranscript, loadChatEngineState, loadChatSessionId, openSessionWriter, readChatHandoffHistory, saveChatEngineBinding, saveChatEngineRouting, saveChatSessionId, reloadChatInstructions, copyChatEngineState } from '../../../../src/main/apps/runtime/session-store'
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

  it('reloads only existing CC and legacy chat bindings, preserving native history and other entries', () => {
    const { root, map } = paths()
    saveChatEngineBinding(root, 'app', 'chat', binding('anthropic', 'cc-native'))
    saveChatSessionId(root, 'app', 'chat-local-direct-old', 'legacy-native')
    saveChatEngineBinding(root, 'app', 'chat-halo', binding('halo', 'halo-native'))
    saveChatEngineBinding(root, 'app', 'scheduled-run', binding('anthropic', 'run-native'))
    saveChatEngineRouting(root, 'app', 'chat-pending', 'anthropic', {})
    const writer = openSessionWriter(root, 'app', 'chat')
    writer.writeTrigger('Keep the original conversation')
    const transcript = join(root, '.halo/apps/app/runs/chat.jsonl')
    const beforeTranscript = fs.readFileSync(transcript, 'utf8')
    const before = loadChatEngineState(root, 'app', 'chat')
    const rename = vi.spyOn(fs, 'renameSync')
    rename.mockClear()
    expect(reloadChatInstructions(root, 'app')).toBe(2)
    expect(rename).toHaveBeenCalledTimes(1)
    const current = loadChatEngineState(root, 'app', 'chat')
    expect(current).toEqual({ sessionId: 'cc-native', binding: { ...binding('anthropic', 'cc-native'), useCurrentInstructions: true }, useCurrentInstructions: true })
    expect(loadChatEngineState(root, 'app', 'chat-local-direct-old')).toEqual({ sessionId: 'legacy-native', useCurrentInstructions: true })
    expect(JSON.parse(fs.readFileSync(map, 'utf8'))).toMatchObject({
      'chat-halo': binding('halo', 'halo-native'), 'scheduled-run': binding('anthropic', 'run-native'),
      'chat-pending': { version: 1, engineId: 'anthropic' },
    })
    expect(fs.readFileSync(transcript, 'utf8')).toBe(beforeTranscript)
    expect(saveChatEngineBinding(root, 'app', 'chat', binding('anthropic', 'cc-native'), before)).toBe(false)
    expect(() => saveChatEngineRouting(root, 'app', 'chat', 'anthropic', before)).toThrow('changed while')
    rename.mockClear()
    expect(reloadChatInstructions(root, 'app')).toBe(0)
    expect(rename).not.toHaveBeenCalled()
    saveChatSessionId(root, 'app', 'chat-local-direct-old', 'legacy-native')
    expect(rename).not.toHaveBeenCalled()
    expect(loadChatEngineState(root, 'app', 'chat-local-direct-old').useCurrentInstructions).toBe(true)
    expect(saveChatEngineBinding(root, 'app', 'chat', binding('halo', 'new-halo'), current)).toBe(true)
    expect(loadChatEngineState(root, 'app', 'chat')).toEqual({ sessionId: 'new-halo', binding: binding('halo', 'new-halo') })
  })

  it('keeps reload intent on a legacy row until its acknowledged binding replaces it', () => {
    const { root } = paths()
    saveChatSessionId(root, 'app', 'chat', 'legacy')
    reloadChatInstructions(root, 'app')
    const expected = loadChatEngineState(root, 'app', 'chat')
    expect(saveChatEngineRouting(root, 'app', 'chat', 'halo', expected)).toEqual(expected)
    expect(saveChatEngineBinding(root, 'app', 'chat', { ...binding('anthropic', 'legacy'), useCurrentInstructions: true }, expected)).toBe(true)
    expect(loadChatEngineState(root, 'app', 'chat')).toMatchObject({ useCurrentInstructions: true, binding: { engineId: 'anthropic', sessionId: 'legacy', useCurrentInstructions: true } })
    deleteChatSessionId(root, 'app', 'chat')
    expect(loadChatEngineState(root, 'app', 'chat')).toEqual({})
  })

  it.each([
    { version: 1, engineId: 'anthropic', useCurrentInstructions: false },
    { version: 1, engineId: 'anthropic', useCurrentInstructions: 'invalid' },
    { version: 1, engineId: 'anthropic', legacySessionId: 'legacy', useCurrentInstructions: true },
  ])('refuses malformed reload metadata instead of treating it as an ordinary route', value => {
    const { root, map } = paths()
    fs.mkdirSync(join(map, '..'), { recursive: true })
    const raw = JSON.stringify({ chat: value })
    fs.writeFileSync(map, raw)
    expect(() => loadChatEngineState(root, 'app', 'chat')).toThrow('reload state is invalid')
    expect(() => reloadChatInstructions(root, 'app')).toThrow('Could not reload')
    expect(fs.readFileSync(map, 'utf8')).toBe(raw)
  })

  it('preserves binding bytes and reports a failed reload write', () => {
    const { root, map } = paths()
    saveChatEngineBinding(root, 'app', 'chat', binding('anthropic', 'native'))
    const before = fs.readFileSync(map, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('unavailable') })
    expect(() => reloadChatInstructions(root, 'app')).toThrow('Could not reload')
    expect(fs.readFileSync(map, 'utf8')).toBe(before)
    expect(fs.readdirSync(join(map, '..')).some(name => name.endsWith('.tmp'))).toBe(false)
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

describe('copying engine state into a new client conversation', () => {
  it.each(['legacy-reload', 'modern-reload', 'modern-unchanged'] as const)('copies %s without changing the source or inferring its engine', format => {
    const { root, map } = paths()
    if (format === 'legacy-reload') saveChatSessionId(root, 'app', 'chat', 'native')
    else saveChatEngineBinding(root, 'app', 'chat', binding('anthropic', 'native'))
    saveChatEngineBinding(root, 'app', 'other', binding('halo', 'other-native'))
    if (format !== 'modern-unchanged') reloadChatInstructions(root, 'app')
    const before = JSON.parse(fs.readFileSync(map, 'utf8'))
    const read = vi.mocked(fs.readFileSync)
    read.mockClear()
    const rename = vi.mocked(fs.renameSync)
    rename.mockClear()
    copyChatEngineState(root, 'app', 'chat', 'chat-local-direct-fork')
    expect(read).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledTimes(1)
    const state = loadChatEngineState(root, 'app', 'chat-local-direct-fork')
    expect(state).toEqual(loadChatEngineState(root, 'app', 'chat'))
    const after = JSON.parse(fs.readFileSync(map, 'utf8'))
    expect(after).toEqual({ ...before, 'chat-local-direct-fork': before.chat })
    if (format === 'legacy-reload') {
      expect(state).toEqual({ sessionId: 'native', useCurrentInstructions: true })
      expect(after['chat-local-direct-fork']).toEqual({ version: 1, legacySessionId: 'native', useCurrentInstructions: true })
    }
    const recreated = loadChatEngineState(root, 'app', 'chat-local-direct-fork')
    expect(recreated).toEqual(state)
  })

  it.each(['missing', 'legacy', 'routing'] as const)('leaves a %s source on its original pending-resume path without writing', kind => {
    const { root, map } = paths()
    saveChatSessionId(root, 'app', 'other', 'untouched')
    if (kind === 'legacy') saveChatSessionId(root, 'app', 'chat', 'unbound-native')
    if (kind === 'routing') saveChatEngineRouting(root, 'app', 'chat', 'anthropic')
    const before = fs.readFileSync(map, 'utf8')
    const rename = vi.mocked(fs.renameSync)
    rename.mockClear()
    copyChatEngineState(root, 'app', 'chat', 'chat-local-direct-fork')
    expect(rename).not.toHaveBeenCalled()
    expect(fs.readFileSync(map, 'utf8')).toBe(before)
    expect(loadChatEngineState(root, 'app', 'chat-local-direct-fork')).toEqual({})
  })

  it.each(['anthropic', 'halo', 'codex', 'dsh'] as const)('keeps %s ownership unchanged when copying an existing binding', engineId => {
    const { root } = paths()
    const source = binding(engineId, 'source-native')
    saveChatEngineBinding(root, 'app', 'chat', source)
    copyChatEngineState(root, 'app', 'chat', 'chat-local-direct-fork')
    expect(loadChatEngineState(root, 'app', 'chat-local-direct-fork')).toEqual({ sessionId: 'source-native', binding: source })
  })

  it.each(['same-source', 'legacy-target', 'bound-target', 'routing-target', 'malformed-target'] as const)('refuses %s without replacing any existing state', conflict => {
    const { root, map } = paths()
    saveChatSessionId(root, 'app', 'chat', 'source-native')
    reloadChatInstructions(root, 'app')
    const target = conflict === 'same-source' ? 'chat' : 'chat-local-direct-fork'
    if (conflict === 'legacy-target') saveChatSessionId(root, 'app', target, 'target-native')
    if (conflict === 'bound-target') saveChatEngineBinding(root, 'app', target, binding('halo', 'target-native'))
    if (conflict === 'routing-target') saveChatEngineRouting(root, 'app', target, 'halo')
    if (conflict === 'malformed-target') {
      const current = JSON.parse(fs.readFileSync(map, 'utf8'))
      current[target] = null
      fs.writeFileSync(map, JSON.stringify(current))
    }
    const before = fs.readFileSync(map, 'utf8')
    const rename = vi.mocked(fs.renameSync)
    rename.mockClear()
    expect(() => copyChatEngineState(root, 'app', 'chat', target)).toThrow('Could not preserve')
    expect(rename).not.toHaveBeenCalled()
    expect(fs.readFileSync(map, 'utf8')).toBe(before)
  })

  it.each([
    { version: 1, engineId: 'anthropic', useCurrentInstructions: true },
    { version: 1, legacySessionId: 'source-native', useCurrentInstructions: false },
  ])('refuses malformed source metadata without creating destination state', source => {
    const { root, map } = paths()
    fs.mkdirSync(join(map, '..'), { recursive: true })
    const before = JSON.stringify({ chat: source })
    fs.writeFileSync(map, before)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => copyChatEngineState(root, 'app', 'chat', 'chat-local-direct-fork')).toThrow('Could not preserve')
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('Could not copy fork engine state'), expect.any(Error))
    expect(fs.readFileSync(map, 'utf8')).toBe(before)
  })

  it.each(['read', 'write'] as const)('preserves the map when its %s fails', operation => {
    const { root, map } = paths()
    saveChatSessionId(root, 'app', 'chat', 'source-native')
    reloadChatInstructions(root, 'app')
    const before = fs.readFileSync(map, 'utf8')
    const unavailable = Object.assign(new Error('resource unavailable'), { code: 'EBUSY' })
    if (operation === 'read') vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw unavailable })
    else vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw unavailable })
    expect(() => copyChatEngineState(root, 'app', 'chat', 'chat-local-direct-fork')).toThrow('Could not preserve')
    expect(fs.readFileSync(map, 'utf8')).toBe(before)
    expect(fs.readdirSync(join(map, '..')).some(name => name.endsWith('.tmp'))).toBe(false)
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
