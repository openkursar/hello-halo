import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const { createSession, getActiveEngine, paths, readSessionToolContextMode, publishToolsetContextMode } = vi.hoisted(() => ({
  readSessionToolContextMode: vi.fn(), publishToolsetContextMode: vi.fn(),
  createSession: vi.fn(),
  getActiveEngine: vi.fn(() => 'halo'),
  paths: { userData: '', home: '' },
}))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => paths.userData), getVersion: vi.fn(() => '0.0.0'), getAppPath: vi.fn(() => '/tmp/halo-resume-app'), isPackaged: false } }))
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = () => paths.home || globalThis.__HALO_TEST_DIR__ || '/tmp/halo-resume-config-placeholder'
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession: async (options: any, prepare?: (scope: any) => Promise<any>) => createSession(prepare ? await prepare({ signal: options.abortController.signal, readSessionToolContextMode }) : options),
  getActiveEngine,
}))
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
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({ publishToolsetContextMode, setSessionInvalidator: vi.fn(), buildCreationTimeServers: vi.fn(() => ({})) }))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: vi.fn(() => '') }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({ dropConversationState: vi.fn(), getOpenToolsets: vi.fn(() => []) }))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_TOOLSET_ID: 'halo-api-ref' }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation: vi.fn(() => null) }))
vi.mock('../../../../src/main/services/health', () => ({ registerProcess: vi.fn(), unregisterProcess: vi.fn(), getCurrentInstanceId: vi.fn(() => null) }))

import { acquireV2Session, getOrCreateV2Session, closeAllV2Sessions, markTurnInitReceived, stopSessionCleanup } from '../../../../src/main/services/agent/session-manager'
import { NativeSessionResumeError } from '../../../../src/shared/types/engine-session'
import { stopGeneration } from '../../../../src/main/services/agent/control'

const directories: string[] = []
beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'halo-resume-config-'))
  directories.push(directory)
  paths.userData = join(directory, 'app-data')
  paths.home = join(directory, 'home')
  getActiveEngine.mockReturnValue('halo')
  readSessionToolContextMode.mockReset()
  publishToolsetContextMode.mockReset()
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

it('cancels catalog preparation when the person stops before a native session exists', async () => {
  const { registerAppBridge } = await import('../../../../src/main/services/app-bridge')
  const { prepareSessionSkills } = await import('../../../../src/main/services/agent/skill-availability')
  registerAppBridge({ getAppManager: () => null, createHaloAppsMcpServer: () => null, onMcpAppsChange: () => () => {} })
  const native = { close: vi.fn(), query: { transport: { isReady: () => true, onExit: () => () => {} } } }
  let signal!: AbortSignal
  let started!: () => void
  const preparing = new Promise<void>(resolve => { started = resolve })
  createSession.mockImplementationOnce(async options => {
    signal = options.abortController.signal
    started()
    await prepareSessionSkills({ ...options, workerGroup: 'space' })
    return native
  })
  const conversationId = randomUUID()
  const pending = getOrCreateV2Session('space', conversationId, { engineId: 'halo', model: 'test', systemPrompt: 'test' })
  const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await preparing
  await stopGeneration(conversationId, { reason: 'user' })
  await stopped
  expect(signal.aborted).toBe(true)
  expect(native.close).not.toHaveBeenCalled()

  const next = await getOrCreateV2Session('space', conversationId, { engineId: 'halo', model: 'test', systemPrompt: 'test' })
  expect(next).toBeDefined()
  const nextSignal = createSession.mock.calls.at(-1)![0].abortController.signal
  await stopGeneration(conversationId, { reason: 'user' })
  expect(nextSignal.aborted).toBe(false)
})

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

it('refuses to start empty when no transcript exists', async () => {
  const { configDir, resume } = fixture()
  await expect(resume(configDir)).rejects.toBeInstanceOf(NativeSessionResumeError)
  expect(createSession).not.toHaveBeenCalled()
})

it('leaves Codex resumption to its adapter', async () => {
  getActiveEngine.mockReturnValue('codex')
  const { configDir, sessionId, resume } = fixture()
  await resume(configDir)
  expect(createSession.mock.calls[0][0].resume).toBe(sessionId)
})

it('refuses a cold Dsh id without a recorded-context recovery source', async () => {
  getActiveEngine.mockReturnValue('dsh')
  const { configDir, resume } = fixture()
  await expect(resume(configDir)).rejects.toBeInstanceOf(NativeSessionResumeError)
  expect(createSession).not.toHaveBeenCalled()
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

  it('refuses a legacy continuation when both history sources are unavailable', async () => {
    const { configDir, sessionId } = fixture()
    await expect(lease({ root: configDir, sessionId, workDir: join(directories[0], 'workspace'), recover: () => { throw new Error('no record') } })).rejects.toThrow('no record')
    expect(createSession).not.toHaveBeenCalled()
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

  it('preserves the original file when strict restore fails without fallback history', async () => {
    const { configDir, sessionId, transcript, save } = fixture()
    save(configDir)
    const original = readFileSync(transcript(configDir), 'utf8')
    createSession.mockRejectedValueOnce(new NativeSessionResumeError('halo', sessionId)).mockResolvedValue(session())
    await expect(lease({ root: configDir, sessionId, workDir: join(directories[0], 'workspace'), recover: () => '' })).rejects.toBeInstanceOf(NativeSessionResumeError)
    expect(createSession).toHaveBeenCalledOnce()
    expect(readFileSync(transcript(configDir), 'utf8')).toBe(original)
    expect(publishToolsetContextMode).not.toHaveBeenCalled()
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


describe('toolset preparation after native history resolution', () => {
  it('migrates history before preparing automatic tools without inspecting the native format', async () => {
    const { configDir, sessionId, transcript, save } = fixture()
    const source = join(paths.home, '.claude')
    save(source)
    const original = readFileSync(transcript(source), 'utf8')
    const servers = vi.fn((mode: string | undefined) => {
      expect(readFileSync(transcript(configDir), 'utf8')).toBe(original)
      return { [mode!]: { command: 'fixture' } }
    })
    const instructions = vi.fn((mode: string) => `\n\nGuide: ${mode}`)
    const conversationId = randomUUID()
    const options = { engineId: 'halo', model: 'test', systemPrompt: 'Base', env: { CLAUDE_CONFIG_DIR: configDir } }
    const first = await getOrCreateV2Session('space', conversationId, options, sessionId, join(directories[0], 'workspace'), undefined, undefined, servers, undefined, { toolsetInstructions: instructions })
    expect(servers).toHaveBeenCalledWith('automatic')
    expect(instructions).toHaveBeenCalledWith('automatic')
    expect(createSession.mock.calls[0][0]).toMatchObject({
      resume: sessionId, strictResume: true,
      mcpServers: { automatic: { command: 'fixture' } },
      systemPrompt: 'Base\n\nGuide: automatic',
    })
    expect(servers.mock.invocationCallOrder[0]).toBeLessThan(createSession.mock.invocationCallOrder[0])
    expect(publishToolsetContextMode).toHaveBeenCalledWith('space', conversationId, 'automatic')
    expect(publishToolsetContextMode.mock.invocationCallOrder[0]).toBeGreaterThan(createSession.mock.invocationCallOrder[0])
    const reused = await getOrCreateV2Session('space', conversationId, options, sessionId, join(directories[0], 'workspace'), undefined, undefined, servers, undefined, { toolsetInstructions: instructions })
    expect(reused).toBe(first)
    expect(readSessionToolContextMode).not.toHaveBeenCalled()
    expect(readFileSync(transcript(source), 'utf8')).toBe(original)
    expect(servers).toHaveBeenCalledOnce()
    expect(instructions).toHaveBeenCalledOnce()
    expect(createSession).toHaveBeenCalledOnce()
    expect(publishToolsetContextMode).toHaveBeenCalledOnce()
  })

  it('rebuilds automatic tools and guides after the engine refuses native restore, preserving the record', async () => {
    const { configDir, sessionId, transcript, save } = fixture()
    save(configDir)
    const original = readFileSync(transcript(configDir), 'utf8')
    const native = { close: vi.fn(), send: vi.fn(async (_message: unknown) => {}), query: { transport: { isReady: () => true, onExit: () => () => {} } } }
    createSession.mockImplementationOnce(async () => {
      expect(publishToolsetContextMode).not.toHaveBeenCalled()
      throw new NativeSessionResumeError('halo', sessionId)
    }).mockResolvedValueOnce(native)
    const recover = vi.fn(() => 'Historical context: latest recorded turn.').mockReturnValueOnce('Historical context: kept the files.')
    const servers = vi.fn((mode: string | undefined) => ({ [mode!]: { command: 'fixture' } }))
    const instructions = vi.fn((mode: string) => `\n\nGuide: ${mode}`)
    const sink = { onTurnComplete: vi.fn(), onContinuedFromRecord: vi.fn() }
    const conversationId = randomUUID()
    const acquired = await acquireV2Session('space', conversationId, {
      engineId: 'halo', model: 'test', systemPrompt: 'Base', env: { CLAUDE_CONFIG_DIR: configDir },
    }, sessionId, join(directories[0], 'workspace'), { sink } as never, undefined, servers, undefined, {
      toolsetInstructions: instructions,
      recoverNativeSession: recover,
    })
    expect(createSession).toHaveBeenCalledTimes(2)
    const [restore, fallback] = createSession.mock.calls.map(([options]) => options)
    expect(restore).toMatchObject({ resume: sessionId, strictResume: true })
    expect(fallback).toMatchObject({
      engineHandoffRecovered: true, engineHandoffContent: 'Historical context: kept the files.',
      resume: undefined, strictResume: undefined,
    })
    expect(servers.mock.calls).toEqual([['automatic'], ['automatic']])
    expect(instructions.mock.calls).toEqual([['automatic'], ['automatic']])
    for (const options of [restore, fallback]) {
      expect(options.mcpServers).toEqual({ automatic: { command: 'fixture' } })
      expect(options.systemPrompt).toBe('Base\n\nGuide: automatic')
    }
    expect(fallback.mcpServers).not.toBe(restore.mcpServers)
    expect(recover).toHaveBeenCalledTimes(2)
    expect(recover.mock.invocationCallOrder[0]).toBeGreaterThan(createSession.mock.invocationCallOrder[0])
    expect(recover.mock.invocationCallOrder[1]).toBeGreaterThan(createSession.mock.invocationCallOrder[1])
    expect(readSessionToolContextMode).not.toHaveBeenCalled()
    expect(readFileSync(transcript(configDir), 'utf8')).toBe(original)
    expect(publishToolsetContextMode).toHaveBeenCalledOnce()
    expect(publishToolsetContextMode).toHaveBeenCalledWith('space', conversationId, 'automatic')
    expect(publishToolsetContextMode.mock.invocationCallOrder[0]).toBeGreaterThan(createSession.mock.invocationCallOrder[1])
    await acquired.send('Next question')
    markTurnInitReceived(conversationId)
    const next = await acquireV2Session('space', conversationId, {
      engineId: 'halo', model: 'test', systemPrompt: 'Base', env: { CLAUDE_CONFIG_DIR: configDir },
    }, sessionId, join(directories[0], 'workspace'), { sink } as never, undefined, servers, undefined, {
      toolsetInstructions: instructions, recoverNativeSession: recover,
    })
    expect(next.session).toBe(native)
    await next.send('Another question')
    markTurnInitReceived(conversationId)
    next.release()
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(publishToolsetContextMode).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalledTimes(2)
    expect(sink.onContinuedFromRecord).toHaveBeenCalledOnce()
    expect(sink.onContinuedFromRecord.mock.invocationCallOrder[0]).toBeLessThan(native.send.mock.invocationCallOrder[0])
    expect(native.send.mock.calls[0][0]).toContain('Historical context: latest recorded turn.')
    expect(native.send.mock.calls[0][0]).not.toContain('Historical context: kept the files.')
    expect(native.send.mock.calls[0][0]).toContain('Next question')
    expect(native.send.mock.calls[1][0]).toBe('Another question')
    acquired.release()
  })
})
