import * as fs from 'fs'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppManagerService } from '../../../src/main/apps/manager'
import { createSkillLibrary } from '../../../src/main/apps/skills'
import { getConfig, resolveClaudeConfigDir, saveConfig } from '../../../src/main/foundation/config.service'
import { readSkillPackage, skillRevision } from '../../../src/main/services/skills'

const { registerHandlers } = vi.hoisted(() => ({ registerHandlers: vi.fn() }))
vi.mock('../../../src/main/ipc/rpc', () => ({ registerRawRpcHandlers: registerHandlers }))
vi.mock('../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn(() => null), AppAlreadyInstalledError: class extends Error {},
}))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => ({ agent: { configDirMode: 'custom', customConfigDir: 'fixture-custom-config' } })),
  saveConfig: vi.fn(), resolveClaudeConfigDir: vi.fn(() => 'fixture-old-config'), getHaloDir: vi.fn(),
}))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => globalThis.__HALO_TEST_DIR__,
}))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), readSync: vi.fn(actual.readSync) }
})

import { registerCliConfigHandlers } from '../../../src/main/ipc/cli-config'

const actualFs = await vi.importActual<typeof import('fs')>('fs')
type MigrationResult = {
  success: boolean
  error?: string
  data?: { results: Array<{ name: string; status: string; dest?: string; error?: string }> }
}
type ScanResult = {
  success: boolean
  error?: string
  data?: { ccSkillsDir: string; haloSkillsDir: string; skills: Array<{ name: string; ccPath: string; haloPath: string; exists: boolean }> }
}

function content(name: string, body = 'Original instructions'): string {
  return `---\nname: ${name}\ndescription: Migration fixture\ncustom-header: preserved\n---\n${body}\n`
}

function put(path: string, bytes: string | Buffer): string {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, bytes)
  return path
}

function snapshot(path: string): { files: Record<string, string>; assets: Record<string, unknown>; revision: string } {
  const { files, assets, revision } = readSkillPackage(path)
  return { files, assets, revision }
}

describe('legacy CLI skill import through the public file service', () => {
  let root: string
  let source: string
  let target: string
  let scan: () => Promise<ScanResult>
  let migrate: (actions: unknown) => Promise<MigrationResult>

  beforeEach(() => {
    root = fs.realpathSync(globalThis.__HALO_TEST_DIR__)
    globalThis.__HALO_TEST_DIR__ = root
    source = join(root, '.claude', 'skills')
    target = join(root, '.agents', 'skills')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    registerCliConfigHandlers()
    scan = registerHandlers.mock.calls.at(-1)![1].cliConfigScanSkills
    migrate = registerHandlers.mock.calls.at(-1)![1].cliConfigMigrateSkills
  })

  afterEach(() => {
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync)
    vi.mocked(fs.readSync).mockImplementation(actualFs.readSync)
    vi.restoreAllMocks()
  })

  it('keeps an absent source and an empty or skipped migration free of destination writes', async () => {
    expect(await scan()).toEqual({ success: true, data: { skills: [], ccSkillsDir: source, haloSkillsDir: target } })
    expect(await migrate([])).toEqual({ success: true, data: { results: [] } })
    put(join(source, 'selected', 'SKILL.md'), content('selected'))
    expect(await migrate([{ name: 'selected', action: 'skip' }])).toEqual({
      success: true, data: { results: [{ name: 'selected', status: 'skipped' }] },
    })
    expect(fs.existsSync(target)).toBe(false)
    expect(resolveClaudeConfigDir).not.toHaveBeenCalled()
  })

  it('scans only direct legacy directories with SKILL.md and previews the user global destination', async () => {
    put(join(source, 'selected', 'SKILL.md'), content('selected'))
    put(join(source, 'fresh', 'SKILL.md'), content('fresh'))
    put(join(source, 'not-a-skill', 'notes.md'), 'Not a skill')
    put(join(source, 'nested-container', 'nested', 'SKILL.md'), content('nested'))
    put(join(source, 'flat.md'), content('flat'))
    fs.mkdirSync(join(source, 'invalid', 'SKILL.md'), { recursive: true })
    const existing = put(join(target, 'selected', 'SKILL.md'), content('selected', 'Destination control'))
    put(join(root, '.claude', 'commands', 'command', 'SKILL.md'), content('command'))
    put(join(root, 'workspace', '.claude', 'skills', 'workspace', 'SKILL.md'), content('workspace'))
    put(join(root, '.halo', 'skills', 'private', 'SKILL.md'), content('private'))
    const before = snapshot(existing)

    const result = await scan()

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ ccSkillsDir: source, haloSkillsDir: target })
    expect(result.data!.skills.sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: 'fresh', ccPath: join(source, 'fresh'), haloPath: join(target, 'fresh'), exists: false },
      { name: 'selected', ccPath: join(source, 'selected'), haloPath: join(target, 'selected'), exists: true },
    ])
    expect(snapshot(existing)).toEqual(before)
    expect(resolveClaudeConfigDir).not.toHaveBeenCalled()
    expect(getConfig).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('reports a scan beyond the bounded root instead of returning a silently partial list', async () => {
    fs.mkdirSync(source, { recursive: true })
    for (let index = 0; index <= 2000; index++) fs.writeFileSync(join(source, `entry-${index}.txt`), '')
    expect(await scan()).toEqual({ success: false, error: 'Skill scan exceeds 2000 entries' })
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('skips without changing either copy or unrelated files', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const dest = put(join(target, 'selected', 'SKILL.md'), content('selected', 'Destination control'))
    put(join(source, 'selected', 'nested', 'source.txt'), 'Source resource')
    put(join(target, 'selected', 'nested', 'target.txt'), 'Target resource')
    const srcBefore = snapshot(src)
    const destBefore = snapshot(dest)

    expect(await migrate([{ name: 'selected', action: 'skip' }])).toEqual({
      success: true, data: { results: [{ name: 'selected', status: 'skipped' }] },
    })
    expect(snapshot(src)).toEqual(srcBefore)
    expect(snapshot(dest)).toEqual(destBefore)
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it('copies complete nested and binary resources, removes stale destination files, and leaves the source intact', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('selected', 'Incoming instructions'))
    put(join(source, 'selected', 'reference', 'nested', 'guide.md'), '参考资料\n')
    put(join(source, 'selected', 'scripts', 'run.sh'), `#!/bin/sh\ntouch '${join(root, 'executed')}'\n`)
    put(join(source, 'selected', 'assets', 'template.bin'), Buffer.from([0, 255, 128, 17]))
    const dest = put(join(target, 'selected', 'SKILL.md'), content('selected', 'Old instructions'))
    put(join(target, 'selected', 'obsolete', 'remove.txt'), 'Obsolete resource')
    const control = put(join(target, 'control', 'SKILL.md'), content('control'))
    const omitted = put(join(source, 'omitted', 'SKILL.md'), content('omitted'))
    const srcBefore = snapshot(src)
    const controlBefore = snapshot(control)
    const omittedBefore = snapshot(omitted)

    expect(await migrate([{ name: 'selected', action: 'overwrite' }])).toEqual({
      success: true, data: { results: [{ name: 'selected', status: 'migrated', dest: 'selected' }] },
    })
    expect(snapshot(dest)).toMatchObject({ files: srcBefore.files, assets: srcBefore.assets })
    expect(snapshot(src)).toEqual(srcBefore)
    expect(snapshot(control)).toEqual(controlBefore)
    expect(snapshot(omitted)).toEqual(omittedBefore)
    expect(fs.existsSync(join(target, 'selected', 'obsolete'))).toBe(false)
    expect(fs.existsSync(join(target, 'omitted'))).toBe(false)
    expect(fs.existsSync(join(root, 'executed'))).toBe(false)
    expect(resolveClaudeConfigDir).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
    expect(fs.readdirSync(target).sort()).toEqual(['control', 'selected'])
  })

  it.skipIf(process.platform === 'win32')('preserves source executable modes for new and replaced packages', async () => {
    const script = put(join(source, 'selected', 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n')
    put(join(source, 'selected', 'SKILL.md'), content('selected'))
    fs.chmodSync(script, 0o751)
    const oldScript = put(join(target, 'selected', 'scripts', 'run.sh'), 'Old script')
    put(join(target, 'selected', 'SKILL.md'), content('selected', 'Old instructions'))
    fs.chmodSync(oldScript, 0o640)

    const result = await migrate([{ name: 'selected', action: 'overwrite' }, { name: 'selected', action: 'rename' }])

    expect(result.data!.results).toEqual([
      { name: 'selected', status: 'migrated', dest: 'selected' },
      { name: 'selected', status: 'renamed', dest: 'selected-cc' },
    ])
    for (const name of ['selected', 'selected-cc']) {
      expect(fs.statSync(join(target, name, 'scripts', 'run.sh')).mode & 0o777).toBe(0o751)
    }
    expect(fs.statSync(script).mode & 0o777).toBe(0o751)
  })

  it('keeps independent legacy and copied files visible as a real same-name conflict', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
    expect((await migrate([{ name: 'selected', action: 'overwrite' }])).success).toBe(true)
    const library = createSkillLibrary({
      context: () => ({
        manager: { listSkillRecords: () => [] } as unknown as AppManagerService,
        spaceId: null, workDir: null, spaceDataPath: null, haloDir: join(root, '.halo'), legacyGlobalRoots: [],
      }),
      trash: vi.fn(), openFolder: vi.fn(),
    })

    const inventory = library.list({ spaceId: null })

    expect(inventory.groups).toHaveLength(1)
    expect(inventory.groups[0]).toMatchObject({ name: 'selected', conflict: true, effectiveId: undefined })
    expect(inventory.groups[0].copies.map(copy => copy.path).sort()).toEqual([src, join(target, 'selected', 'SKILL.md')].sort())
    expect(inventory.groups[0].copies.every(copy => copy.enabled && copy.availability === 'conflict')).toBe(true)
    expect(library.effectiveCatalog('fixture-space')).toEqual([])
    expect(fs.existsSync(src)).toBe(true)
  })

  it('renames both the folder and command, preserves resources, and does not reuse an occupied suffix', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('original-command'))
    put(join(source, 'selected', 'nested', 'ref.txt'), 'Reference')
    put(join(source, 'selected', 'nested', 'image.bin'), Buffer.from([0, 254, 9]))
    const occupied = put(join(target, 'selected-cc', 'SKILL.md'), content('occupied'))
    const srcBefore = snapshot(src)
    const occupiedBefore = snapshot(occupied)

    expect(await migrate([{ name: 'selected', action: 'rename' }])).toEqual({
      success: true, data: { results: [{ name: 'selected', status: 'renamed', dest: 'selected-cc2' }] },
    })
    const renamed = snapshot(join(target, 'selected-cc2', 'SKILL.md'))
    expect(renamed.files).toEqual({ ...srcBefore.files, 'SKILL.md': content('selected-cc2') })
    expect(renamed.assets).toEqual(srcBefore.assets)
    expect(snapshot(src)).toEqual(srcBefore)
    expect(snapshot(occupied)).toEqual(occupiedBefore)
    expect(fs.existsSync(join(target, 'selected'))).toBe(false)
  })

  it('does not reuse the source command when it already matches the first rename suffix', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('SELECTED-cc'))
    const before = snapshot(src)
    const result = await migrate([{ name: 'selected', action: 'rename' }])
    expect(result.data!.results).toEqual([{ name: 'selected', status: 'renamed', dest: 'selected-cc2' }])
    expect(fs.readFileSync(join(target, 'selected-cc2', 'SKILL.md'), 'utf8')).toBe(content('selected-cc2'))
    expect(snapshot(src)).toEqual(before)
    expect(fs.existsSync(join(target, 'selected-cc'))).toBe(false)
  })

  it('keeps a plain Markdown body unchanged when renaming uses the directory as its command', async () => {
    put(join(source, 'plain', 'SKILL.md'), '# Instructions\nNo frontmatter.\n')
    const result = await migrate([{ name: 'plain', action: 'rename' }])
    expect(result.data!.results).toEqual([{ name: 'plain', status: 'renamed', dest: 'plain-cc' }])
    expect(fs.readFileSync(join(target, 'plain-cc', 'SKILL.md'), 'utf8')).toBe('# Instructions\nNo frontmatter.\n')
  })

  it('renames BOM-prefixed instructions while preserving the original BOM and source', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), `\ufeff${content('original-command')}`)
    const before = snapshot(src)
    const result = await migrate([{ name: 'selected', action: 'rename' }])
    expect(result.data!.results).toEqual([{ name: 'selected', status: 'renamed', dest: 'selected-cc' }])
    expect(fs.readFileSync(join(target, 'selected-cc', 'SKILL.md'), 'utf8')).toBe(`\ufeff${content('selected-cc')}`)
    expect(snapshot(src)).toEqual(before)
  })

  it('does not publish a rename if the frontmatter helper cannot update its command safely', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), '---\n"name": original-command\ndescription: Fixture\n---\nInstructions\n')
    const before = snapshot(src)
    const result = await migrate([{ name: 'selected', action: 'rename' }])
    expect(result.data!.results).toEqual([{ name: 'selected', status: 'error', error: 'The skill command could not be renamed safely' }])
    expect(snapshot(src)).toEqual(before)
    expect(fs.existsSync(target)).toBe(false)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it.each([null, {}, 'selected', [null], [{ name: 42, action: 'overwrite' }], Array.from({ length: 2001 }, () => ({ name: 'selected', action: 'skip' }))])(
    'rejects malformed or over-budget action lists before writing (%#)', async actions => {
      const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
      const before = snapshot(src)
      expect(await migrate(actions)).toMatchObject({ success: false, error: expect.any(String) })
      expect(snapshot(src)).toEqual(before)
      expect(fs.existsSync(target)).toBe(false)
      expect(console.error).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['../escape', '..', '.', '/absolute', 'nested/name', 'nested\\name', 'bad\0name', 'CON', 'trailing.', ' leading', 'trailing ', 'x'.repeat(129)])(
    'rejects unsafe names in the whole batch before copying any earlier selection (%#)', async name => {
      const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
      const control = put(join(root, 'escape', 'SKILL.md'), content('escape'))
      const before = snapshot(control)
      const result = await migrate([{ name: 'selected', action: 'overwrite' }, { name, action: 'overwrite' }])
      expect(result).toMatchObject({ success: false, error: expect.any(String) })
      expect(fs.existsSync(src)).toBe(true)
      expect(snapshot(control)).toEqual(before)
      expect(fs.existsSync(target)).toBe(false)
      expect(console.error).toHaveBeenCalledTimes(1)
    },
  )

  it('does not treat an unknown or missing action as permission to overwrite', async () => {
    put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const dest = put(join(target, 'selected', 'SKILL.md'), content('selected', 'Destination control'))
    const before = snapshot(dest)
    const result = await migrate([{ name: 'selected', action: 'unexpected' }, { name: 'selected' }])
    expect(result.data!.results).toEqual([
      { name: 'selected', status: 'error', error: 'Unsupported skill import action' },
      { name: 'selected', status: 'error', error: 'Unsupported skill import action' },
    ])
    expect(snapshot(dest)).toEqual(before)
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it('reports missing or non-skill sources as skipped without creating a target', async () => {
    put(join(source, 'not-a-skill', 'notes.txt'), 'Not a skill')
    const result = await migrate([{ name: 'missing', action: 'overwrite' }, { name: 'not-a-skill', action: 'overwrite' }])
    expect(result.data!.results).toEqual([{ name: 'missing', status: 'skipped' }, { name: 'not-a-skill', status: 'skipped' }])
    expect(fs.existsSync(target)).toBe(false)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('keeps an occupied non-skill directory rather than deleting unrelated content', async () => {
    put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const unrelated = put(join(target, 'selected', 'notes.txt'), 'Do not delete')
    const result = await migrate([{ name: 'selected', action: 'overwrite' }])
    expect(result.data!.results).toEqual([{ name: 'selected', status: 'error', error: expect.stringContaining('missing SKILL.md') }])
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('Do not delete')
    expect(fs.existsSync(join(target, 'selected', 'SKILL.md'))).toBe(false)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('rejects unsafe nested source links while continuing a separate healthy selection', async () => {
    const src = put(join(source, 'unsafe', 'SKILL.md'), content('unsafe'))
    const control = put(join(root, 'private.txt'), 'Outside control')
    fs.symlinkSync(control, join(dirname(src), 'link.txt'))
    put(join(source, 'healthy', 'SKILL.md'), content('healthy'))
    const result = await migrate([{ name: 'unsafe', action: 'overwrite' }, { name: 'healthy', action: 'overwrite' }])
    expect(result.data!.results).toEqual([
      { name: 'unsafe', status: 'error', error: expect.stringContaining('Nested symbolic links') },
      { name: 'healthy', status: 'migrated', dest: 'healthy' },
    ])
    expect(fs.readFileSync(control, 'utf8')).toBe('Outside control')
    expect(fs.existsSync(join(target, 'unsafe'))).toBe(false)
    expect(fs.readFileSync(join(target, 'healthy', 'SKILL.md'), 'utf8')).toBe(content('healthy'))
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized source without creating destination content', async () => {
    const src = put(join(source, 'large', 'SKILL.md'), content('large'))
    fs.truncateSync(src, 1024 * 1024 + 1)
    const result = await migrate([{ name: 'large', action: 'overwrite' }])
    expect(result.data!.results).toEqual([{ name: 'large', status: 'error', error: expect.stringContaining('1 MiB') }])
    expect(fs.existsSync(target)).toBe(false)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('preserves an external destination edit detected after the overwrite revision was captured', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const dest = put(join(target, 'selected', 'SKILL.md'), content('selected', 'Destination control'))
    const srcBefore = snapshot(src)
    const external = content('selected', 'External edit during migration')
    vi.mocked(fs.readSync).mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      fs.writeFileSync(dest, external)
      return actualFs.readSync(...args)
    })

    const result = await migrate([{ name: 'selected', action: 'overwrite' }])

    expect(result.data!.results).toEqual([{ name: 'selected', status: 'error', error: expect.stringContaining('changed') }])
    expect(fs.readFileSync(dest, 'utf8')).toBe(external)
    expect(snapshot(src)).toEqual(srcBefore)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('does not overwrite a destination created after the initial existence check', async () => {
    put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const dest = join(target, 'selected', 'SKILL.md')
    vi.mocked(fs.readSync).mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      put(dest, content('selected', 'External new destination'))
      return actualFs.readSync(...args)
    })
    const result = await migrate([{ name: 'selected', action: 'overwrite' }])
    expect(result.data!.results).toEqual([{ name: 'selected', status: 'error', error: expect.stringContaining('already exists') }])
    expect(fs.readFileSync(dest, 'utf8')).toBe(content('selected', 'External new destination'))
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('rolls back a failed replacement, retains both packages, and logs the failure once', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const dest = put(join(target, 'selected', 'SKILL.md'), content('selected', 'Destination control'))
    put(join(target, 'selected', 'nested', 'old.txt'), 'Preserve on failure')
    const srcBefore = snapshot(src)
    const destBefore = snapshot(dest)
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith('/package') && String(to) === dirname(dest)) throw new Error('Fixture replacement failure')
      return actualFs.renameSync(from, to)
    })

    const result = await migrate([{ name: 'selected', action: 'overwrite' }])

    expect(result.data!.results).toEqual([{ name: 'selected', status: 'error', error: 'Fixture replacement failure' }])
    expect(snapshot(dest)).toMatchObject({ files: destBefore.files, assets: destBefore.assets })
    expect(snapshot(src)).toEqual(srcBefore)
    expect(fs.readdirSync(target)).toEqual(['selected'])
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('refuses a linked destination without changing the link or its target', async () => {
    put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const linked = put(join(root, 'linked', 'SKILL.md'), content('selected', 'Linked control'))
    const before = snapshot(linked)
    fs.mkdirSync(target, { recursive: true })
    fs.symlinkSync(dirname(linked), join(target, 'selected'), 'dir')

    const result = await migrate([{ name: 'selected', action: 'overwrite' }])

    expect(result.data!.results).toEqual([{ name: 'selected', status: 'error', error: expect.stringContaining('symbolic-link') }])
    expect(fs.lstatSync(join(target, 'selected')).isSymbolicLink()).toBe(true)
    expect(snapshot(linked)).toEqual(before)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('does not create renamed copies inside a destination alias of the legacy root', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const before = snapshot(src)
    fs.mkdirSync(dirname(target), { recursive: true })
    fs.symlinkSync(source, target, 'dir')
    const result = await migrate([{ name: 'selected', action: 'rename' }])
    expect(result.data!.results).toEqual([{ name: 'selected', status: 'error', error: expect.stringContaining('outside the legacy') }])
    expect(snapshot(src)).toEqual(before)
    expect(fs.readdirSync(source)).toEqual(['selected'])
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('does not replace its legacy source when the destination root aliases that source', async () => {
    const src = put(join(source, 'selected', 'SKILL.md'), content('selected'))
    const before = snapshot(src)
    fs.mkdirSync(dirname(target), { recursive: true })
    fs.symlinkSync(source, target, 'dir')
    const result = await migrate([{ name: 'selected', action: 'overwrite' }])
    expect(result.data!.results).toEqual([{ name: 'selected', status: 'skipped' }])
    expect(snapshot(src)).toEqual(before)
    expect(skillRevision(src)).toBe(before.revision)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).not.toHaveBeenCalled()
  })
})
