/**
 * The consolidating agent's rounds are each complete on their own: the Halo
 * engine's one-shot query keeps no transcript, so a "resumed" round would start
 * with no memory of the task. Every follow-up carries the task again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  query: (...args: unknown[]) => query(...args),
  tool: vi.fn(() => ({})),
  createSdkMcpServer: vi.fn(() => ({})),
  getEngineCapabilities: vi.fn(() => ({ features: { hooks: true } })),
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  buildInternalTaskSdkOptions: vi.fn(async () => ({ includePartialMessages: true })),
}))
vi.mock('../../../../src/main/services/agent', () => ({
  addSdkHooks: (o: Record<string, any>, h: Record<string, unknown[]>) => { o.hooks = { ...(o.hooks ?? {}), ...h } },
}))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: () => '/electron',
}))

import { createConsolidationAgent, confineToWorkspace } from '../../../../src/main/services/memory-consolidation/runner'

function* script(): Generator<unknown> {
  yield { type: 'assistant', session_id: 'sess-1' }
  yield { type: 'result', subtype: 'success', result: 'done', session_id: 'sess-1' }
}

describe('consolidation agent rounds', () => {
  beforeEach(() => {
    query.mockReset()
    query.mockImplementation(() => (async function* () { yield* script() })())
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
