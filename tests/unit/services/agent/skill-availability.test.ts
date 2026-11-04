import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillCatalogEntry } from '../../../../src/shared/types/skills'

let bridge: typeof import('../../../../src/main/services/app-bridge')
let skills: typeof import('../../../../src/main/services/agent/skill-availability')
const catalog: SkillCatalogEntry[] = [{ name: 'private-report', description: 'Private', source: { kind: 'file', path: '/private/skills/report/SKILL.md' } }]

function register(provider?: () => SkillCatalogEntry[]) {
  bridge.registerAppBridge({ getAppManager: () => null, createHaloAppsMcpServer: () => null, onMcpAppsChange: () => () => {}, getEffectiveSkillCatalog: provider })
}
async function collect(stream: AsyncIterable<any>) {
  const frames: any[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}
function sessionFixture() {
  return {
    send: vi.fn(), sendIntoLiveTurn: vi.fn((_message: unknown) => true), close: vi.fn(),
    async *stream() { yield { type: 'system', subtype: 'init' }; yield { type: 'assistant', message: { content: 'Reply' } }; yield { type: 'result' } },
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  bridge = await import('../../../../src/main/services/app-bridge')
  skills = await import('../../../../src/main/services/agent/skill-availability')
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('creation-time skill availability', () => {
  it('reads an already ready catalog once with no timer or extra scan', async () => {
    const provider = vi.fn(() => catalog)
    register(provider)
    expect(await skills.prepareSessionSkills({ workerGroup: 'space', cwd: '/work' })).toEqual({ catalog })
    expect(provider).toHaveBeenCalledOnce()
    expect(provider).toHaveBeenCalledWith('space', '/work')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses late registration before the ten-second deadline without polling', async () => {
    const provider = vi.fn(() => catalog)
    const waiting = skills.prepareSessionSkills({ workerGroup: 'space' })
    await vi.advanceTimersByTimeAsync(9000)
    expect(vi.getTimerCount()).toBe(1)
    register(provider)
    expect(await waiting).toEqual({ catalog })
    expect(provider).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the catalog rather than registration of an unrelated bridge', async () => {
    const waiting = skills.prepareSessionSkills({ workerGroup: 'space' })
    register()
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.getTimerCount()).toBe(1)
    register(() => [])
    expect(await waiting).toEqual({ catalog: [] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out at ten seconds with an explicit empty catalog and one generic warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const waiting = skills.prepareSessionSkills({ workerGroup: 'space', skillCatalog: catalog })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await waiting).toEqual({ catalog: [], notice: 'catalog-unavailable' })
    expect(warn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    const late = vi.fn(() => catalog)
    register(late)
    expect(late).not.toHaveBeenCalled()
  })

  it('cancels a waiter and releases its timer without scanning after late registration', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const waiting = skills.prepareSessionSkills({ workerGroup: 'space', abortController: controller })
    const failure = expect(waiting).rejects.toThrow('stop preparing')
    controller.abort(new Error('stop preparing'))
    await failure
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    const late = vi.fn(() => catalog)
    register(late)
    expect(late).not.toHaveBeenCalled()
  })

  it('rejects an already cancelled preparation before reading a ready catalog', async () => {
    const provider = vi.fn(() => catalog)
    register(provider)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(skills.prepareSessionSkills({ workerGroup: 'space', abortController: controller })).rejects.toThrow('cancelled')
    expect(provider).not.toHaveBeenCalled()
  })

  it('degrades a failed catalog read without rereading it or reopening autonomous discovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = vi.fn(() => { throw new Error('read failed') })
    register(provider)
    const prepared = await skills.prepareSessionSkills({ workerGroup: 'space', skillCatalog: catalog })
    expect(prepared).toEqual({ catalog: [], notice: 'catalog-unavailable' })
    expect(provider).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps unscoped helpers silent and explicitly empty before bootstrap', async () => {
    expect(await skills.prepareSessionSkills({ skillCatalog: catalog })).toEqual({ catalog: [] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads only an already registered catalog for optional engines without waiting or subscribing', () => {
    expect(skills.readReadySessionSkills({ workerGroup: 'space' })).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    const provider = vi.fn(() => catalog)
    register(provider)
    expect(provider).not.toHaveBeenCalled()
    expect(skills.readReadySessionSkills({ workerGroup: 'space', cwd: '/work' })).toEqual(catalog)
    expect(provider).toHaveBeenCalledOnce()
    expect(provider).toHaveBeenCalledWith('space', '/work')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('omits optional-engine compatibility information after a failed read, without a catalog-unavailable notice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    register(() => { throw new Error('temporary IO failure') })
    expect(skills.readReadySessionSkills({ workerGroup: 'space' })).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('session-owned skill notices', () => {
  const ccOptions = { cwd: '/work', env: { CLAUDE_CONFIG_DIR: '/cc-user' }, settingSources: ['user', 'project'] }
  const entry = (name: string, path: string): SkillCatalogEntry => ({ name, description: name, source: { kind: 'file', path } })

  it('keeps native CC project and configured user skills out of the unsupported names', () => {
    const copies = [entry('project', '/work/.claude/skills/project/SKILL.md'), entry('command', '/work/.claude/commands/command.md'),
      entry('user', '/cc-user/skills/user/SKILL.md'), entry('different-user', '/other/.claude/skills/other/SKILL.md'),
      entry('personal', '/work/.agents/skills/personal/SKILL.md'), ...catalog]
    expect([...skills.unsupportedSkillNames(copies, ccOptions, 'anthropic')]).toEqual(['different-user', 'personal', 'private-report'])
    expect([...skills.unsupportedSkillNames(copies, { ...ccOptions, settingSources: [] }, 'anthropic')]).toHaveLength(copies.length)
  })

  it('recognizes Codex default same-scope SKILL.md roots without claiming support for private files or loose commands', () => {
    const copies = [entry('repo', '/work/.agents/skills/repo/SKILL.md'), entry('user', '/user/.agents/skills/user/SKILL.md'),
      entry('command', '/work/.agents/commands/command.md'), entry('loose', '/work/.agents/skills/loose.md'), ...catalog]
    expect([...skills.unsupportedSkillNames(copies, { cwd: '/work', env: { HOME: '/user' } }, 'codex')]).toEqual(['command', 'loose', 'private-report'])
  })

  it('announces the session once and gives feedback on every explicit unsupported command', async () => {
    const provider = vi.fn(() => catalog)
    register(provider)
    const prepared = await skills.prepareSessionSkills({ workerGroup: 'space' })
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'engine-unsupported', skills.unsupportedSkillNames(prepared.catalog, ccOptions, 'anthropic'))
    session.send('hello')
    const first = await collect(session.stream())
    expect(first.map(frame => frame.subtype)).toEqual(['init', 'skill_notice', undefined, undefined])
    expect(first[1]).toEqual({ type: 'system', subtype: 'skill_notice', skillNotice: 'engine-unsupported' })
    session.send('/private-report follow up')
    expect((await collect(session.stream())).filter(frame => frame.subtype === 'skill_notice')).toEqual([{ type: 'system', subtype: 'skill_notice', skillNotice: 'skill-unsupported' }])
    session.send('ordinary follow up')
    expect((await collect(session.stream())).some(frame => frame.subtype === 'skill_notice')).toBe(false)
    session.send('/private-report again')
    expect((await collect(session.stream())).filter(frame => frame.subtype === 'skill_notice')).toEqual([{ type: 'system', subtype: 'skill_notice', skillNotice: 'skill-unsupported' }])
    expect(provider).toHaveBeenCalledOnce()
    expect(native.send.mock.calls).toEqual([['hello'], ['/private-report follow up'], ['ordinary follow up'], ['/private-report again']])
    expect(JSON.stringify(first)).not.toMatch(/private-report|\/private\/|Private/)
  })

  it.each(['/PRIVATE-REPORT draft', { message: { content: [{ type: 'text', text: '/private-report draft' }] } }])('recognizes a direct slash from captured names without changing input', async message => {
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'engine-unsupported', new Set(['private-report']))
    session.send(message)
    expect((await collect(session.stream()))[1].skillNotice).toBe('skill-unsupported')
    expect(native.send).toHaveBeenCalledWith(message)
  })

  it('does not label a supported CC slash unavailable when another library skill is missing', async () => {
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'engine-unsupported', new Set(['private-report']))
    session.send('/native-cc-command')
    expect((await collect(session.stream()))[1].skillNotice).toBe('engine-unsupported')
  })

  it('emits repeated command feedback when the native session initializes only once', async () => {
    let turn = 0
    const native = { ...sessionFixture(), async *stream() {
      if (turn++ === 0) yield { type: 'system', subtype: 'init' }
      yield { type: 'assistant', message: { content: 'reply' } }
      yield { type: 'result' }
    } }
    const session = skills.withSkillNotice(native, 'engine-unsupported', new Set(['private-report']))
    session.send('hello')
    expect((await collect(session.stream()))[1].skillNotice).toBe('engine-unsupported')
    session.send('/private-report')
    const output = await collect(session.stream())
    expect(output[0]).toEqual({ type: 'system', subtype: 'skill_notice', skillNotice: 'skill-unsupported' })
    expect(output[1].message.content).toBe('reply')
  })

  it('reports each accepted live command and does not report refused or failed sends', async () => {
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'engine-unsupported', new Set(['private-report']))
    session.send('hello')
    await collect(session.stream())
    native.sendIntoLiveTurn.mockReturnValueOnce(false)
    expect(session.sendIntoLiveTurn('/private-report')).toBe(false)
    expect((await collect(session.stream())).some(frame => frame.subtype === 'skill_notice')).toBe(false)
    session.sendIntoLiveTurn('/private-report one')
    session.sendIntoLiveTurn('/private-report two')
    expect((await collect(session.stream())).filter(frame => frame.subtype === 'skill_notice')).toHaveLength(2)
    native.send.mockRejectedValueOnce(new Error('closed'))
    await expect(session.send('/private-report')).rejects.toThrow('closed')
    expect((await collect(session.stream())).some(frame => frame.subtype === 'skill_notice')).toBe(false)
    native.send.mockResolvedValueOnce(undefined)
    await session.send('/private-report')
    expect((await collect(session.stream())).filter(frame => frame.subtype === 'skill_notice')).toHaveLength(1)
  })

  it('does not treat a path or a longer command as the captured unsupported skill', async () => {
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'engine-unsupported', new Set(['private-report']))
    session.send('hello')
    await collect(session.stream())
    for (const text of ['/private-report/file.md', '/private-reports', 'Please /private-report now']) {
      session.send(text)
      expect((await collect(session.stream())).some(frame => frame.subtype === 'skill_notice')).toBe(false)
    }
  })

  it('keeps the native session unchanged when all skills are supported', () => {
    const native = sessionFixture()
    expect(skills.withSkillNotice(native)).toBe(native)
  })

  it('close releases pending notice state and a new session owns its own notice', async () => {
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'catalog-unavailable')
    session.close()
    expect((await collect(session.stream())).some(frame => frame.subtype === 'skill_notice')).toBe(false)
    expect(native.close).toHaveBeenCalledOnce()
    const next = skills.withSkillNotice(sessionFixture(), 'catalog-unavailable')
    expect((await collect(next.stream()))[1].skillNotice).toBe('catalog-unavailable')
  })
})
