import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as fs from 'fs'
import { dirname, join, win32 } from 'path'
import { execFileSync } from 'child_process'
import {
  assertSkillRevision,
  moveSkillFiles,
  insideAsar,
  readSkillPackage,
  skillRemovalPath,
  skillRevision,
  writeSkillContent,
  writeSkillPackage
} from '../../../../src/main/services/skills/files'

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    opendirSync: vi.fn(actual.opendirSync),
    lstatSync: vi.fn(actual.lstatSync),
    fstatSync: vi.fn(actual.fstatSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    rmSync: vi.fn(actual.rmSync),
    realpathSync: vi.fn(actual.realpathSync),
    readSync: vi.fn(actual.readSync)
  }
})

const actualFs = await vi.importActual<typeof import('fs')>('fs')
let root: string
let warn: MockInstance<Parameters<typeof console.warn>, ReturnType<typeof console.warn>>

function fixture(name = 'source'): string {
  const filePath = join(root, name, 'SKILL.md')
  fs.mkdirSync(dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '# Original\n')
  return filePath
}

function put(filePath: string, name: string, content: string | Buffer, mode = 0o644): string {
  const path = join(dirname(filePath), name)
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, content)
  fs.chmodSync(path, mode)
  return path
}

function ioError(code = 'EIO'): NodeJS.ErrnoException {
  return Object.assign(new Error(`Injected ${code}`), { code })
}

function forceCrossVolume(source: string, destination: string): void {
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (String(from) === source && String(to) === destination) throw ioError('EXDEV')
    actualFs.renameSync(from, to)
  })
}

function temporaryFiles(parent = root): string[] {
  return fs.readdirSync(parent).filter(name => name.startsWith('.halo-skill-'))
}

beforeEach(() => {
  root = fs.realpathSync(globalThis.__HALO_TEST_DIR__)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync)
  vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync)
  vi.mocked(fs.rmSync).mockImplementation(actualFs.rmSync)
  vi.mocked(fs.realpathSync).mockImplementation(actualFs.realpathSync)
  vi.mocked(fs.readSync).mockImplementation(actualFs.readSync)
  warn.mockRestore()
})

describe('readSkillPackage', () => {
  it('reads all nested files without executing scripts, corrupting bytes or changing modes', () => {
    const filePath = fixture()
    const script = put(filePath, 'scripts/run.sh', `#!/bin/sh\ntouch '${join(root, 'executed')}'\n`, 0o751)
    put(filePath, 'reference/nested/guide.md', '参考资料\n')
    put(filePath, 'template.bin', Buffer.from([0, 1, 128, 255]))
    put(filePath, 'invalid.txt', Buffer.from([0xc3, 0x28]))
    put(filePath, 'bom.md', Buffer.from([0xef, 0xbb, 0xbf, 65]))
    put(filePath, 'empty.txt', '')
    const before = fs.statSync(script)

    const result = readSkillPackage(filePath)

    expect(result.files['SKILL.md']).toBe('# Original\n')
    expect(result.files['reference/nested/guide.md']).toBe('参考资料\n')
    expect(result.files['bom.md']).toBe('\ufeffA')
    expect(result.files['empty.txt']).toBe('')
    expect(Buffer.from(result.assets['template.bin'].content, 'base64')).toEqual(Buffer.from([0, 1, 128, 255]))
    expect(Buffer.from(result.assets['invalid.txt'].content, 'base64')).toEqual(Buffer.from([0xc3, 0x28]))
    expect(result.entries).toContainEqual({ path: 'template.bin', size: 4, binary: true })
    expect(result.entries).toHaveLength(7)
    expect(result.modes?.['scripts/run.sh']).toBe(0o751)
    expect(result.modes?.['template.bin']).toBe(0o644)
    expect(result.modes?.['reference']).toBeUndefined()
    expect(result.revision).toBe(skillRevision(filePath))
    expect(fs.statSync(script).mode).toBe(before.mode)
    expect(fs.statSync(script).mtimeMs).toBe(before.mtimeMs)
    expect(fs.existsSync(join(root, 'executed'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads a flat Markdown file alone under the SKILL.md name', () => {
    const filePath = join(root, 'legacy.md')
    fs.writeFileSync(filePath, 'Legacy instructions')
    fs.writeFileSync(join(root, 'unrelated.txt'), 'Do not package')
    expect(readSkillPackage(filePath)).toMatchObject({
      files: { 'SKILL.md': 'Legacy instructions' },
      assets: {},
      entries: [{ path: 'SKILL.md', size: 19, binary: false }]
    })
  })

  it('rejects a nested symlink instead of reading outside the package', () => {
    const filePath = fixture()
    const external = join(root, 'external.txt')
    fs.writeFileSync(external, 'Private control')
    fs.symlinkSync(external, join(dirname(filePath), 'linked.txt'))
    expect(() => readSkillPackage(filePath)).toThrow('Nested symbolic links')
    expect(fs.readFileSync(external, 'utf8')).toBe('Private control')
    expect(fs.readSync).not.toHaveBeenCalled()
  })

  it('reads a selected root symlink but returns its selected removal path', () => {
    const filePath = fixture()
    const alias = join(root, 'alias')
    fs.symlinkSync(dirname(filePath), alias, 'dir')
    expect(readSkillPackage(join(alias, 'SKILL.md')).files['SKILL.md']).toBe('# Original\n')
    expect(skillRemovalPath(join(alias, 'SKILL.md'))).toBe(alias)
    const flat = join(root, 'alias.md')
    fs.symlinkSync(filePath, flat)
    expect(readSkillPackage(flat).files['SKILL.md']).toBe('# Original\n')
    expect(skillRemovalPath(flat)).toBe(flat)
  })

  it('rejects changed files observed while reading', () => {
    const filePath = fixture()
    vi.mocked(fs.readSync).mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      fs.writeFileSync(filePath, 'External changed instructions')
      return actualFs.readSync(...args)
    })
    expect(() => readSkillPackage(filePath)).toThrow('changed')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('External changed instructions')
  })

  it('classifies invalid main bytes as an asset instead of silently replacing characters', () => {
    const filePath = fixture()
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xfe, 0x41]))
    const pkg = readSkillPackage(filePath)
    expect(pkg.files['SKILL.md']).toBeUndefined()
    expect(Buffer.from(pkg.assets['SKILL.md'].content, 'base64')).toEqual(Buffer.from([0xff, 0xfe, 0x41]))
  })

  it.skipIf(process.platform === 'win32')('rejects a FIFO without opening or blocking on it', () => {
    const filePath = fixture()
    execFileSync('mkfifo', [join(dirname(filePath), 'pipe')])
    expect(() => readSkillPackage(filePath)).toThrow('non-regular file')
    expect(fs.readSync).not.toHaveBeenCalled()
  })

  it('caps main content before reading it', () => {
    const filePath = fixture()
    fs.truncateSync(filePath, 1024 * 1024 + 1)
    expect(() => readSkillPackage(filePath)).toThrow('SKILL.md exceeds 1 MiB')
    expect(fs.readSync).not.toHaveBeenCalled()
  })

  it('caps aggregate resources before reading them', () => {
    const filePath = fixture()
    const resource = put(filePath, 'large.bin', '')
    fs.truncateSync(resource, 32 * 1024 * 1024)
    expect(() => readSkillPackage(filePath)).toThrow('32 MiB')
    expect(fs.readSync).not.toHaveBeenCalled()
  })

  it('caps the tree including directories at 2000 entries', () => {
    const filePath = fixture()
    for (let index = 0; index < 2000; index++) put(filePath, `file-${index}.txt`, '')
    expect(() => skillRevision(filePath)).toThrow('2000 entries')
    expect(fs.readSync).not.toHaveBeenCalled()
  })
})

describe('ancestor directory aliases', () => {
  it.each(['workspace', 'compatibility'])('creates, edits, replaces and moves through a stable %s alias', kind => {
    const original = fixture('project/.agents/skills/example')
    const project = join(root, 'project')
    const alias = kind === 'workspace' ? join(root, 'workspace-alias') : join(project, '.claude')
    fs.symlinkSync(kind === 'workspace' ? project : '.agents', alias, 'dir')
    const skills = kind === 'workspace' ? join(alias, '.agents', 'skills') : join(alias, 'skills')
    const selected = join(skills, 'example', 'SKILL.md')
    writeSkillContent(selected, 'Edited', skillRevision(selected))
    expect(fs.readFileSync(original, 'utf8')).toBe('Edited')
    writeSkillPackage(selected, { 'SKILL.md': 'Replaced', 'run.sh': 'echo safe' }, undefined, skillRevision(selected))
    writeSkillPackage(join(skills, 'created', 'SKILL.md'), { 'SKILL.md': 'Created' })
    const moved = join(skills, 'new-parent', 'moved', 'SKILL.md')
    moveSkillFiles(selected, moved, skillRevision(selected))
    expect(readSkillPackage(moved).files).toEqual({ 'SKILL.md': 'Replaced', 'run.sh': 'echo safe' })
    expect(fs.readFileSync(join(project, '.agents', 'skills', 'created', 'SKILL.md'), 'utf8')).toBe('Created')
    expect(fs.existsSync(original)).toBe(false)
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(temporaryFiles(skills)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'darwin').each(['/tmp', '/var/tmp'])('writes and moves through the macOS %s alias', parent => {
    const directory = fs.mkdtempSync(join(parent, 'halo-skill-alias-test-'))
    try {
      expect(fs.realpathSync(directory)).toBe(`/private${directory}`)
      const source = join(directory, 'source', 'SKILL.md')
      writeSkillPackage(source, { 'SKILL.md': 'Created' })
      writeSkillContent(source, 'Edited', skillRevision(source))
      writeSkillPackage(source, { 'SKILL.md': 'Replaced' }, undefined, skillRevision(source))
      const destination = join(directory, 'moved', 'SKILL.md')
      moveSkillFiles(source, destination, skillRevision(source))
      expect(fs.readFileSync(destination, 'utf8')).toBe('Replaced')
      expect(temporaryFiles(directory)).toEqual([])
    } finally {
      actualFs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['create', 'replace', 'edit', 'move'])('refuses an ancestor alias retargeted during %s staging', operation => {
    const source = fixture('project/source')
    const other = fixture('other/source')
    const project = dirname(dirname(source))
    const external = dirname(dirname(other))
    const alias = join(root, 'alias')
    fs.symlinkSync(project, alias, 'dir')
    const selected = join(alias, 'source', 'SKILL.md')
    const revision = skillRevision(selected)
    const destination = join(alias, 'destination', 'SKILL.md')
    if (operation === 'move') forceCrossVolume(dirname(source), join(project, 'destination'))
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      actualFs.writeFileSync(path, data, options)
      fs.unlinkSync(alias)
      fs.symlinkSync(external, alias, 'dir')
    })
    const action = () => {
      if (operation === 'create') writeSkillPackage(destination, { 'SKILL.md': 'Created' })
      else if (operation === 'replace') writeSkillPackage(selected, { 'SKILL.md': 'Replaced' }, undefined, revision)
      else if (operation === 'edit') writeSkillContent(selected, 'Edited', revision)
      else moveSkillFiles(selected, destination, revision)
    }
    expect(action).toThrow('parent directory changed')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(other, 'utf8')).toBe('# Original\n')
    expect(fs.existsSync(join(project, 'destination'))).toBe(false)
    expect(fs.existsSync(join(external, 'destination'))).toBe(false)
    expect(temporaryFiles(project)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects a replaced canonical ancestor even when the immediate parent inode survives', () => {
    const source = fixture('project/skills/source')
    const project = join(root, 'project')
    const previous = join(root, 'previous')
    const revision = skillRevision(source)
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      actualFs.writeFileSync(path, data, options)
      actualFs.renameSync(project, previous)
      fs.mkdirSync(project)
      actualFs.renameSync(join(previous, 'skills'), join(project, 'skills'))
    })
    expect(() => writeSkillContent(source, 'Edited', revision)).toThrow('parent directory changed')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(temporaryFiles(join(project, 'skills'))).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      reason: expect.stringContaining('Temporary files retained')
    }))
  })

  it('does not clean a substitute directory after a canonical parent is replaced with a link', () => {
    const source = fixture('project/source')
    const project = join(root, 'project')
    const previous = join(root, 'previous')
    const external = join(root, 'external')
    fs.mkdirSync(external)
    const revision = skillRevision(source)
    let control = ''
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      actualFs.writeFileSync(path, data, options)
      const [work] = temporaryFiles(project)
      actualFs.renameSync(project, previous)
      fs.symlinkSync(external, project, 'dir')
      control = join(external, work, 'control.txt')
      fs.mkdirSync(dirname(control))
      actualFs.writeFileSync(control, 'Control')
    })
    expect(() => writeSkillContent(source, 'Edited', revision)).toThrow('parent directory changed')
    expect(fs.readFileSync(join(previous, 'source', 'SKILL.md'), 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(control, 'utf8')).toBe('Control')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps a selected root link distinct from its aliased ancestors', () => {
    const original = fixture('project/source')
    const project = join(root, 'project')
    const alias = join(root, 'alias')
    fs.symlinkSync(project, alias, 'dir')
    fs.symlinkSync('source', join(project, 'linked'), 'dir')
    const selected = join(alias, 'linked', 'SKILL.md')
    const revision = skillRevision(selected)
    expect(skillRemovalPath(selected)).toBe(join(alias, 'linked'))
    expect(() => writeSkillPackage(selected, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('symbolic-link')
    expect(() => writeSkillContent(selected, 'New', revision)).toThrow('symbolic-link')
    const moved = join(project, 'moved', 'SKILL.md')
    moveSkillFiles(selected, moved, revision)
    expect(fs.lstatSync(dirname(moved)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dirname(moved))).toBe('source')
    expect(fs.readFileSync(original, 'utf8')).toBe('# Original\n')
  })

  it('rejects a destination inside the canonical source before creating its missing ancestors', () => {
    const source = fixture()
    const alias = join(root, 'alias')
    fs.symlinkSync(dirname(source), alias, 'dir')
    expect(() => moveSkillFiles(source, join(alias, 'missing', 'destination', 'SKILL.md'), skillRevision(source))).toThrow('outside')
    expect(fs.existsSync(join(dirname(source), 'missing'))).toBe(false)
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
  })

  it('does not redirect rollback through an alias retargeted after isolating the original', () => {
    const source = fixture('project/source')
    const other = fixture('other/source')
    const project = dirname(dirname(source))
    const alias = join(root, 'alias')
    fs.symlinkSync(project, alias, 'dir')
    const selected = join(alias, 'source', 'SKILL.md')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actualFs.renameSync(from, to)
      if (String(to).endsWith('/original')) {
        fs.unlinkSync(alias)
        fs.symlinkSync(dirname(dirname(other)), alias, 'dir')
      }
    })
    expect(() => writeSkillPackage(selected, { 'SKILL.md': 'Replaced' }, undefined, skillRevision(selected))).toThrow('parent directory changed')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(other, 'utf8')).toBe('# Original\n')
    expect(temporaryFiles(project)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rolls a same-volume move back on the pinned source after its alias changes', () => {
    const source = fixture('project/source')
    const other = fixture('other/source')
    const project = join(root, 'project')
    const alias = join(root, 'alias')
    fs.symlinkSync(project, alias, 'dir')
    const selected = join(alias, 'source', 'SKILL.md')
    const destination = join(root, 'destination', 'SKILL.md')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actualFs.renameSync(from, to)
      if (String(to) === dirname(destination)) {
        fs.unlinkSync(alias)
        fs.symlinkSync(join(root, 'other'), alias, 'dir')
      }
    })
    expect(() => moveSkillFiles(selected, destination, skillRevision(selected))).toThrow('parent directory changed')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(other, 'utf8')).toBe('# Original\n')
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('retains the moved original instead of rolling back through a replaced destination parent', () => {
    const source = fixture()
    const destination = join(root, 'target', 'moved', 'SKILL.md')
    const displaced = join(root, 'displaced')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actualFs.renameSync(from, to)
      if (String(to) === dirname(destination)) {
        actualFs.renameSync(join(root, 'target'), displaced)
        fs.mkdirSync(dirname(destination), { recursive: true })
        actualFs.writeFileSync(destination, 'Substitute')
      }
    })
    expect(() => moveSkillFiles(source, destination, skillRevision(source))).toThrow('original last known at')
    expect(fs.readFileSync(join(displaced, 'moved', 'SKILL.md'), 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(destination, 'utf8')).toBe('Substitute')
    expect(fs.existsSync(source)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('propagates a denied alias resolution without falling back to another path', () => {
    const source = fixture('project/source')
    const alias = join(root, 'alias')
    fs.symlinkSync(join(root, 'project'), alias, 'dir')
    const selected = join(alias, 'source', 'SKILL.md')
    const revision = skillRevision(selected)
    vi.mocked(fs.realpathSync).mockImplementation((path, options) => {
      if (String(path) === alias) throw ioError('EACCES')
      return actualFs.realpathSync(path, options)
    })
    expect(() => writeSkillContent(selected, 'Edited', revision)).toThrow('EACCES')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(temporaryFiles(join(root, 'project'))).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('skillRevision', () => {
  it('detects supporting edits even when parent and file mtime are restored', () => {
    const filePath = fixture()
    const script = put(filePath, 'run.sh', 'echo before')
    const directoryStat = fs.statSync(dirname(filePath))
    const fileStat = fs.statSync(script)
    const revision = skillRevision(filePath)
    fs.writeFileSync(script, 'echo after!')
    fs.utimesSync(script, fileStat.atime, fileStat.mtime)
    fs.utimesSync(dirname(filePath), directoryStat.atime, directoryStat.mtime)
    expect(skillRevision(filePath)).not.toBe(revision)
    expect(() => assertSkillRevision(filePath, revision)).toThrow('changed')
  })

  it('includes link metadata without following nested link targets', () => {
    const filePath = fixture()
    const link = join(dirname(filePath), 'ref')
    fs.symlinkSync('../outside-one', link)
    const revision = skillRevision(filePath)
    fs.unlinkSync(link)
    fs.symlinkSync('../outside-two', link)
    expect(skillRevision(filePath)).not.toBe(revision)
  })

  it('detects replacing the whole skill with an alias', () => {
    const filePath = fixture()
    const other = fixture('other')
    const revision = skillRevision(filePath)
    fs.renameSync(dirname(filePath), join(root, 'original'))
    fs.symlinkSync(dirname(other), dirname(filePath), 'dir')
    expect(() => assertSkillRevision(filePath, revision)).toThrow('changed')
  })

  it('does not read supporting content during revision checks', () => {
    const filePath = fixture()
    put(filePath, 'support.txt', 'Payload')
    expect(() => assertSkillRevision(filePath, skillRevision(filePath))).not.toThrow()
    expect(fs.readSync).not.toHaveBeenCalled()
    expect(() => assertSkillRevision(filePath, '')).toThrow('revision is required')
  })
})

describe('writeSkillPackage', () => {
  it('creates an independent binary-safe package', () => {
    const source = fixture()
    put(source, 'nested/ref.txt', 'Reference')
    const bytes = Buffer.from([0, 255, 42, 128])
    put(source, 'image.bin', bytes)
    const pkg = readSkillPackage(source)
    const destination = join(root, 'destination', 'SKILL.md')
    writeSkillPackage(destination, pkg.files, pkg.assets)
    expect(fs.readFileSync(join(dirname(destination), 'image.bin'))).toEqual(bytes)
    expect(readSkillPackage(destination).files).toEqual(pkg.files)
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(temporaryFiles()).toEqual([])
  })

  it('copies executable and binary file modes when the caller supplies the optional map', () => {
    const source = fixture()
    put(source, 'scripts/run.sh', 'echo unchanged', 0o751)
    put(source, 'resource.bin', Buffer.from([0, 255, 128]), 0o640)
    const pkg = readSkillPackage(source)
    const destination = join(root, 'destination', 'SKILL.md')
    writeSkillPackage(destination, pkg.files, pkg.assets, undefined, pkg.modes)
    expect(readSkillPackage(destination)).toMatchObject({ files: pkg.files, assets: pkg.assets, modes: pkg.modes })
    expect(fs.statSync(join(dirname(destination), 'scripts/run.sh')).mode & 0o777).toBe(0o751)
    expect(fs.statSync(join(dirname(destination), 'resource.bin')).mode & 0o777).toBe(0o640)
  })

  it('allows explicit file modes on replacement while retaining unspecified modes', () => {
    const filePath = fixture()
    put(filePath, 'scripts/run.sh', 'echo old', 0o751)
    fs.chmodSync(filePath, 0o640)
    writeSkillPackage(filePath, { 'SKILL.md': 'New', 'scripts/run.sh': 'echo new', 'new.txt': 'New' }, undefined,
      skillRevision(filePath), { 'scripts\\run.sh': 0o750 })
    expect(fs.statSync(join(dirname(filePath), 'scripts/run.sh')).mode & 0o777).toBe(0o750)
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o640)
    expect(fs.statSync(join(dirname(filePath), 'new.txt')).mode & 0o777).toBe(0o644)
  })

  it('preserves a copied flat file mode and defaults to ordinary permissions without a map', () => {
    const filePath = fixture()
    fs.chmodSync(filePath, 0o750)
    const pkg = readSkillPackage(filePath)
    const destination = join(root, 'flat.md')
    writeSkillPackage(destination, pkg.files, pkg.assets, undefined, pkg.modes)
    expect(fs.statSync(destination).mode & 0o777).toBe(0o750)
    const ordinary = join(root, 'ordinary.md')
    writeSkillPackage(ordinary, pkg.files, pkg.assets)
    expect(fs.statSync(ordinary).mode & 0o777).toBe(0o644)
  })

  it.each<Record<string, number>>([
    { 'SKILL.md': -1 }, { 'SKILL.md': 0o4755 }, { 'SKILL.md': 0.5 }, { 'SKILL.md': NaN },
    { 'SKILL.md': Infinity }, { 'absent.sh': 0o755 }, { '../escape': 0o755 }, { 'scripts': 0o755 },
    { 'scripts/run.sh': 0o751, 'scripts\\run.sh': 0o755 }
  ])('rejects invalid file modes before creating the destination: %j', modes => {
    const target = join(root, 'new-parent', 'destination', 'SKILL.md')
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main', 'scripts/run.sh': 'echo safe' }, undefined, undefined, modes)).toThrow()
    expect(fs.existsSync(join(root, 'new-parent'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed mode maps without creating files and ignores inherited entries', () => {
    const target = join(root, 'destination', 'SKILL.md')
    for (const modes of [null, [], '755', { 'SKILL.md': '755' }]) {
      expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main' }, undefined, undefined,
        modes as unknown as Record<string, number>)).toThrow('Invalid skill file mode')
      expect(fs.existsSync(dirname(target))).toBe(false)
    }
    const modes = Object.assign(Object.create({ '../escape': 0o755 }), { 'SKILL.md': 0o640 })
    writeSkillPackage(target, { 'SKILL.md': 'Main' }, undefined, undefined, modes)
    expect(fs.statSync(target).mode & 0o777).toBe(0o640)
  })

  it('requires an expected revision before replacing an existing target', () => {
    const filePath = fixture()
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' })).toThrow('already exists')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Original\n')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      operation: 'replace package', filePath, reason: expect.stringContaining('already exists')
    }))
  })

  it('replaces the whole package and preserves retained file modes', () => {
    const filePath = fixture()
    const script = put(filePath, 'scripts/run.sh', 'echo old', 0o751)
    put(filePath, 'obsolete.sh', 'echo removed')
    fs.chmodSync(filePath, 0o640)
    const revision = skillRevision(filePath)
    writeSkillPackage(filePath, { 'SKILL.md': 'New', 'scripts/run.sh': 'echo new' }, undefined, revision)
    expect(fs.existsSync(join(dirname(filePath), 'obsolete.sh'))).toBe(false)
    expect(fs.readFileSync(script, 'utf8')).toBe('echo new')
    expect(fs.statSync(script).mode & 0o777).toBe(0o751)
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o640)
    expect(temporaryFiles()).toEqual([])
  })

  it('replaces only a flat file and refuses to discard flat supporting resources', () => {
    const filePath = join(root, 'legacy.md')
    fs.writeFileSync(filePath, 'Original flat')
    fs.writeFileSync(join(root, 'control.txt'), 'Control')
    const revision = skillRevision(filePath)
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New', 'extra.txt': 'Extra' }, undefined, revision)).toThrow('flat skill')
    writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('New')
    expect(fs.readFileSync(join(root, 'control.txt'), 'utf8')).toBe('Control')
  })

  it('rejects stale replacements including concurrent supporting-resource edits', () => {
    const filePath = fixture()
    const script = put(filePath, 'run.sh', 'before')
    const revision = skillRevision(filePath)
    fs.writeFileSync(script, 'after')
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('changed')
    expect(fs.readFileSync(script, 'utf8')).toBe('after')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Original\n')
  })

  it.each([
    '../escape.txt', '/tmp/escape.txt', 'C:\\escape.txt', 'C:escape.txt',
    '\\\\host\\share\\escape.txt', 'a/../escape.txt', 'a//b.txt', './escape.txt',
    'bad\0.txt', 'name:stream', 'NUL.txt', 'name. ', 'a/'.repeat(33) + 'b.txt'
  ])('rejects unsafe package path %j', path => {
    const target = join(root, 'destination', 'SKILL.md')
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main', [path]: 'Bad' })).toThrow()
    expect(fs.existsSync(dirname(target))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it.each<Record<string, string>>([
    { 'a/b.txt': 'One', 'a\\b.txt': 'Two' },
    { 'a.txt': 'One', 'A.txt': 'Two' },
    { 'é.txt': 'One', 'e\u0301.txt': 'Two' },
    { a: 'One', 'a/b.txt': 'Two' },
    { 'a/b.txt': 'One', a: 'Two' }
  ])('rejects canonical duplicates and file-directory collisions', resources => {
    const target = join(root, 'destination', 'SKILL.md')
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main', ...resources })).toThrow()
    expect(fs.existsSync(dirname(target))).toBe(false)
  })

  it('rejects duplicate text/binary paths, invalid base64 and invalid text', () => {
    const target = join(root, 'destination', 'SKILL.md')
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main', 'x.bin': 'Text' }, {
      'x.bin': { encoding: 'base64', content: 'AA==' }
    })).toThrow('Duplicate')
    for (const content of ['??', 'Zg=', 'Zh==', 'Zm 9v', 'Zg']) {
      expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main' }, {
        'x.bin': { encoding: 'base64', content }
      })).toThrow('Invalid base64')
    }
    expect(() => writeSkillPackage(target, { 'SKILL.md': '\ud800' })).toThrow('Invalid UTF-8')
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main\0' })).toThrow('UTF-8 text')
    expect(fs.existsSync(dirname(target))).toBe(false)
  })

  it('rejects oversized instruction content and aggregate resources before creating a target', () => {
    const target = join(root, 'destination', 'SKILL.md')
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'x'.repeat(1024 * 1024 + 1) })).toThrow('1 MiB')
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main', 'resource.txt': 'x'.repeat(32 * 1024 * 1024) })).toThrow('32 MiB')
    const files = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`item-${index}`, '']))
    expect(() => writeSkillPackage(target, { 'SKILL.md': 'Main', ...files })).toThrow('2000 entries')
    expect(fs.existsSync(dirname(target))).toBe(false)
  })

  it('decodes large bounded base64 resources without a recursive pattern match', () => {
    const target = join(root, 'destination', 'SKILL.md')
    const bytes = Buffer.alloc(2 * 1024 * 1024, 255)
    writeSkillPackage(target, { 'SKILL.md': 'Main' }, {
      'resource.bin': { encoding: 'base64', content: bytes.toString('base64') }
    })
    expect(fs.readFileSync(join(dirname(target), 'resource.bin'))).toEqual(bytes)
  })

  it('accepts a stable destination ancestor alias but rejects an existing dangling root link', () => {
    const external = join(root, 'external')
    fs.mkdirSync(external)
    const alias = join(root, 'alias')
    fs.symlinkSync(external, alias, 'dir')
    writeSkillPackage(join(alias, 'new', 'SKILL.md'), { 'SKILL.md': 'New' })
    expect(fs.readFileSync(join(external, 'new', 'SKILL.md'), 'utf8')).toBe('New')
    const dangling = join(root, 'dangling')
    fs.symlinkSync(join(root, 'missing'), dangling)
    expect(() => writeSkillPackage(join(dangling, 'SKILL.md'), { 'SKILL.md': 'New' })).toThrow('already exists')
    expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true)
  })

  it('refuses replacing packages with nested links without touching their targets', () => {
    const filePath = fixture()
    const external = join(root, 'outside.txt')
    fs.writeFileSync(external, 'Control')
    fs.symlinkSync(external, join(dirname(filePath), 'ref.txt'))
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New', 'ref.txt': 'New' }, undefined, skillRevision(filePath))).toThrow('Nested symbolic links')
    expect(fs.readFileSync(external, 'utf8')).toBe('Control')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Original\n')
  })

  it('preserves the original if staging partially writes then fails', () => {
    const filePath = fixture()
    const revision = skillRevision(filePath)
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, _data, options) => {
      actualFs.writeFileSync(path, 'Partial', options)
      throw ioError('ENOSPC')
    })
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('ENOSPC')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Original\n')
    expect(temporaryFiles()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rolls back the original if publishing the staged replacement fails', () => {
    const filePath = fixture()
    const script = put(filePath, 'run.sh', 'Original script', 0o755)
    const revision = skillRevision(filePath)
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith('/package')) throw ioError()
      actualFs.renameSync(from, to)
    })
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('EIO')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(script, 'utf8')).toBe('Original script')
    expect(fs.statSync(script).mode & 0o777).toBe(0o755)
    expect(temporaryFiles()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('retains a recoverable backup when the rollback itself cannot rename', () => {
    const filePath = fixture()
    const revision = skillRevision(filePath)
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith('/package') || String(from).endsWith('/original')) throw ioError()
      actualFs.renameSync(from, to)
    })
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('original retained at')
    const [directory] = temporaryFiles()
    expect(fs.readFileSync(join(root, directory, 'original', 'SKILL.md'), 'utf8')).toBe('# Original\n')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rechecks revision after staging instead of overwriting a concurrent edit', () => {
    const filePath = fixture()
    const revision = skillRevision(filePath)
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      actualFs.writeFileSync(path, data, options)
      actualFs.writeFileSync(filePath, 'External edit')
    })
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('changed')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('External edit')
    expect(temporaryFiles()).toEqual([])
  })

  it('refuses a destination replaced by a symlink while staging', () => {
    const filePath = fixture()
    const external = fixture('external')
    const revision = skillRevision(filePath)
    const previous = join(root, 'previous')
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      actualFs.writeFileSync(path, data, options)
      actualFs.renameSync(dirname(filePath), previous)
      fs.symlinkSync(dirname(external), dirname(filePath), 'dir')
    })
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('changed')
    expect(fs.readFileSync(external, 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(join(previous, 'SKILL.md'), 'utf8')).toBe('# Original\n')
    expect(fs.lstatSync(dirname(filePath)).isSymbolicLink()).toBe(true)
    expect(temporaryFiles()).toEqual([])
  })

  it('reports backup cleanup failures once without misreporting a committed replacement', () => {
    const filePath = fixture()
    const revision = skillRevision(filePath)
    vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw ioError('EACCES') })
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).not.toThrow()
    expect(fs.readFileSync(filePath, 'utf8')).toBe('New')
    const [directory] = temporaryFiles()
    expect(fs.readFileSync(join(root, directory, 'original', 'SKILL.md'), 'utf8')).toBe('# Original\n')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup incomplete'), expect.objectContaining({
      reason: expect.stringContaining('retained at')
    }))
  })

  it('checks the isolated backup before committing the new package', () => {
    const filePath = fixture()
    const revision = skillRevision(filePath)
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actualFs.renameSync(from, to)
      if (String(to).endsWith('/original')) actualFs.writeFileSync(join(String(to), 'SKILL.md'), 'Racing edit')
    })
    expect(() => writeSkillPackage(filePath, { 'SKILL.md': 'New' }, undefined, revision)).toThrow('changed')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('Racing edit')
  })
})

describe('writeSkillContent', () => {
  it('atomically edits instructions without rewriting supporting bytes or modes', () => {
    const filePath = fixture()
    const script = put(filePath, 'run.sh', 'echo untouched', 0o751)
    const bytes = Buffer.from([0, 255, 128])
    const binary = put(filePath, 'image.bin', bytes)
    const before = fs.statSync(script)
    fs.chmodSync(filePath, 0o640)
    writeSkillContent(filePath, '# Updated\n', skillRevision(filePath))
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Updated\n')
    expect(fs.readFileSync(binary)).toEqual(bytes)
    expect(fs.statSync(script).ino).toBe(before.ino)
    expect(fs.statSync(script).mtimeMs).toBe(before.mtimeMs)
    expect(fs.statSync(script).mode).toBe(before.mode)
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o640)
    expect(temporaryFiles()).toEqual([])
  })

  it('preserves nested symlinks while refusing a linked main file', () => {
    const filePath = fixture()
    const external = join(root, 'external.txt')
    fs.writeFileSync(external, 'Control')
    const alias = join(dirname(filePath), 'ref')
    fs.symlinkSync(external, alias)
    writeSkillContent(filePath, 'Updated', skillRevision(filePath))
    expect(fs.readlinkSync(alias)).toBe(external)
    expect(fs.readFileSync(external, 'utf8')).toBe('Control')
    fs.unlinkSync(filePath)
    fs.symlinkSync(external, filePath)
    expect(() => writeSkillContent(filePath, 'Overwrite', skillRevision(filePath))).toThrow('regular file')
    expect(fs.readFileSync(external, 'utf8')).toBe('Control')
  })

  it('refuses editing a root link without dereferencing it', () => {
    const original = fixture()
    const alias = join(root, 'alias')
    fs.symlinkSync(dirname(original), alias, 'dir')
    const filePath = join(alias, 'SKILL.md')
    expect(() => writeSkillContent(filePath, 'New', skillRevision(filePath))).toThrow('symbolic-link')
    expect(fs.readFileSync(original, 'utf8')).toBe('# Original\n')
  })

  it('preserves old instructions after an atomic rename failure', () => {
    const filePath = fixture()
    const revision = skillRevision(filePath)
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw ioError('EACCES') })
    expect(() => writeSkillContent(filePath, 'New', revision)).toThrow('EACCES')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Original\n')
    expect(temporaryFiles()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('edits a flat file without touching adjacent resources', () => {
    const filePath = join(root, 'legacy.md')
    fs.writeFileSync(filePath, 'Original')
    const control = join(root, 'control.txt')
    fs.writeFileSync(control, 'Control')
    const before = fs.statSync(control)
    writeSkillContent(filePath, 'Updated', skillRevision(filePath))
    expect(fs.readFileSync(filePath, 'utf8')).toBe('Updated')
    expect(fs.readFileSync(control, 'utf8')).toBe('Control')
    expect(fs.statSync(control).mtimeMs).toBe(before.mtimeMs)
  })

  it('rejects a stale edit after a supporting file changes', () => {
    const filePath = fixture()
    const support = put(filePath, 'support.txt', 'Old')
    const revision = skillRevision(filePath)
    fs.writeFileSync(support, 'External')
    expect(() => writeSkillContent(filePath, 'New', revision)).toThrow('changed')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(support, 'utf8')).toBe('External')
  })
})

describe('moveSkillFiles', () => {
  it('moves a complete directory without changing bytes, file identity or permissions', () => {
    const source = fixture()
    const bytes = Buffer.from([0, 255, 128])
    const script = put(source, 'nested/run.sh', 'echo safe', 0o751)
    put(source, 'image.bin', bytes)
    const before = fs.statSync(script)
    const destination = join(root, 'destination', 'SKILL.md')
    moveSkillFiles(source, destination, skillRevision(source))
    expect(fs.existsSync(dirname(source))).toBe(false)
    expect(fs.readFileSync(join(dirname(destination), 'image.bin'))).toEqual(bytes)
    expect(fs.statSync(join(dirname(destination), 'nested/run.sh')).ino).toBe(before.ino)
    expect(fs.statSync(join(dirname(destination), 'nested/run.sh')).mode).toBe(before.mode)
    expect(temporaryFiles()).toEqual([])
  })

  it('moves only a flat file and rejects implicit layout conversion', () => {
    const source = join(root, 'legacy.md')
    fs.writeFileSync(source, 'Flat instructions')
    fs.writeFileSync(join(root, 'control.txt'), 'Control')
    const revision = skillRevision(source)
    expect(() => moveSkillFiles(source, join(root, 'destination', 'SKILL.md'), revision)).toThrow('flat and directory')
    const destination = join(root, 'folder', 'renamed.md')
    moveSkillFiles(source, destination, revision)
    expect(fs.readFileSync(destination, 'utf8')).toBe('Flat instructions')
    expect(fs.readFileSync(join(root, 'control.txt'), 'utf8')).toBe('Control')
    expect(fs.existsSync(source)).toBe(false)
  })

  it('rejects an existing destination, stale source and a destination inside the source', () => {
    const source = fixture()
    const destination = fixture('destination')
    const revision = skillRevision(source)
    expect(() => moveSkillFiles(source, destination, revision)).toThrow('already exists')
    expect(() => moveSkillFiles(source, join(dirname(source), 'nested', 'SKILL.md'), revision)).toThrow('outside')
    fs.writeFileSync(source, 'Changed')
    expect(() => moveSkillFiles(source, join(root, 'new', 'SKILL.md'), revision)).toThrow('changed')
    expect(fs.readFileSync(destination, 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(source, 'utf8')).toBe('Changed')
  })

  it('moves an absolute root link only, keeping its external target unchanged', () => {
    const actual = fixture()
    const alias = join(root, 'alias')
    fs.symlinkSync(dirname(actual), alias, 'dir')
    const source = join(alias, 'SKILL.md')
    const destination = join(root, 'moved-link', 'SKILL.md')
    moveSkillFiles(source, destination, skillRevision(source))
    expect(fs.lstatSync(dirname(destination)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dirname(destination))).toBe(dirname(actual))
    expect(fs.readFileSync(actual, 'utf8')).toBe('# Original\n')
    expect(fs.existsSync(alias)).toBe(false)
  })

  it('preserves a relative root link only if moving cannot change its target', () => {
    const actual = fixture()
    const alias = join(root, 'alias')
    fs.symlinkSync('source', alias, 'dir')
    const source = join(alias, 'SKILL.md')
    const revision = skillRevision(source)
    expect(() => moveSkillFiles(source, join(root, 'other-parent', 'alias', 'SKILL.md'), revision)).toThrow('change its target')
    moveSkillFiles(source, join(root, 'renamed-alias', 'SKILL.md'), revision)
    expect(fs.readlinkSync(join(root, 'renamed-alias'))).toBe('source')
    expect(fs.readFileSync(actual, 'utf8')).toBe('# Original\n')
  })

  it('refuses nested-link moves but accepts stable destination ancestor aliases', () => {
    const source = fixture()
    const external = join(root, 'external')
    fs.mkdirSync(external)
    fs.symlinkSync(external, join(dirname(source), 'ref'), 'dir')
    expect(() => moveSkillFiles(source, join(root, 'destination', 'SKILL.md'), skillRevision(source))).toThrow('Nested symbolic links')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    fs.unlinkSync(join(dirname(source), 'ref'))
    const alias = join(root, 'alias')
    fs.symlinkSync(external, alias, 'dir')
    moveSkillFiles(source, join(alias, 'destination', 'SKILL.md'), skillRevision(source))
    expect(fs.existsSync(source)).toBe(false)
    expect(fs.readFileSync(join(external, 'destination', 'SKILL.md'), 'utf8')).toBe('# Original\n')
  })

  it('copies bytes, empty directories and executable modes across simulated volumes', () => {
    const source = fixture()
    const bytes = Buffer.from([0, 255, 128, 1])
    put(source, 'resources/image.bin', bytes)
    put(source, 'scripts/run.sh', 'echo unchanged', 0o751)
    fs.mkdirSync(join(dirname(source), 'empty'))
    const destination = join(root, 'destination', 'SKILL.md')
    forceCrossVolume(dirname(source), dirname(destination))
    moveSkillFiles(source, destination, skillRevision(source))
    expect(fs.existsSync(dirname(source))).toBe(false)
    expect(fs.readFileSync(join(dirname(destination), 'resources/image.bin'))).toEqual(bytes)
    expect(fs.statSync(join(dirname(destination), 'scripts/run.sh')).mode & 0o777).toBe(0o751)
    expect(fs.statSync(join(dirname(destination), 'empty')).isDirectory()).toBe(true)
    expect(temporaryFiles()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('copies a flat file across simulated volumes without moving its parent', () => {
    const source = join(root, 'legacy.md')
    const destination = join(root, 'new', 'legacy.md')
    fs.writeFileSync(source, 'Flat instructions')
    fs.chmodSync(source, 0o640)
    fs.writeFileSync(join(root, 'control.txt'), 'Control')
    forceCrossVolume(source, destination)
    moveSkillFiles(source, destination, skillRevision(source))
    expect(fs.readFileSync(destination, 'utf8')).toBe('Flat instructions')
    expect(fs.statSync(destination).mode & 0o777).toBe(0o640)
    expect(fs.readFileSync(join(root, 'control.txt'), 'utf8')).toBe('Control')
    expect(fs.existsSync(source)).toBe(false)
  })

  it('rolls back a same-volume move if content changed during the rename', () => {
    const source = fixture()
    const destination = join(root, 'destination', 'SKILL.md')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actualFs.renameSync(from, to)
      if (String(to) === dirname(destination)) actualFs.writeFileSync(destination, 'Racing edit')
    })
    expect(() => moveSkillFiles(source, destination, skillRevision(source))).toThrow('changed')
    expect(fs.readFileSync(source, 'utf8')).toBe('Racing edit')
    expect(fs.existsSync(dirname(destination))).toBe(false)
  })

  it('keeps the original if cross-volume verification detects corrupted bytes', () => {
    const source = fixture()
    const destination = join(root, 'destination', 'SKILL.md')
    forceCrossVolume(dirname(source), dirname(destination))
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      const altered = Buffer.from(data as Buffer)
      altered[0] ^= 1
      actualFs.writeFileSync(path, altered, options)
    })
    expect(() => moveSkillFiles(source, destination, skillRevision(source))).toThrow('verification failed')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(fs.existsSync(dirname(destination))).toBe(false)
    expect(temporaryFiles()).toEqual([])
  })

  it('keeps the original when cross-volume copying partially fails', () => {
    const source = fixture()
    const destination = join(root, 'destination', 'SKILL.md')
    const revision = skillRevision(source)
    forceCrossVolume(dirname(source), dirname(destination))
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, _data, options) => {
      actualFs.writeFileSync(path, 'Partial', options)
      throw ioError('ENOSPC')
    })
    expect(() => moveSkillFiles(source, destination, revision)).toThrow('ENOSPC')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(fs.existsSync(dirname(destination))).toBe(false)
    expect(temporaryFiles()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rolls back the isolated original if cross-volume publication fails', () => {
    const source = fixture()
    const destination = join(root, 'destination', 'SKILL.md')
    const revision = skillRevision(source)
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from) === dirname(source) && String(to) === dirname(destination)) throw ioError('EXDEV')
      if (String(from).endsWith('/package')) throw ioError('EACCES')
      actualFs.renameSync(from, to)
    })
    expect(() => moveSkillFiles(source, destination, revision)).toThrow('EACCES')
    expect(fs.readFileSync(source, 'utf8')).toBe('# Original\n')
    expect(fs.existsSync(dirname(destination))).toBe(false)
    expect(temporaryFiles()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-volume root-link moves instead of copying the target', () => {
    const actual = fixture()
    const source = join(root, 'alias', 'SKILL.md')
    fs.symlinkSync(dirname(actual), dirname(source), 'dir')
    const destination = join(root, 'destination', 'SKILL.md')
    forceCrossVolume(dirname(source), dirname(destination))
    expect(() => moveSkillFiles(source, destination, skillRevision(source))).toThrow('Cross-volume symbolic-link')
    expect(fs.lstatSync(dirname(source)).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(actual, 'utf8')).toBe('# Original\n')
    expect(fs.existsSync(dirname(destination))).toBe(false)
  })
})

describe('read-only packaged sources (Electron asar)', () => {
  // Electron's asar layer has no opendir, and reports a new inode for every lstat/fstat.
  function simulateAsar(base: string): void {
    let counter = 1_000_000
    vi.mocked(fs.opendirSync).mockImplementation(((path: fs.PathLike) => {
      if (String(path).startsWith(base)) throw Object.assign(new Error('ENOTDIR: not a directory, opendir'), { code: 'ENOTDIR' })
      return actualFs.opendirSync(path)
    }) as typeof fs.opendirSync)
    const fresh = (stat: fs.Stats): fs.Stats => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: counter++, dev: 1 })
    vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const stat = actualFs.lstatSync(path, options as fs.StatOptions) as fs.Stats
      if (!String(path).startsWith(base) || !stat) return stat
      // Bypassing the virtual layer exposes the archive itself, which is a single regular file on disk.
      if ((process as NodeJS.Process & { noAsar?: boolean }).noAsar && String(path) === base) {
        return Object.assign(fresh(stat), { isFile: () => true, isDirectory: () => false })
      }
      return fresh(stat)
    }) as typeof fs.lstatSync)
    vi.mocked(fs.fstatSync).mockImplementation(((fd: number, options?: unknown) => {
      const stat = actualFs.fstatSync(fd, options as fs.StatOptions) as fs.Stats
      return fresh(stat)
    }) as typeof fs.fstatSync)
  }

  afterEach(() => {
    vi.mocked(fs.opendirSync).mockImplementation(actualFs.opendirSync)
    vi.mocked(fs.lstatSync).mockImplementation(actualFs.lstatSync as typeof fs.lstatSync)
    vi.mocked(fs.fstatSync).mockImplementation(actualFs.fstatSync as typeof fs.fstatSync)
  })

  function packaged(): { base: string; file: string } {
    const base = join(root, 'resources.asar')
    const file = join(base, 'builtin-skills', 'office', 'SKILL.md')
    fs.mkdirSync(join(dirname(file), 'references', 'deep'), { recursive: true })
    fs.writeFileSync(file, '---\nname: office\n---\n# Office\n')
    fs.writeFileSync(join(dirname(file), 'references', 'guide.md'), 'guide')
    fs.writeFileSync(join(dirname(file), 'references', 'deep', 'blob.bin'), Buffer.from([0, 1, 2, 255]))
    return { base, file }
  }

  describe('telling the archive apart from ordinary folders that merely look like it', () => {
    // On disk the archive is one regular file; its contents are virtual. Real files hold the same name pattern.
    function archiveFile(directory: string): string {
      fs.mkdirSync(directory, { recursive: true })
      const archive = join(directory, 'app.asar')
      fs.writeFileSync(archive, 'archive bytes')
      return archive
    }

    it('recognises an archive file and everything beneath it', () => {
      const archive = archiveFile(join(root, 'resources'))
      expect(insideAsar(archive)).toBe(true)
      expect(insideAsar(join(archive, 'resources', 'builtin-skills', 'pdf', 'SKILL.md'))).toBe(true)
    })

    it('splits Windows-style separators and drive paths at the archive segment', () => {
      // POSIX cannot resolve C:\ on disk, so the real archive is addressed through its own path and only the
      // text after it is written the Windows way. The Windows-only prefix cases below are covered as non-archives.
      const archive = archiveFile(join(root, 'resources'))
      const beneathWindowsStyle = `${archive}${win32.sep}resources${win32.sep}builtin-skills${win32.sep}docx${win32.sep}SKILL.md`
      expect(insideAsar(beneathWindowsStyle)).toBe(true)
      expect(insideAsar(`${archive}\\resources/builtin-skills\\docx`)).toBe(true)
      for (const text of [
        win32.join('C:\\Program Files\\Halo\\resources', 'app.asar.unpacked', 'x', 'index.js'),
        win32.join('c:\\users\\a\\skills', 'foo.asar', 'pdf', 'SKILL.md'),
        win32.join('C:\\HALO\\RESOURCES', 'APP.ASARX', 'pdf'),
        '\\\\server\\share\\Halo\\app.asar.unpacked\\x',
      ]) expect(insideAsar(text)).toBe(false)
    })

    it('follows the filesystem when the archive path is written in another case', () => {
      const archive = archiveFile(join(root, 'Program Files', 'Halo', 'resources'))
      const probe = join(dirname(archive), 'case-probe.txt')
      fs.writeFileSync(probe, 'x')
      const caseInsensitive = fs.existsSync(probe.replace('case-probe', 'CASE-PROBE'))
      // Windows and default macOS volumes resolve the other spelling to the same archive; case-sensitive ones do not.
      expect(insideAsar(archive.replace('app.asar', 'APP.ASAR'))).toBe(caseInsensitive)
    })

    it('never treats app.asar.unpacked as the archive: its files are real', () => {
      const archive = archiveFile(join(root, 'resources'))
      const unpacked = `${archive}.unpacked`
      fs.mkdirSync(join(unpacked, 'node_modules', 'x'), { recursive: true })
      expect(insideAsar(join(unpacked, 'node_modules', 'x', 'index.js'))).toBe(false)
      expect(insideAsar(win32.join('C:\\Halo\\resources', 'app.asar.unpacked', 'x', 'index.js'))).toBe(false)
    })

    it('reads a package inside app.asar.unpacked with the strict identity check and real directory listing', () => {
      const archive = archiveFile(join(root, 'resources'))
      const skill = join(`${archive}.unpacked`, 'builtin-skills', 'office', 'SKILL.md')
      fs.mkdirSync(join(dirname(skill), 'references'), { recursive: true })
      fs.writeFileSync(skill, '---\nname: office\n---\n# Office\n')
      fs.writeFileSync(join(dirname(skill), 'references', 'guide.md'), 'guide')
      const before = skillRevision(skill)
      expect(readSkillPackage(skill).revision).toBe(before)
      // Strict listing: the real opendir was used for this directory, not the archive path.
      expect(vi.mocked(fs.opendirSync).mock.calls.some(([path]) => String(path).startsWith(`${archive}.unpacked`))).toBe(true)
      // Strict identity: touching the directory changes its revision, which the relaxed archive check would ignore.
      const stat = fs.statSync(dirname(skill))
      fs.utimesSync(dirname(skill), stat.atime, new Date(stat.mtimeMs + 5000))
      expect(skillRevision(skill)).not.toBe(before)
    })

    it.each([
      ['a user folder called foo.asar', (base: string) => join(base, 'foo.asar', 'pdf', 'SKILL.md')],
      ['a user folder called app.asar', (base: string) => join(base, 'app.asar', 'pdf', 'SKILL.md')],
    ])('does not treat %s as an archive', (_name, build) => {
      const file = build(join(root, 'projects'))
      fs.mkdirSync(dirname(file), { recursive: true })
      fs.writeFileSync(file, '---\nname: pdf\n---\n')
      expect(insideAsar(file)).toBe(false)
      expect(insideAsar(dirname(dirname(file)))).toBe(false)
    })

    it('does not treat a lookalike name or a missing path as an archive', () => {
      expect(insideAsar(join(root, 'app.asarx', 'pdf', 'SKILL.md'))).toBe(false)
      expect(insideAsar(join(root, 'does-not-exist', 'app.asar', 'pdf'))).toBe(false)
      expect(insideAsar(join(root, 'plain', 'SKILL.md'))).toBe(false)
    })

    // process.noAsar is process-wide: left set, the app could no longer read its own packaged files.
    it.each([undefined, false, true])('hands process.noAsar back as %s after probing, also when the probe fails', original => {
      // Electron types noAsar as a required boolean; outside Electron the property is absent.
      const processWithAsar = process as unknown as { noAsar?: boolean }
      const hadNoAsar = Object.prototype.hasOwnProperty.call(process, 'noAsar')
      const noAsarBefore = processWithAsar.noAsar
      const seen: Array<boolean | undefined> = []
      const probe = join(root, `restore-miss-${original}`, 'app.asar')
      processWithAsar.noAsar = original
      try {
        vi.mocked(fs.lstatSync).mockImplementationOnce((() => {
          seen.push(processWithAsar.noAsar)
          throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' })
        }) as unknown as typeof fs.lstatSync)
        expect(insideAsar(probe)).toBe(false)
        expect(seen).toEqual([true])
        expect(processWithAsar.noAsar).toBe(original)

        vi.mocked(fs.lstatSync).mockImplementationOnce((() => {
          seen.push(processWithAsar.noAsar)
          return Object.assign(Object.create(fs.Stats.prototype), { isFile: () => true })
        }) as unknown as typeof fs.lstatSync)
        expect(insideAsar(join(root, `restore-hit-${original}`, 'app.asar'))).toBe(true)
        expect(seen).toEqual([true, true])
        expect(processWithAsar.noAsar).toBe(original)
      } finally {
        if (hadNoAsar) processWithAsar.noAsar = noAsarBefore
        else Reflect.deleteProperty(process, 'noAsar')
      }
    })

    it('finds the real archive even when a user folder named foo.asar precedes it', () => {
      const outer = join(root, 'foo.asar', 'inner')
      const archive = archiveFile(outer)
      expect(insideAsar(join(archive, 'resources', 'builtin-skills', 'pdf', 'SKILL.md'))).toBe(true)
      expect(insideAsar(join(root, 'foo.asar', 'inner', 'other', 'SKILL.md'))).toBe(false)
    })

    it('keeps the strict identity check for an ordinary folder called foo.asar', () => {
      const source = join(root, 'projects', 'foo.asar', 'my-skill')
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(join(source, 'SKILL.md'), '---\nname: my-skill\n---\nbody')
      const before = skillRevision(join(source, 'SKILL.md'))
      const stat = fs.statSync(source)
      fs.utimesSync(source, stat.atime, new Date(stat.mtimeMs + 5000))
      expect(skillRevision(join(source, 'SKILL.md'))).not.toBe(before)
      expect(vi.mocked(fs.opendirSync).mock.calls.some(([path]) => String(path).includes('foo.asar'))).toBe(true)
    })
  })

  it('lists and reads a nested package, including binary resources, when opendir is unavailable', () => {
    const { base, file } = packaged()
    simulateAsar(base)
    const pkg = readSkillPackage(file)
    expect(Object.keys(pkg.files).sort()).toEqual(['SKILL.md', 'references/guide.md'])
    expect(pkg.assets['references/deep/blob.bin'].content).toBe(Buffer.from([0, 1, 2, 255]).toString('base64'))
    expect(pkg.entries.map(entry => entry.path)).toEqual(['SKILL.md', 'references/deep/blob.bin', 'references/guide.md'])
    expect(vi.mocked(fs.opendirSync).mock.calls.filter(([path]) => String(path).startsWith(base))).toEqual([])
  })

  it('gives a stable revision even though every lstat reports a new inode', () => {
    const { base, file } = packaged()
    simulateAsar(base)
    const first = skillRevision(file)
    expect(skillRevision(file)).toBe(first)
    expect(readSkillPackage(file).revision).toBe(first)
    expect(() => assertSkillRevision(file, first)).not.toThrow()
  })

  it('still refuses a packaged source whose content changed while it was being read', () => {
    const { base, file } = packaged()
    simulateAsar(base)
    const first = skillRevision(file)
    fs.writeFileSync(file, '---\nname: office\n---\n# Office, edited and longer\n')
    expect(() => assertSkillRevision(file, first)).toThrow(/changed/)
  })

  it('keeps the bounded entry limit when listing an asar directory', () => {
    const { base, file } = packaged()
    for (let index = 0; index < 2001; index++) fs.writeFileSync(join(dirname(file), 'references', `f${index}.md`), 'x')
    simulateAsar(base)
    expect(() => readSkillPackage(file)).toThrow(/2000 entries/)
  })

  it('keeps the strict identity check for ordinary user directories', () => {
    const source = fixture('user-skill')
    const before = skillRevision(source)
    const stat = fs.statSync(source)
    fs.utimesSync(source, stat.atime, new Date(stat.mtimeMs + 5000))
    expect(skillRevision(source)).not.toBe(before)
    expect(vi.mocked(fs.opendirSync)).toHaveBeenCalled()
  })
})
