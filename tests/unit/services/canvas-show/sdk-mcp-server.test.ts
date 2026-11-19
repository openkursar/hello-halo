/**
 * canvas_show lets the AI bring its page, a terminal or a file in front of the
 * user — and nothing else. The restraint is the system's: a target is brought
 * forward at most once per reply, files stay inside the workspace, and the
 * result says in plain words what happened so the AI can point the user to it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, _schema: unknown, handler: unknown) => ({ name, description, handler }),
  createSdkMcpServer: (opts: Record<string, unknown>) => opts,
}))

type AgentListener = (event: { channel: string; conversationId: string; relayed?: boolean }) => void
const agentListeners = new Set<AgentListener>()
vi.mock('../../../../src/main/services/agent/events', () => ({
  onAgentEvent: (listener: AgentListener) => {
    agentListeners.add(listener)
    return { dispose: () => agentListeners.delete(listener) }
  },
}))
const emit = (channel: string, conversationId: string, relayed = false) =>
  [...agentListeners].forEach(listener => listener({ channel, conversationId, relayed }))
const turnStart = (conversationId: string, relayed = false) => emit('agent:turn-start', conversationId, relayed)

const ownPage = { viewId: 'v1', url: 'https://example.com', title: 'Example', owned: true, spaceId: 's1' }
const page = vi.fn((_conversationId: string): typeof ownPage | null => null)
vi.mock('../../../../src/main/services/ai-browser', () => ({ conversationPage: (id: string) => page(id) }))

const terminals = new Map<string, { id: string; info: { spaceId: string; title: string; state: string } }>()
const markAiTouched = vi.fn()
vi.mock('../../../../src/main/services/ai-terminal', () => ({
  peekGlobalTerminalContext: () => ({ get: (id: string) => terminals.get(id), markAiTouched }),
}))

const request = vi.fn(async (_r: Record<string, unknown>): Promise<'shown' | 'opened' | 'added' | 'unavailable' | 'absent'> => 'shown')
vi.mock('../../../../src/main/services/canvas-show/service', () => ({ requestCanvasShow: (r: Record<string, unknown>) => request(r) }))

const { createCanvasMcpServer } = await import('../../../../src/main/services/canvas-show/sdk-mcp-server')

type Tool = { name: string; description: string; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }

let root: string
let work: string
const scope = () => ({ spaceId: 's1', conversationId: 'c1', workDir: work })
const show = (args: Record<string, unknown>, who = scope()) => {
  const server = createCanvasMcpServer(who) as unknown as { tools: Tool[] }
  return server.tools[0].handler(args)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'canvas-show-')))
  work = join(root, 'work')
  mkdirSync(work)
  writeFileSync(join(work, 'report.md'), '# hi')
  writeFileSync(join(root, 'secret.md'), 'nope')
  writeFileSync(join(work, 'image.png'), 'x')
  request.mockClear().mockResolvedValue('shown')
  page.mockReset().mockReturnValue(null)
  terminals.clear()
  markAiTouched.mockClear()
  turnStart('c1')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('what the tool is', () => {
  it('is one tool that takes a page, a terminal or a file — never a bare URL — and says when to use it', () => {
    const server = createCanvasMcpServer(scope()) as unknown as { name: string; tools: Tool[] }
    expect(server.name).toBe('canvas')
    expect(server.tools.map(t => t.name)).toEqual(['canvas_show'])
    const description = server.tools[0].description
    expect(description).toMatch(/user asked to see it/)
    expect(description).toMatch(/must act there/)
    expect(description).toMatch(/result itself is something to look at/)
    expect(description).toMatch(/say in your reply why you opened it/)
    expect(description).toMatch(/plain URLs are not accepted/)
    expect(description).toMatch(/does not close, list or reorder/)
  })
})

describe('showing the AI\'s page', () => {
  it('asks every client to show the page the conversation is on', async () => {
    page.mockReturnValue({ ...ownPage, url: 'https://example.com/login', title: 'Sign in' })
    const result = await show({ target: 'page' })
    expect(page).toHaveBeenCalledWith('c1')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 's1', conversationId: 'c1', bringForward: true,
      target: { kind: 'page', viewId: 'v1', url: 'https://example.com/login', title: 'Sign in' },
    }))
    expect(result.content[0].text).toMatch(/^Shown: .*Sign in/)
  })

  it.each([{ owned: false }, { spaceId: 'elsewhere' }])('does not show a selected page outside its ownership: %j', async overrides => {
    page.mockReturnValue({ ...ownPage, ...overrides })
    expect(await show({ target: 'page' })).toMatchObject({ isError: true })
    expect(request).not.toHaveBeenCalled()
  })

  it('tells the AI to open the page first when it has none', async () => {
    const result = await show({ target: 'page' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Open it with your browser tools first/)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('showing a terminal', () => {
  it('shows a running terminal of the same workspace, and counts it as the AI\'s work', async () => {
    terminals.set('t1', { id: 't1', info: { spaceId: 's1', title: 'build', state: 'running' } })
    const result = await show({ target: 'terminal', session: 't1' })
    expect(markAiTouched).toHaveBeenCalledWith('t1')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'terminal', sessionId: 't1', title: 'build' } }))
    expect(result.content[0].text).toMatch(/^Shown: .*build/)
  })

  it.each([
    ['another workspace\'s terminal', { id: 't2', info: { spaceId: 'other', title: 'x', state: 'running' } }, /No such terminal session/],
    ['a terminal that ended', { id: 't2', info: { spaceId: 's1', title: 'x', state: 'exited' } }, /has ended/],
  ])('refuses %s', async (_name, session, message) => {
    terminals.set('t2', session)
    const result = await show({ target: 'terminal', session: 't2' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(message)
    expect(request).not.toHaveBeenCalled()
    expect(markAiTouched).not.toHaveBeenCalled()
  })

  it('needs to be told which terminal', async () => {
    expect((await show({ target: 'terminal' })).isError).toBe(true)
    expect((await show({ target: 'terminal', session: 'nope' })).isError).toBe(true)
  })
})

describe('showing a file', () => {
  it('accepts a path relative to the workspace or an absolute one inside it', async () => {
    await show({ target: 'file', path: 'report.md' })
    await show({ target: 'file', path: join(work, 'report.md') })
    expect(request.mock.calls.map(call => (call[0].target as { path: string }).path)).toEqual([join(work, 'report.md'), join(work, 'report.md')])
  })

  it('allows names starting with two dots, and resolves aliases to the same target', async () => {
    const file = join(work, '..notes.md')
    writeFileSync(file, '# Notes')
    symlinkSync(file, join(work, 'alias.md'))
    await show({ target: 'file', path: '..notes.md' })
    await show({ target: 'file', path: 'alias.md' })
    expect(request.mock.calls.map(([call]) => [call.target, call.bringForward])).toEqual([
      [{ kind: 'file', path: file }, true], [{ kind: 'file', path: file }, false],
    ])
  })

  it('refuses a file outside the workspace, however it is written', async () => {
    symlinkSync(join(root, 'secret.md'), join(work, 'link.md'))
    for (const path of [join(root, 'secret.md'), '../secret.md', 'link.md', '/etc/hosts']) {
      const result = await show({ target: 'file', path })
      expect(result.isError, path).toBe(true)
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses what is not a file, does not exist, or the canvas cannot display', async () => {
    mkdirSync(join(work, 'dir'))
    expect((await show({ target: 'file', path: 'dir' })).content[0].text).toMatch(/Not a file/)
    expect((await show({ target: 'file', path: 'missing.md' })).content[0].text).toMatch(/No such file/)
    expect((await show({ target: 'file', path: 'image.png' })).isError).toBeUndefined()
    writeFileSync(join(work, 'archive.zip'), 'x')
    expect((await show({ target: 'file', path: 'archive.zip' })).content[0].text).toMatch(/cannot display/)
    expect((await show({ target: 'file' })).isError).toBe(true)
  })
})

describe('what the AI is told', () => {
  beforeEach(() => { page.mockReturnValue(ownPage) })

  it('says shown, when it was', async () => {
    request.mockResolvedValue('shown')
    expect((await show({ target: 'page' })).content[0].text).toMatch(/^Shown: the user now sees/)
  })

  it('says added when the tab is kept but not shown', async () => {
    request.mockResolvedValue('added')
    const text = (await show({ target: 'page' })).content[0].text
    expect(text).toMatch(/^Added, not switched/)
    expect(text).toMatch(/no client confirmed it was visible/)
    expect(text).toMatch(/Tell the user where to find it/)
  })

  it('says the user is not there, and to reach them another way, when there is no screen', async () => {
    request.mockResolvedValue('absent')
    const text = (await show({ target: 'page' })).content[0].text
    expect(text).toMatch(/No Halo screen confirmed/)
    expect(text).toMatch(/Reach the user another way/)
  })
})

describe('once per reply', () => {
  beforeEach(() => { page.mockReturnValue(ownPage) })

  it('brings a target forward once, then only reports where it is', async () => {
    const first = await show({ target: 'page' })
    const second = await show({ target: 'page' })
    expect(first.content[0].text).toMatch(/^Shown/)
    expect(second.content[0].text).toMatch(/^Already brought forward earlier in this reply/)
    expect(request.mock.calls.map(call => call[0].bringForward)).toEqual([true, false])
  })

  it.each(['shown', 'opened', 'added'] as const)('shares simultaneous requests for one target (%s)', async outcome => {
    let resolve!: (result: typeof outcome) => void
    request.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const one = show({ target: 'page' })
    const two = show({ target: 'page' })
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    resolve(outcome)
    const [first, second] = await Promise.all([one, two])
    expect(first.content[0].text).toMatch(outcome === 'shown' ? /^Shown/ : outcome === 'opened' ? /^Opened/ : /^Added/)
    expect(second.content[0].text).toMatch(outcome === 'added' ? /^Added/ : /^Already/)
    await show({ target: 'page' })
    expect(request.mock.calls.map(([call]) => call.bringForward)).toEqual([true, outcome === 'added'])
  })

  it('does not let completion of the previous reply use up the new reply\'s reveal', async () => {
    let resolve!: (result: 'shown') => void
    request.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const old = show({ target: 'page' })
    await Promise.resolve()
    turnStart('c1')
    resolve('shown')
    await old
    expect((await show({ target: 'page' })).content[0].text).toMatch(/^Shown/)
    expect(request.mock.calls.map(([call]) => call.bringForward)).toEqual([true, true])
  })

  it('treats another target in the same reply as its own', async () => {
    await show({ target: 'page' })
    await show({ target: 'file', path: 'report.md' })
    expect(request.mock.calls.map(call => call[0].bringForward)).toEqual([true, true])
  })

  it('starts over with the next reply of the conversation, and not with another conversation\'s', async () => {
    await show({ target: 'page' })
    turnStart('someone-else')
    expect((await show({ target: 'page' })).content[0].text).toMatch(/^Already/)
    turnStart('c1', true)
    expect((await show({ target: 'page' })).content[0].text).toMatch(/^Already/)
    turnStart('c1')
    expect((await show({ target: 'page' })).content[0].text).toMatch(/^Shown/)
  })

  it('does not count a target that was only added, so the next call may still bring it forward', async () => {
    request.mockResolvedValueOnce('added')
    await show({ target: 'page' })
    await show({ target: 'page' })
    expect(request.mock.calls.map(call => call[0].bringForward)).toEqual([true, true])
  })

  it('keeps its record per conversation', async () => {
    await show({ target: 'page' })
    await show({ target: 'page' }, { ...scope(), conversationId: 'c2' })
    expect(request.mock.calls.map(call => call[0].bringForward)).toEqual([true, true])
  })

  it('forgets a reply that ended, so a conversation that never speaks again leaves nothing behind', async () => {
    await show({ target: 'page' })
    emit('agent:complete', 'c1')
    expect((await show({ target: 'page' })).content[0].text).toMatch(/^Shown/)
    emit('agent:error', 'c1')
    expect((await show({ target: 'page' })).content[0].text).toMatch(/^Shown/)
  })

  it('listens only while some reply holds a record', async () => {
    emit('agent:complete', 'c2')
    emit('agent:complete', 'c1')
    expect(agentListeners.size).toBe(0)
    await show({ target: 'page' })
    expect(agentListeners.size).toBe(1)
    emit('agent:complete', 'c1')
    expect(agentListeners.size).toBe(0)
  })
})
