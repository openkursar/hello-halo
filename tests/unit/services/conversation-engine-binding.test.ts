import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import * as fs from 'fs'
import type { EngineSessionBinding } from '../../../src/shared/types/engine-session'

vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => ({ id, path: join(globalThis.__HALO_TEST_DIR__, id), isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => undefined }))
import { addMessage, createConversation, getConversation, getConversationEngineState, readConversationHandoffHistory, resolveConversationTranscriptPath, saveConversationEngineBinding, saveSessionId, updateConversation, updateLastMessage } from '../../../src/main/services/conversation.service'
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const binding = (engineId: EngineSessionBinding['engineId'], sessionId: string): EngineSessionBinding => ({ version: 1, engineId, sessionId })
afterEach(() => { vi.restoreAllMocks() })
beforeEach(() => {
  const dir = join(globalThis.__HALO_TEST_DIR__, 'space/.halo/conversations')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), conversations: [] }))
})

describe('conversation engine bindings', () => {
  it('commits only the expected current binding and blocks late native callbacks and generic patches', () => {
    const { id } = createConversation('space')
    addMessage('space', id, { role: 'user', content: 'Keep the original task' })
    saveSessionId('space', id, 'old-a')
    const expected = getConversationEngineState('space', id)!
    expect(saveConversationEngineBinding('space', id, binding('codex', 'new-b'), expected)).toBe(true)
    expect(saveConversationEngineBinding('space', id, binding('anthropic', 'late-a'), expected)).toBe(false)
    saveSessionId('space', id, 'late-a')
    updateConversation('space', id, { sessionId: 'external', engineBinding: binding('halo', 'external'), title: 'Safe rename' })
    expect(getConversationEngineState('space', id)).toEqual({ sessionId: 'new-b', binding: binding('codex', 'new-b') })
    expect(getConversation('space', id)).toMatchObject({ title: 'Safe rename', messages: [{ content: 'Keep the original task' }] })
    expect(JSON.parse(fs.readFileSync(resolveConversationTranscriptPath('space', id)!, 'utf8')).engineBinding).toEqual(binding('codex', 'new-b'))
  })

  it('versions only newly created routing identities and protects them from generic updates', () => {
    const conversation = createConversation('space', 'New', undefined, { engineId: 'codex' })
    expect(conversation).toMatchObject({ engineRoutingVersion: 1, engineId: 'codex' })
    updateConversation('space', conversation.id, { engineId: 'halo', engineRoutingVersion: undefined, title: 'Renamed' })
    expect(getConversation('space', conversation.id)).toMatchObject({ engineRoutingVersion: 1, engineId: 'codex', title: 'Renamed' })
    const file = resolveConversationTranscriptPath('space', conversation.id)!
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).engineRoutingVersion).toBe(1)
  })

  it('does not infer the new routing version from a legacy origin badge', () => {
    const file = join(globalThis.__HALO_TEST_DIR__, 'space/.halo/conversations/legacy-record.json')
    fs.writeFileSync(file, JSON.stringify({ id: 'legacy-record', spaceId: 'space', title: 'Legacy', createdAt: '2026-01-01', updatedAt: '2026-01-01', messageCount: 0, messages: [], version: 2, engineId: 'halo' }))
    expect(getConversation('space', 'legacy-record')?.engineRoutingVersion).toBeUndefined()
    updateConversation('space', 'legacy-record', { title: 'Still legacy' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).engineRoutingVersion).toBeUndefined()
  })

  it('performs no write for an unchanged binding but still checks stale expectations', () => {
    const { id } = createConversation('space')
    saveConversationEngineBinding('space', id, binding('halo', 'h'), {})
    const state = getConversationEngineState('space', id)!
    const rename = vi.spyOn(fs, 'renameSync')
    expect(saveConversationEngineBinding('space', id, binding('halo', 'h'), state)).toBe(true)
    expect(rename).not.toHaveBeenCalled()
    expect(saveConversationEngineBinding('space', id, binding('halo', 'h'), {})).toBe(false)
  })

  it('does not mutate cached state, disk history or binding when atomic commit fails', () => {
    const { id } = createConversation('space')
    saveConversationEngineBinding('space', id, binding('halo', 'h'))
    const state = getConversationEngineState('space', id)!
    const file = resolveConversationTranscriptPath('space', id)!
    const previous = fs.readFileSync(file, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failure') })
    expect(() => saveConversationEngineBinding('space', id, binding('codex', 'c'), state)).toThrow('disk failure')
    expect(getConversationEngineState('space', id)).toEqual(state)
    expect(fs.readFileSync(file, 'utf8')).toBe(previous)
  })
})

describe('space handoff history', () => {
  it('honors a captured boundary and retains tools from the companion file without reasoning', () => {
    const { id } = createConversation('space')
    addMessage('space', id, { role: 'user', content: 'Original goal' })
    const answer = addMessage('space', id, { role: 'assistant', content: 'The file is ready' })
    updateLastMessage('space', id, { thoughts: [
      { id: 'private', type: 'thinking', content: 'PRIVATE_REASONING', timestamp: answer.timestamp },
      { id: 'tool', type: 'tool_use', content: '', toolName: 'Read', toolInput: { file_path: '/workspace/file' }, timestamp: answer.timestamp, toolResult: { output: 'Important tool result', timestamp: answer.timestamp, isError: false } },
    ] })
    const current = addMessage('space', id, { role: 'user', content: 'NEW_CURRENT_INPUT' })
    const history = readConversationHandoffHistory('space', id, { throughMessageId: answer.id })
    expect(history.messages.map(message => message.content)).toEqual(['Original goal', 'The file is ready'])
    expect(history.messages[1].thoughts).toHaveLength(1)
    expect(history.messages[1].thoughts?.[0].toolResult?.output).toBe('Important tool result')
    expect(JSON.stringify(history)).not.toContain('PRIVATE_REASONING')
    expect(history.completeRecordPaths).toHaveLength(2)
    expect(readConversationHandoffHistory('space', id, { beforeMessageId: current.id })).toEqual(history)
    expect(getConversation('space', id)?.messages).toHaveLength(3)
  })

  it('marks omitted messages and oversized tool storage instead of claiming a full history', () => {
    const { id } = createConversation('space')
    addMessage('space', id, { role: 'user', content: 'Old decision' })
    addMessage('space', id, { role: 'assistant', content: 'Latest decision' })
    updateLastMessage('space', id, { thoughts: [{ id: 'large', type: 'tool_result', content: 'x'.repeat(5000), timestamp: '2026-01-01' }] })
    const history = readConversationHandoffHistory('space', id, { limit: 1, maxBytes: 2048 })
    expect(history.truncated).toBe(true)
    expect(history.messages.map(message => message.content)).toEqual(['Latest decision'])
    expect(history.completeRecordPaths?.every(path => fs.existsSync(path))).toBe(true)
  })

  it('does not synchronously parse a companion history above the default 4 MiB budget', () => {
    const { id } = createConversation('space')
    addMessage('space', id, { role: 'assistant', content: 'Visible conclusion' })
    updateLastMessage('space', id, { thoughts: [{ id: 'tool', type: 'tool_result', content: 'result', timestamp: '2026-01-01' }] })
    const main = resolveConversationTranscriptPath('space', id)!
    const companion = main.replace(/\.json$/, '.thoughts.json')
    fs.writeFileSync(companion, JSON.stringify({ version: 1, messages: {}, omittedLargeResult: 'x'.repeat(5 * 1024 * 1024) }))
    const read = vi.spyOn(fs, 'readFileSync')
    const history = readConversationHandoffHistory('space', id)
    expect(history.truncated).toBe(true)
    expect(read.mock.calls.some(call => call[0] === companion)).toBe(false)
    read.mockRestore()
    expect(history.completeRecordPaths).toContain(companion)
    expect(JSON.parse(fs.readFileSync(companion, 'utf8')).omittedLargeResult).toHaveLength(5 * 1024 * 1024)
    expect(history.messages[0].content).toBe('Visible conclusion')
  })

  it('filters exact message IDs while preserving identical text and the stored records', () => {
    const { id } = createConversation('space')
    const earlier = addMessage('space', id, { role: 'system', content: 'Same text', source: 'cross-conversation' })
    const pending = addMessage('space', id, { role: 'system', content: 'Same text', source: 'cross-conversation' })
    const current = addMessage('space', id, { role: 'user', content: 'Current batch input' })
    addMessage('space', id, { role: 'system', content: 'Extra current batch record', source: 'cross-conversation' })
    const file = resolveConversationTranscriptPath('space', id)!
    const before = fs.readFileSync(file, 'utf8')
    const history = readConversationHandoffHistory('space', id, { beforeMessageId: current.id, excludeMessageIds: [pending.id] })
    expect(history.messages.map(message => message.id)).toEqual([earlier.id])
    expect(history.messages[0].content).toBe('Same text')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('refuses missing history or an unknown cutoff rather than silently losing context', () => {
    const { id } = createConversation('space')
    expect(() => readConversationHandoffHistory('space', id, { throughMessageId: 'missing' })).toThrow('history changed')
    expect(() => readConversationHandoffHistory('space', 'missing')).toThrow('history is unavailable')
  })
})
