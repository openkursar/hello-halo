import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

describe('Claude Code skill visibility', () => {
  const ccOptions = { cwd: '/work', env: { CLAUDE_CONFIG_DIR: '/cc-user' }, settingSources: ['user', 'project'] }
  const entry = (name: string, path: string): SkillCatalogEntry => ({ name, description: name, source: { kind: 'file', path } })

  it('keeps skills Claude Code reads on its own out of the outside set', () => {
    const copies = [entry('project', '/work/.claude/skills/project/SKILL.md'), entry('command', '/work/.claude/commands/command.md'),
      entry('user', '/cc-user/skills/user/SKILL.md'), entry('different-user', '/other/.claude/skills/other/SKILL.md'),
      entry('personal', '/work/.agents/skills/personal/SKILL.md'), ...catalog]
    expect(skills.skillsOutsideClaudeRoots(copies, ccOptions).map(item => item.name)).toEqual(['different-user', 'personal', 'private-report'])
    expect(skills.skillsOutsideClaudeRoots(copies, { ...ccOptions, settingSources: [] })).toHaveLength(copies.length)
  })

  describe('with a linked view', () => {
    let root: string
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'halo-skill-view-')) })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    function ready(entries: SkillCatalogEntry[]) {
      const provider = vi.fn(() => entries)
      register(provider)
      return provider
    }
    function skill(name: string): SkillCatalogEntry {
      const dir = join(root, 'agents', 'skills', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`)
      return entry(name, join(dir, 'SKILL.md'))
    }

    it('adds one extra directory holding links to the skills Claude Code cannot find itself', () => {
      const outside = skill('report')
      ready([outside, entry('native', '/work/.claude/skills/native/SKILL.md')])
      const result = skills.withClaudeCodeSkills({ ...ccOptions, workerGroup: 'space', additionalDirectories: ['/extra'] })
      expect(result.additionalDirectories).toHaveLength(2)
      expect(result.additionalDirectories[0]).toBe('/extra')
      const linked = join(result.additionalDirectories[1], '.claude', 'skills')
      expect(readdirSync(linked)).toEqual(['report'])
      expect(realpathSync(join(linked, 'report'))).toBe(realpathSync(dirname(outside.source.path)))
    })

    it('leaves the options untouched when every skill is native, none exist, or nothing is ready', () => {
      const options = { ...ccOptions, workerGroup: 'space' }
      expect(skills.withClaudeCodeSkills(options)).toBe(options)
      ready([])
      expect(skills.withClaudeCodeSkills(options)).toBe(options)
      ready([entry('native', '/work/.claude/skills/native/SKILL.md')])
      expect(skills.withClaudeCodeSkills(options)).toBe(options)
      expect(skills.withClaudeCodeSkills(ccOptions)).toBe(ccOptions)
    })
  })
})

describe('session-owned skill notice', () => {
  it('announces the session once, right after the engine is ready', async () => {
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'catalog-unavailable')
    session.send('hello')
    const first = await collect(session.stream())
    expect(first.map(frame => frame.subtype)).toEqual(['init', 'skill_notice', undefined, undefined])
    expect(first[1]).toEqual({ type: 'system', subtype: 'skill_notice', skillNotice: 'catalog-unavailable' })
    expect((await collect(session.stream())).some(frame => frame.subtype === 'skill_notice')).toBe(false)
    expect(native.send).toHaveBeenCalledWith('hello')
  })

  it('keeps the native session unchanged when there is nothing to announce', () => {
    const native = sessionFixture()
    expect(skills.withSkillNotice(native)).toBe(native)
  })

  it('close releases a pending notice and a new session owns its own notice', async () => {
    const native = sessionFixture()
    const session = skills.withSkillNotice(native, 'catalog-unavailable')
    session.close()
    expect((await collect(session.stream())).some(frame => frame.subtype === 'skill_notice')).toBe(false)
    expect(native.close).toHaveBeenCalledOnce()
    const next = skills.withSkillNotice(sessionFixture(), 'catalog-unavailable')
    expect((await collect(next.stream()))[1].skillNotice).toBe('catalog-unavailable')
  })
})
