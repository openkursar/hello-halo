import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const { createSession, getActiveEngine, paths } = vi.hoisted(() => ({
  createSession: vi.fn(),
  getActiveEngine: vi.fn(() => 'halo'),
  paths: { userData: '', home: '' },
}))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => paths.userData), getVersion: vi.fn(() => '0.0.0'), isPackaged: false } }))
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => paths.home } }
})
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ createSession, getActiveEngine }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn(), trackErrorSurface: vi.fn() } }))
vi.mock('../../../../src/main/services/agent/session-consumer', () => ({ startConsumer: vi.fn() }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applySessionReasoningEffort: vi.fn(), pickReasoningEffort: vi.fn(() => undefined) }))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({
  resolveConversationKnowledgeBases: vi.fn(() => []),
  resolveConversationKnowledgeBaseIds: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({ setSessionInvalidator: vi.fn(), buildCreationTimeServers: vi.fn(() => ({})) }))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: vi.fn(() => '') }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({ dropConversationState: vi.fn(), getOpenToolsets: vi.fn(() => []) }))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_TOOLSET_ID: 'halo-api-ref' }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation: vi.fn(() => null) }))
vi.mock('../../../../src/main/services/health', () => ({ registerProcess: vi.fn(), unregisterProcess: vi.fn(), getCurrentInstanceId: vi.fn(() => null) }))

import { getOrCreateV2Session, closeAllV2Sessions, stopSessionCleanup } from '../../../../src/main/services/agent/session-manager'

const directories: string[] = []
beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'halo-resume-config-'))
  directories.push(directory)
  paths.userData = join(directory, 'app-data')
  paths.home = join(directory, 'home')
  getActiveEngine.mockReturnValue('halo')
  createSession.mockResolvedValue({
    close: vi.fn(),
    query: { transport: { isReady: () => true, onExit: () => () => {} } },
  })
})
afterEach(() => {
  closeAllV2Sessions()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  createSession.mockReset()
})
afterAll(() => stopSessionCleanup())

function fixture() {
  const directory = directories[0]
  const workDir = join(directory, 'workspace')
  const configDir = join(directory, 'sdk-state')
  const sessionId = randomUUID()
  mkdirSync(workDir, { recursive: true })
  const transcript = (root: string) => join(root, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
  const save = (root: string, content = 'Remember the saved value.') => {
    mkdirSync(join(root, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true })
    writeFileSync(transcript(root), JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
  }
  const resume = (root?: string) => getOrCreateV2Session('space', randomUUID(), {
    model: 'test-model', systemPrompt: 'test', env: root ? { CLAUDE_CONFIG_DIR: root } : {},
  }, sessionId, workDir)
  return { configDir, sessionId, transcript, save, resume }
}

it.each(['halo', 'anthropic'])('resumes %s history from the session config directory', async engine => {
  getActiveEngine.mockReturnValue(engine)
  const { configDir, sessionId, save, resume } = fixture()
  save(configDir)
  await resume(configDir)

  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
    resume: sessionId, env: expect.objectContaining({ CLAUDE_CONFIG_DIR: configDir }),
  }))
})

it.each(['halo', 'cc'])('copies %s legacy history into the selected config directory', async legacy => {
  const { configDir, sessionId, transcript, save, resume } = fixture()
  const source = legacy === 'halo' ? join(paths.userData, 'claude-config') : join(paths.home, '.claude')
  save(source)
  await resume(configDir)
  expect(readFileSync(transcript(configDir), 'utf8')).toBe(readFileSync(transcript(source), 'utf8'))
  expect(createSession.mock.calls[0][0].resume).toBe(sessionId)
})

it('keeps the current history when a legacy copy also exists', async () => {
  const { configDir, transcript, save, resume } = fixture()
  save(configDir, 'current')
  save(join(paths.userData, 'claude-config'), 'older')
  await resume(configDir)
  expect(readFileSync(transcript(configDir), 'utf8')).toContain('current')
})

it('retains legacy migration into Halo when no config directory is supplied', async () => {
  const { sessionId, transcript, save, resume } = fixture()
  save(join(paths.home, '.claude'))
  await resume()
  expect(existsSync(transcript(join(paths.userData, 'claude-config')))).toBe(true)
  expect(createSession.mock.calls[0][0].resume).toBe(sessionId)
})

it('resumes directly in the Claude Code directory without copying into Halo', async () => {
  const { sessionId, transcript, save, resume } = fixture()
  const configDir = join(paths.home, '.claude')
  save(configDir)
  await resume(configDir)
  expect(createSession.mock.calls[0][0].resume).toBe(sessionId)
  expect(existsSync(transcript(join(paths.userData, 'claude-config')))).toBe(false)
})

it('starts fresh when no transcript exists', async () => {
  const { configDir, resume } = fixture()
  await resume(configDir)
  expect(createSession.mock.calls[0][0]).not.toHaveProperty('resume')
})

it.each(['codex', 'dsh'])('leaves %s resumption to its adapter', async engine => {
  getActiveEngine.mockReturnValue(engine)
  const { configDir, sessionId, resume } = fixture()
  await resume(configDir)
  expect(createSession.mock.calls[0][0].resume).toBe(sessionId)
})
