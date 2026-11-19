import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(), startConsumer: vi.fn(),
  hasSpace: vi.fn(() => true), credentials: vi.fn(),
  getConversation: vi.fn(() => ({ id: 'conversation', messages: [] })),
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp', getVersion: () => '0.0.0', isPackaged: false } }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn(), trackErrorSurface: vi.fn() } }))
vi.mock('../../../../src/main/services/space.service', () => ({ hasSpace: mocks.hasSpace }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ createSession: mocks.createSession, getActiveEngine: () => 'halo', getEngineCapabilities: () => ({ features: { goal: true } }) }))
vi.mock('../../../../src/main/services/agent/session-consumer', () => ({ startConsumer: mocks.startConsumer }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getWorkingDir: () => '/tmp', getHeadlessElectronPath: () => '/tmp/electron',
  getApiCredentialsForSelection: mocks.credentials,
}))
vi.mock('../../../../src/main/services/agent/engine-routing', () => ({
  resolveConversationEngine: async () => 'halo',
  prepareConversationContinuation: async () => ({}),
}))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applySessionReasoningEffort: vi.fn(), pickReasoningEffort: vi.fn() }))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({ resolveConversationKnowledgeBases: () => [], resolveConversationKnowledgeBaseIds: () => [] }))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({ setSessionInvalidator: vi.fn(), buildCreationTimeServers: () => ({}) }))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: () => '' }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({ dropConversationState: vi.fn(), getOpenToolsets: () => [] }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation: mocks.getConversation }))
vi.mock('../../../../src/main/services/health', () => ({ registerProcess: vi.fn(), unregisterProcess: vi.fn(), getCurrentInstanceId: () => null }))

import { acquireV2Session, beginSpaceMaintenance, countSpaceWorkspaceWork, closeSessionAndWait, closeAllV2Sessions, getOrCreateV2Session, stopSessionCleanup, ensureSessionWarm, v2Sessions } from '../../../../src/main/services/agent/session-manager'
import { assertSpaceOperationCurrent, runSpaceOperation, waitForSessionCleanup } from '../../../../src/main/services/agent/space-maintenance'
import { createCanUseTool, getActivePendingQuestion, rejectAllQuestions } from '../../../../src/main/services/agent/permission-handler'
import { setConversationGoal } from '../../../../src/main/services/agent/goal'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const fences: Array<ReturnType<typeof beginSpaceMaintenance>> = []
function begin(spaceId = 'space-a') {
  const fence = beginSpaceMaintenance(spaceId)
  fences.push(fence)
  return fence
}
function session() {
  return {
    close: vi.fn(), flush: vi.fn(async () => {}), send: vi.fn(),
    query: { transport: { isReady: () => true, onExit: () => () => {} } },
  }
}

beforeAll(async () => { await import('../../../../src/main/services/agent/control') })
afterEach(() => {
  for (const fence of fences.splice(0)) fence.release()
  closeAllV2Sessions()
  rejectAllQuestions()
  vi.restoreAllMocks()
  mocks.createSession.mockReset()
  mocks.credentials.mockReset()
  mocks.hasSpace.mockReturnValue(true)
})
afterAll(() => stopSessionCleanup())

describe('space maintenance admission and drain', () => {
  it('captures preparation synchronously and waits through its finally', async () => {
    const preparation = deferred()
    const cleanup = deferred()
    const write = vi.fn()
    const attempt = runSpaceOperation('space-a', 'preparing', async signal => {
      try {
        await preparation.promise
        assertSpaceOperationCurrent(signal)
        write()
      } finally { await cleanup.promise }
    })
    const refused = expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
    expect(countSpaceWorkspaceWork('space-a')).toBe(1)
    const fence = begin()
    expect(fence.activeWorkCount).toBe(1)
    let drained = false
    const draining = fence.stopAndDrain().then(() => { drained = true })
    preparation.resolve()
    await tick()
    expect(drained).toBe(false)
    cleanup.resolve()
    await Promise.all([refused, draining])
    expect(write).not.toHaveBeenCalled()
  })

  it('ordinary-only preview excludes app chats and managed runs without changing full drain coverage', async () => {
    const release = deferred()
    const ordinary = runSpaceOperation('space-a', 'conversation', async () => { await release.promise })
    const chat = runSpaceOperation('space-a', 'app-chat:app:local:direct:chat', async () => { await release.promise })
    const run = runSpaceOperation('space-a', 'app-run:app:run', async () => { await release.promise })
    expect(countSpaceWorkspaceWork('space-a')).toBe(3)
    expect(countSpaceWorkspaceWork('space-a', { ordinaryOnly: true })).toBe(1)
    const fence = begin()
    expect(fence.activeWorkCount).toBe(3)
    release.resolve()
    await Promise.all([ordinary, chat, run, fence.stopAndDrain()])
  })

  it('new acquisition waits outside the captured drain and revalidates after deletion', async () => {
    const fence = begin()
    const arriving = acquireV2Session('space-a', 'new', { engineId: 'halo' })
    const refused = expect(arriving).rejects.toThrow('workspace was deleted')
    await fence.stopAndDrain()
    expect(mocks.createSession).not.toHaveBeenCalled()
    mocks.hasSpace.mockReturnValue(false)
    fence.release()
    await refused
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('release on a rolled-back maintenance permits a fresh acquisition', async () => {
    const fence = begin()
    const native = session()
    mocks.createSession.mockResolvedValueOnce(native)
    const arriving = acquireV2Session('space-a', 'retry', { engineId: 'halo' })
    await fence.stopAndDrain()
    fence.release()
    const lease = await arriving
    expect(lease.session).toBe(native)
    lease.release()
  })

  it('a delayed native creation cannot publish or skip its persistence flush', async () => {
    const native = session()
    const creation = deferred<ReturnType<typeof session>>()
    const flush = deferred()
    native.flush.mockReturnValueOnce(flush.promise)
    mocks.createSession.mockReturnValueOnce(creation.promise)
    const attempt = acquireV2Session('space-a', 'creating', { engineId: 'halo' })
    const refused = expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    const fence = begin()
    let drained = false
    const draining = fence.stopAndDrain().then(() => { drained = true })
    creation.resolve(native)
    await tick()
    expect(v2Sessions.has('creating')).toBe(false)
    expect(native.close).toHaveBeenCalledOnce()
    expect(drained).toBe(false)
    flush.resolve()
    await Promise.all([refused, draining])
  })

  it('does not stop or flush another space', async () => {
    const native = session()
    mocks.createSession.mockResolvedValueOnce(native)
    await getOrCreateV2Session('space-b', 'other', { engineId: 'halo' })
    await begin().stopAndDrain()
    expect(native.close).not.toHaveBeenCalled()
    expect(native.flush).not.toHaveBeenCalled()
    expect(v2Sessions.get('other')?.session).toBe(native)
  })

  it('fails closed on flush failure and retries the forgotten instance on the next maintenance', async () => {
    const native = session()
    native.flush.mockRejectedValueOnce(new Error('disk failure'))
    mocks.createSession.mockResolvedValueOnce(native)
    await getOrCreateV2Session('space-a', 'flush-failure', { engineId: 'halo' })
    const first = begin()
    await expect(first.stopAndDrain()).rejects.toThrow('disk failure')
    first.release()
    await begin().stopAndDrain()
    expect(native.flush).toHaveBeenCalledTimes(2)
  })

  it('strict app-only close retries flush after the live instance was removed', async () => {
    const native = session()
    native.flush.mockRejectedValueOnce(new Error('app persistence failed'))
    mocks.createSession.mockResolvedValueOnce(native)
    await getOrCreateV2Session('space-a', 'app-close-retry', { engineId: 'halo' })
    await expect(closeSessionAndWait('app-close-retry', 'moving app')).rejects.toThrow('app persistence failed')
    expect(v2Sessions.has('app-close-retry')).toBe(false)
    await closeSessionAndWait('app-close-retry', 'retry moving app')
    expect(native.close).toHaveBeenCalledOnce()
    expect(native.flush).toHaveBeenCalledTimes(2)
  })

  it('an uncancellable preparation times out explicitly and release still admits new work', async () => {
    vi.useFakeTimers()
    const preparation = deferred()
    const attempt = runSpaceOperation('space-a', 'stuck-preparation', async () => { await preparation.promise })
    const fence = begin()
    const rejected = expect(fence.stopAndDrain()).rejects.toThrow('files were preserved')
    await vi.advanceTimersByTimeAsync(10_001)
    await rejected
    fence.release()
    mocks.createSession.mockResolvedValueOnce(session())
    const arriving = acquireV2Session('space-a', 'after-failed-maintenance', { engineId: 'halo' })
    await vi.advanceTimersByTimeAsync(0)
    const lease = await arriving
    lease.release()
    preparation.resolve()
    await attempt
    vi.useRealTimers()
  })

  it('never probes or kills the host main process', async () => {
    const native = Object.assign(session(), { pid: process.pid })
    const kill = vi.spyOn(process, 'kill')
    await waitForSessionCleanup(native as never, process.pid, 10)
    expect(kill).not.toHaveBeenCalled()
    expect(native.flush).toHaveBeenCalledOnce()
  })

  it('waits for a real owned child process to exit after persistence flush completes', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
    await once(child, 'spawn')
    const exited = once(child, 'exit')
    const native = session()
    const flush = deferred()
    native.flush.mockReturnValueOnce(flush.promise)
    let settled = false
    const waiting = waitForSessionCleanup(native as never, child.pid, 1000).then(() => { settled = true })
    try {
      flush.resolve()
      await tick()
      expect(settled).toBe(false)
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
      child.stdin.end()
      await exited
      await waiting
      expect(settled).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
      await waiting
    }
  })

  it('refuses a real still-running child process without terminating it', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
    await once(child, 'spawn')
    const exited = once(child, 'exit')
    try {
      await expect(waitForSessionCleanup(session() as never, child.pid, 5)).rejects.toThrow('still running')
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
    } finally {
      child.stdin.end()
      await exited
    }
  })

  it('reports a live PID instead of treating timeout as success', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    await expect(waitForSessionCleanup(session() as never, 987654, 1)).rejects.toThrow('still running')
  })

  it('treats permission errors probing a process as uncertainty, not proof of exit', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) })
    await expect(waitForSessionCleanup(session() as never, 987654, 1)).rejects.toThrow('not permitted')
  })

  it('warm-up delayed on credentials is captured and does not start a session after cancellation', async () => {
    const credentials = deferred<any>()
    mocks.credentials.mockReturnValueOnce(credentials.promise)
    const warming = ensureSessionWarm('space-a', 'warming')
    const refused = expect(warming).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    const fence = begin()
    expect(fence.activeWorkCount).toBe(1)
    const draining = fence.stopAndDrain()
    credentials.resolve({ provider: 'test', model: 'test' })
    await Promise.all([refused, draining])
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('new warm and goal requests wait without holding up the drain', async () => {
    const fence = begin()
    const warming = ensureSessionWarm('space-a', 'new-warm')
    const goal = setConversationGoal('space-a', 'new-goal', { objective: 'continue' })
    const warmRefused = expect(warming).rejects.toThrow('workspace was deleted')
    const goalRefused = expect(goal).rejects.toThrow('workspace was deleted')
    await fence.stopAndDrain()
    expect(mocks.credentials).not.toHaveBeenCalled()
    mocks.hasSpace.mockReturnValue(false)
    fence.release()
    await Promise.all([warmRefused, goalRefused])
  })

  it('an aborted external preparation never parks on maintenance', async () => {
    const fence = begin()
    const abort = new AbortController()
    abort.abort()
    await expect(acquireV2Session('space-a', 'aborted', {}, undefined, undefined, undefined, undefined, undefined, undefined, { maintenanceSignal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await fence.stopAndDrain()
  })

  it('rejects only this space’s pending questions', async () => {
    const questions = [{ question: 'Continue?', header: 'Choice', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }]
    const first = createCanUseTool({ spaceId: 'space-a', conversationId: 'ask-a' })('AskUserQuestion', { questions }, { signal: new AbortController().signal })
    const other = createCanUseTool({ spaceId: 'space-b', conversationId: 'ask-b' })('AskUserQuestion', { questions }, { signal: new AbortController().signal })
    await begin().stopAndDrain()
    expect((await first).behavior).toBe('deny')
    expect(getActivePendingQuestion('ask-a')).toBeNull()
    expect(getActivePendingQuestion('ask-b')).not.toBeNull()
    rejectAllQuestions()
    await other
  })
})
