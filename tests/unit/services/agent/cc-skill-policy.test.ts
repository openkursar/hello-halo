import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNativeSkillPolicy } from '../../../../src/main/services/agent/cc/skill-policy'
import { CcSession } from '../../../../src/main/services/agent/cc/session'
import * as skills from '../../../../src/main/services/skills'

const directories: string[] = []
const sessions: CcSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) { session.close(); await session.flush() }
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'halo-cc-skill-policy-'))
  directories.push(cwd)
  const policy = createNativeSkillPolicy({ cwd, settingSources: ['project'] })
  const source = (file: string, fork = false) => {
    const path = join(cwd, '.claude', file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `---\ndescription: Fixture workflow\n${fork ? 'context: fork\n' : ''}---\nFixture instructions.\n`)
  }
  return { cwd, policy, source }
}

function createCatalogSession(cwd: string, commands: Array<{ name: string; aliases?: string[] }>) {
  const entry = join(cwd, 'runtime.cjs')
  writeFileSync(entry, `
const readline = require('node:readline');
const commands = ${JSON.stringify(commands)};
const write = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands, agents: ['native'] } } });
  } else if (frame.type === 'user') {
    write({ type: 'system', subtype: 'init', session_id: 'catalog-session', agents: ['native'],
      ...(commands.length ? { slash_commands: [...commands.map(command => command.name), 'spend'], skills: commands.slice(1).map(command => command.name) } : {}) });
    write({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
    write({ type: 'result', subtype: 'success', session_id: 'catalog-session', result: 'done' });
  }
});
`)
  const session = new CcSession({ cwd, settingSources: ['project'], env: process.env }, {
    command: process.execPath, argsPrefix: [entry], env: { ELECTRON_RUN_AS_NODE: '1' }, path: entry, kind: 'javascript', version: '2.1.89',
  })
  sessions.push(session)
  return session
}

describe('CC native skill policy', () => {
  it.each(['/Users/example/project review it', '/Volumes/data/project', '/tmp', '/tmp is full', '/etc/hosts', '//comment', '/'])('leaves ordinary path text %j alone', text => {
    const { policy } = fixture()
    expect(() => policy.checkInput(text)).not.toThrow()
    expect(() => policy.checkInput({ message: { content: [{ type: 'text', text }] } })).not.toThrow()
  })

  it('accepts nested command namespaces through direct input and the Skill hook', async () => {
    const { policy, source } = fixture()
    source('commands/frontend/test.md')
    expect(() => policy.checkInput('/frontend:test inspect')).not.toThrow()
    expect(await policy.hook.hooks[0]({ tool_input: { skill: 'frontend:test' } })).toEqual({})
  })

  it('checks the nested source even when an inline leaf namesake exists', async () => {
    const { policy, source } = fixture()
    source('commands/test.md')
    source('commands/frontend/test.md', true)
    expect(() => policy.checkInput('/frontend:test')).toThrow('native fork')
    expect(await policy.hook.hooks[0]({ tool_input: { skill: 'frontend:test' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it.each(['../test', '..:test', 'frontend:..:test', ':test', 'frontend::test'])('refuses unsafe skill identity %j', async skill => {
    const { policy, source } = fixture()
    source('commands/test.md')
    expect(await policy.hook.hooks[0]({ tool_input: { skill } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('does not let a root-directory name hide an installed fork skill', () => {
    const { policy, source } = fixture()
    source('skills/tmp/SKILL.md', true)
    expect(() => policy.checkInput('/tmp')).toThrow('native fork')
  })

  it('keeps unknown commands, native agents and fork skills refused', async () => {
    const { policy, source } = fixture()
    source('skills/forked/SKILL.md', true)
    source('skills/inline/SKILL.md')
    expect(() => policy.checkInput('/unknown')).toThrow('no inspectable source')
    expect(() => policy.checkInput('/agents')).toThrow('Native agent management')
    expect(() => policy.checkInput('/forked')).toThrow('native fork')
    expect(() => policy.checkInput('  /forked')).toThrow('native fork')
    expect(() => policy.checkInput('/inline')).not.toThrow()
    expect(await policy.hook.hooks[0]({ tool_input: { skill: 'forked' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('filters both catalog shapes using execution policy rather than a builtin-name blacklist', () => {
    const { policy, source } = fixture()
    source('skills/inline/SKILL.md')
    source('skills/forked/SKILL.md', true)
    source('commands/frontend/test.md')
    source('skills/tmp/SKILL.md', true)
    source('skills/model/SKILL.md', true)
    const commands = [
      { name: 'cost', aliases: ['spend'] }, { name: 'inline' }, { name: 'frontend:test' },
      ...['agents', 'forked', 'tmp', 'model', 'security-review', 'code-review', 'simplify'].map(name => ({ name })),
    ]
    policy.setCommands(commands)
    expect(policy.filterCommands(commands)).toEqual(commands.slice(0, 3))
    expect(policy.filterCommands([...commands.map(command => command.name), 'spend']))
      .toEqual(['cost', 'inline', 'frontend:test', 'spend'])
    for (const command of commands.slice(3)) expect(() => policy.checkInput(`/${command.name}`)).toThrow()
    expect(() => policy.checkInput('/spend')).not.toThrow()
    source('commands/security-review.md')
    source('skills/simplify/SKILL.md')
    expect(policy.filterCommands(['security-review', 'simplify'])).toEqual(['security-review', 'simplify'])
    expect(() => policy.checkInput('/security-review')).not.toThrow()
    expect(() => policy.checkInput('/simplify')).not.toThrow()
  })

  it('preserves only executable aliases without trusting an unknown command catalog', () => {
    const { policy, source } = fixture()
    source('skills/inline/SKILL.md')
    source('commands/shortcut.md')
    const commands = [{ name: 'inline', aliases: ['shortcut', 'uninspectable'] }, { name: 'unknown', aliases: ['untrusted'] }]
    policy.setCommands(commands)
    expect(policy.filterCommands(commands)).toEqual([{ name: 'inline', aliases: ['shortcut'] }])
    expect(commands[0].aliases).toEqual(['shortcut', 'uninspectable'])
    expect(() => policy.checkInput('/shortcut')).not.toThrow()
    expect(() => policy.checkInput('/untrusted')).toThrow('no inspectable source')
  })

  it('hides invalid and uninspectable sources with the same refusal as direct execution', () => {
    const { cwd, policy, source } = fixture()
    source('skills/broken/SKILL.md')
    writeFileSync(join(cwd, '.claude/skills/broken/SKILL.md'), '---\ncontext: [\n---\nBroken header.\n')
    mkdirSync(join(cwd, '.claude/skills/unreadable/SKILL.md'), { recursive: true })
    expect(policy.filterCommands(['broken', 'unreadable'])).toEqual([])
    expect(() => policy.checkInput('/broken')).toThrow('header cannot be verified')
    expect(() => policy.checkInput('/unreadable')).toThrow('source could not be inspected')
  })

  it('filters an unchanged catalog once and reuses the answer on later turns', () => {
    const { policy, source } = fixture()
    source('skills/inline/SKILL.md')
    source('skills/forked/SKILL.md', true)
    const metadata = vi.spyOn(skills, 'readSkillMetadata')
    const commands = ['cost', 'inline', 'forked']
    expect(policy.filterCommands(commands)).toEqual(['cost', 'inline'])
    const reads = metadata.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    expect(policy.filterCommands(commands)).toEqual(['cost', 'inline'])
    expect(metadata).toHaveBeenCalledTimes(reads)
    // A changed catalog is a new question and is re-evaluated.
    expect(policy.filterCommands([...commands, 'unknown'])).toEqual(['cost', 'inline'])
    expect(metadata.mock.calls.length).toBeGreaterThan(reads)
  })

  it('re-evaluates a cached catalog after session commands change', () => {
    const { policy } = fixture()
    expect(policy.filterCommands(['spend'])).toEqual([])
    policy.setCommands([{ name: 'cost', aliases: ['spend'] }])
    expect(policy.filterCommands(['spend'])).toEqual(['spend'])
  })

  it('does no metadata reads for ordinary messages or unrelated protocol frames', async () => {
    const { policy, cwd } = fixture()
    const metadata = vi.spyOn(skills, 'readSkillMetadata')
    const session = createCatalogSession(cwd, [])
    await session.ready()
    metadata.mockClear()
    policy.checkInput('ordinary text')
    await session.send('start')
    for await (const frame of session.stream()) expect(frame).toBeDefined()
    expect(metadata).not.toHaveBeenCalled()
  })

  it('filters warm-up supportedCommands and both init catalogs before downstream consumers see them', async () => {
    const { cwd, source } = fixture()
    source('skills/inline/SKILL.md')
    source('skills/forked/SKILL.md', true)
    source('commands/frontend/test.md')
    const commands = [
      { name: 'cost', aliases: ['spend'] }, { name: 'inline' }, { name: 'frontend:test' },
      ...['agents', 'forked', 'unknown', 'security-review', 'code-review', 'simplify'].map(name => ({ name })),
    ]
    const session = createCatalogSession(cwd, commands)
    await session.ready()
    expect(await session.query.supportedCommands()).toEqual(commands.slice(0, 3))
    expect(await session.query.initializationResult()).not.toHaveProperty('agents')
    await session.send('/spend')
    const frames = []
    for await (const frame of session.stream()) frames.push(frame)
    expect(frames[0]).toMatchObject({ slash_commands: ['cost', 'inline', 'frontend:test', 'spend'], skills: ['inline', 'frontend:test'] })
    expect(frames[0]).not.toHaveProperty('agents')
    await expect(session.send('/unknown')).rejects.toThrow('no inspectable source')
    await expect(session.send('/forked')).rejects.toThrow('native fork')
    await expect(session.send('/agents')).rejects.toThrow('Native agent management')
  })

  it('only trusts aliases of supported session commands', () => {
    const { policy } = fixture()
    policy.setCommands([{ name: 'cost', aliases: ['spend'] }, { name: 'unknown', aliases: ['shortcut'] }])
    expect(() => policy.checkInput('/cost')).not.toThrow()
    expect(() => policy.checkInput('/spend')).not.toThrow()
    expect(() => policy.checkInput('/shortcut')).toThrow('no inspectable source')
  })
})
