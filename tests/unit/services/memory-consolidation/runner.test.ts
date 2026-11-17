/**
 * The consolidating agent's rounds are each complete on their own: the Halo
 * engine's one-shot query keeps no transcript, so a "resumed" round would start
 * with no memory of the task. Every follow-up carries the task again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../../../../src/main/platform/memory', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  moveWithinWorkspace: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent', () => ({
  query: (...args: unknown[]) => query(...args),
  tool: vi.fn(() => ({})),
  createSdkMcpServer: vi.fn(() => ({})),
  getEngineCapabilities: vi.fn((engineId) => ({ features: { hooks: engineId !== 'codex' } })),
  buildInternalTaskSdkOptions: vi.fn(async (params) => ({ includePartialMessages: true, engineId: params.engineId ?? 'halo' })),
  addSdkHooks: (o: Record<string, any>, h: Record<string, unknown[]>) => { o.hooks = { ...(o.hooks ?? {}), ...h } },
  getHeadlessElectronPath: () => '/electron',
}))

import { createConsolidationAgent, confineToWorkspace } from '../../../../src/main/services/memory-consolidation/runner'
import { CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationMessage } from '../../../../src/main/services/memory-consolidation/prompt'
import { MEMORY_FILE_FORMAT, TOPIC_FILE_FORMAT, moveWithinWorkspace } from '../../../../src/main/platform/memory'
import { buildInternalTaskSdkOptions, tool } from '../../../../src/main/services/agent'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const cancellableInput = (signal: AbortSignal) => ({
  ws: { dir: '/ws' } as never, credentials: {} as never, spaceId: 's', ownerName: 'Ada',
  ownerKind: 'space' as const, memoryBytes: 1, nowBytes: 1, topicCount: 0, tag: 't', signal,
})

function* script(): Generator<unknown> {
  yield { type: 'assistant', session_id: 'sess-1' }
  yield { type: 'result', subtype: 'success', result: 'done', session_id: 'sess-1' }
}

describe('consolidation instructions', () => {
  it('shares the writers’ format while preserving conservation and private-workspace rules', () => {
    expect(CONSOLIDATION_SYSTEM_PROMPT).toMatchSnapshot()
    expect(CONSOLIDATION_SYSTEM_PROMPT).not.toMatch(/date \+%|Your History author tag|pre-inserted this run/)
    expect(CONSOLIDATION_SYSTEM_PROMPT).toContain(MEMORY_FILE_FORMAT)
    expect(CONSOLIDATION_SYSTEM_PROMPT).toContain(TOPIC_FILE_FORMAT)
    expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('private copy')
    expect(CONSOLIDATION_SYSTEM_PROMPT).not.toContain('memory_status')
    for (const ownerKind of ['space', 'digital-human'] as const) {
      const task = buildConsolidationMessage({ ownerKind, ownerName: 'Ada', memoryBytes: 1, nowBytes: 1, topicCount: 0 })
      expect(task).toMatchSnapshot(ownerKind)
      expect(task).toContain('nothing of value is lost')
      expect(task).toContain('tags verbatim')
      expect(task).toContain('never invent one')
      expect(task).toContain('Never delete knowledge')
      expect(task).toContain('`memory_move`')
    }
  })
})

describe('consolidation agent rounds', () => {
  beforeEach(() => {
    query.mockReset()
    query.mockImplementation(() => (async function* () { yield* script() })())
  })

  it('runs concurrent consolidations with each captured engine and its own hook support', async () => {
    const input = {
      ws: { dir: '/ws' } as never, spaceId: 's', ownerName: 'Ada',
      ownerKind: 'space' as const, memoryBytes: 1, nowBytes: 1, topicCount: 0, tag: 't',
    }
    const halo = createConsolidationAgent({ ...input, credentials: { engineId: 'halo' } as never })
    const codex = createConsolidationAgent({ ...input, credentials: { engineId: 'codex' } as never })
    await Promise.all([halo.start(), codex.start()])
    const options = query.mock.calls.map(([params]) => params.options)
    expect(options.find(item => item.engineId === 'halo')).toHaveProperty('hooks.PreToolUse')
    expect(options.find(item => item.engineId === 'codex')).not.toHaveProperty('hooks')
    await codex.followUp(['Preserve the remaining facts.'])
    expect(query.mock.calls[2][0].options.engineId).toBe('codex')
  })

  it('a follow-up is a fresh query that carries the task and the feedback', async () => {
    const agent = createConsolidationAgent({
      ws: { dir: '/ws' } as never,
      credentials: {} as never,
      spaceId: 's',
      ownerName: 'Ada',
      ownerKind: 'digital-human',
      memoryBytes: 120_000,
      nowBytes: 9000,
      topicCount: 3,
      tag: 't',
    })
    expect(await agent.start()).toEqual({ ok: true, summary: 'done', turns: 1, exhausted: false })
    expect(await agent.followUp(['Merge .incoming/topics/x.md.', 'Topic "a.md" has no description.'])).toMatchObject({ ok: true })

    const [first, second] = query.mock.calls.map(c => c[0] as { prompt: string; options: Record<string, unknown> })
    expect(second.options.resume).toBeUndefined()
    expect(second.prompt).toContain('continue from them')
    expect(second.prompt).toContain('the digital human "Ada"')
    expect(second.prompt).toContain('Merge .incoming/topics/x.md.')
    expect(second.prompt).toContain('Topic "a.md" has no description.')
    expect(first.prompt).not.toContain('continuing')
  })

  it('does not start a query when cancelled before or during option preparation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(createConsolidationAgent(cancellableInput(controller.signal)).start()).rejects.toMatchObject({ name: 'AbortError' })
    expect(query).not.toHaveBeenCalled()

    const preparing = deferred<any>()
    vi.mocked(buildInternalTaskSdkOptions).mockReturnValueOnce(preparing.promise)
    const next = new AbortController()
    const round = createConsolidationAgent(cancellableInput(next.signal)).start()
    next.abort()
    preparing.resolve({ engineId: 'halo' })
    await expect(round).rejects.toMatchObject({ name: 'AbortError' })
    expect(query).not.toHaveBeenCalled()
  })

  it('propagates external abort to the active query and awaits its shutdown', async () => {
    const entered = deferred()
    const shutdown = deferred()
    let queryController: AbortController | undefined
    query.mockImplementation(({ options }) => (async function* () {
      queryController = options.abortController
      entered.resolve()
      await shutdown.promise
      yield { type: 'result', subtype: 'success', result: 'done' }
    })())
    const controller = new AbortController()
    const round = createConsolidationAgent(cancellableInput(controller.signal)).start()
    await entered.promise
    controller.abort()
    expect(queryController?.signal.aborted).toBe(true)
    let ended = false
    const result = round.catch(error => { ended = true; return error })
    await Promise.resolve()
    expect(ended).toBe(false)
    shutdown.resolve()
    expect(await result).toMatchObject({ name: 'AbortError' })
  })

  it('awaits in-flight memory_move and refuses a late move after query cancellation', async () => {
    const entered = deferred()
    const shutdown = deferred()
    const moved = deferred<string>()
    let move!: (args: { from: string; to: string }) => Promise<unknown>
    vi.mocked(moveWithinWorkspace).mockReturnValueOnce(moved.promise)
    query.mockImplementation(() => (async function* () {
      move = vi.mocked(tool).mock.calls.at(-1)![3] as typeof move
      void move({ from: 'a.md', to: 'b.md' })
      entered.resolve()
      await shutdown.promise
      yield { type: 'result', subtype: 'success' }
    })())
    const controller = new AbortController()
    const round = createConsolidationAgent(cancellableInput(controller.signal)).start()
    await entered.promise
    controller.abort()
    shutdown.resolve()
    let ended = false
    const result = round.catch(error => { ended = true; return error })
    await Promise.resolve()
    expect(ended).toBe(false)
    await expect(move({ from: 'c.md', to: 'd.md' })).resolves.toMatchObject({ isError: true })
    expect(moveWithinWorkspace).toHaveBeenCalledOnce()
    moved.resolve('moved')
    expect(await result).toMatchObject({ name: 'AbortError' })
  })

  it('keeps an ordinary round timeout distinct from external cancellation', async () => {
    vi.useFakeTimers()
    try {
      const preparing = deferred<any>()
      vi.mocked(buildInternalTaskSdkOptions).mockReturnValueOnce(preparing.promise)
      const round = createConsolidationAgent(cancellableInput(new AbortController().signal)).start()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      preparing.resolve({ engineId: 'halo' })
      expect(await round).toEqual({ ok: false, reason: 'timed out after 600s' })
      expect(query).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a round that runs out of turns says so, for the harness to decide', async () => {
    query.mockImplementation(() => (async function* () {
      yield { type: 'assistant' }
      yield { type: 'result', subtype: 'error_max_turns' }
    })())
    const agent = createConsolidationAgent({
      ws: { dir: '/ws' } as never, credentials: {} as never, spaceId: 's', ownerName: 'Ada',
      ownerKind: 'space', memoryBytes: 1, nowBytes: 1, topicCount: 0, tag: 't',
    })
    expect(await agent.start()).toMatchObject({ ok: true, exhausted: true })
  })
})

describe('workspace confinement', () => {
  const pre = (root: string) =>
    (confineToWorkspace(root, 't').PreToolUse as Array<{ matcher: string; hooks: Array<(i: unknown) => Promise<any>> }>)
  const run = async (root: string, tool: string, input: Record<string, unknown>) =>
    pre(root).find(h => h.matcher === tool)!.hooks[0]({ cwd: root, tool_name: tool, tool_input: input })

  it('path arguments are read as the engine reads them — `~` is the home folder', async () => {
    const { homedir } = await import('os')
    for (const [tool, input] of [
      ['Grep', { pattern: 'x', path: '~' }],
      ['Grep', { pattern: 'x', path: '~/.ssh' }],
      ['Glob', { pattern: '*', path: '~' }],
      ['Read', { file_path: '~/.ssh/id_rsa' }],
      ['Grep', { pattern: 'x', path: '..' }],
      ['Glob', { pattern: `${homedir()}/{a,b}/**` }],
    ] as const) {
      const out = await run('/tmp/ws-a', tool, input)
      expect(out.hookSpecificOutput?.permissionDecision, `${tool} ${JSON.stringify(input)}`).toBe('deny')
    }
    // `$HOME` is not expanded by either engine: a folder of that name inside the workspace.
    expect(await run('/tmp/ws-a', 'Grep', { pattern: 'x', path: '$HOME' })).toEqual({})
  })

  it('a Glob whose fixed part only starts like the workspace is outside it', async () => {
    const out = await run('/tmp/ws-a', 'Glob', { pattern: '/tmp/ws-a*/**' })
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(await run('/tmp/ws-a', 'Glob', { pattern: '/tmp/ws-a/topics/**' })).toEqual({})
  })
})
