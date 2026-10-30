import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const { createSession, getActiveEngine, paths } = vi.hoisted(() => ({
  createSession: vi.fn(),
  getActiveEngine: vi.fn(() => 'halo'),
  paths: { userData: '', home: '' },
}))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => paths.userData), getVersion: vi.fn(() => '0.0.0'), getAppPath: vi.fn(() => '/tmp/halo-resume-app'), isPackaged: false } }))
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

import { acquireV2Session, getOrCreateV2Session, closeAllV2Sessions, stopSessionCleanup } from '../../../../src/main/services/agent/session-manager'
import { NativeSessionResumeError } from '../../../../src/shared/types/engine-session'

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

describe('continuing from the transcript when the stored record is lost', () => {
  const lease = async (options: { root: string; sessionId: string; workDir: string; recover?: () => string; engine?: string }) => {
    const sink = { onTurnComplete: vi.fn(), onContinuedFromRecord: vi.fn() }
    const acquired = await acquireV2Session('space', randomUUID(), {
      model: 'test-model', systemPrompt: 'test', env: { CLAUDE_CONFIG_DIR: options.root }, ...(options.engine ? { engineId: options.engine } : {}),
    }, options.sessionId, options.workDir, { sink } as never, undefined, undefined, undefined,
    options.recover ? { recoverNativeSession: options.recover } : undefined)
    return { acquired, sink }
  }
  const session = () => ({ close: vi.fn(), send: vi.fn(async (_message: unknown) => {}), query: { transport: { isReady: () => true, onExit: () => () => {} } } })

  it('hands a legacy chat whose record is gone its transcript and records the notice before the first input', async () => {
    const { configDir, sessionId } = fixture()
    const native = session()
    createSession.mockResolvedValue(native)
    const { acquired, sink } = await lease({ root: configDir, sessionId, workDir: join(directories[0], 'workspace'), recover: () => 'Historical context: kept the files.' })
    const options = createSession.mock.calls[0][0]
    expect(options.resume).toBeUndefined()
    expect(options).toMatchObject({ engineHandoffContent: 'Historical context: kept the files.', engineHandoffRecovered: true })
    await acquired.send('Next question')
    expect(sink.onContinuedFromRecord).toHaveBeenCalledOnce()
    expect(sink.onContinuedFromRecord.mock.invocationCallOrder[0]).toBeLessThan(native.send.mock.invocationCallOrder[0])
    expect(native.send.mock.calls[0][0]).toContain('Historical context: kept the files.')
    acquired.release()
  })

  it('still starts a legacy chat fresh when it has no transcript either', async () => {
    const { configDir, sessionId } = fixture()
    createSession.mockResolvedValue(session())
    const { acquired, sink } = await lease({ root: configDir, sessionId, workDir: join(directories[0], 'workspace'), recover: () => { throw new Error('no record') } })
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('resume')
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('engineHandoffContent')
    await acquired.send('Next question')
    expect(sink.onContinuedFromRecord).not.toHaveBeenCalled()
    acquired.release()
  })

  it('asks the halo engine for an exact restore and falls back to the transcript when it refuses', async () => {
    const { configDir, sessionId, save } = fixture()
    save(configDir)
    createSession.mockRejectedValueOnce(new NativeSessionResumeError('halo', sessionId)).mockResolvedValue(session())
    await lease({ root: configDir, sessionId, workDir: join(directories[0], 'workspace'), recover: () => 'Historical context.' })
    expect(createSession.mock.calls[0][0]).toMatchObject({ resume: sessionId, strictResume: true })
    expect(createSession.mock.calls[1][0].resume).toBeUndefined()
    expect(createSession.mock.calls[1][0]).toMatchObject({ engineHandoffContent: 'Historical context.', engineHandoffRecovered: true })
    expect(createSession.mock.calls[1][0].strictResume).toBeUndefined()
  })

  it('resumes a legacy record with what the engine can read when there is no transcript to fall back on', async () => {
    const { configDir, sessionId, save } = fixture()
    save(configDir)
    createSession.mockRejectedValueOnce(new NativeSessionResumeError('halo', sessionId)).mockResolvedValue(session())
    await lease({ root: configDir, sessionId, workDir: join(directories[0], 'workspace'), recover: () => '' })
    expect(createSession.mock.calls[1][0]).toMatchObject({ resume: sessionId })
    expect(createSession.mock.calls[1][0].strictResume).toBeUndefined()
  })

  it('does not ask other engines for a strict restore', async () => {
    getActiveEngine.mockReturnValue('anthropic')
    const { configDir, sessionId, save } = fixture()
    save(configDir)
    createSession.mockResolvedValue(session())
    await lease({ root: configDir, sessionId, workDir: join(directories[0], 'workspace'), recover: () => 'Historical context.' })
    expect(createSession.mock.calls[0][0]).toMatchObject({ resume: sessionId })
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('strictResume')
  })
})
