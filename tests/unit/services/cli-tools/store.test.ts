import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { strToU8, zipSync } from 'fflate'
import { CliToolError, CliToolStore, buildToolViews, cliSkillName } from '../../../../src/main/services/cli-tools'
import { defaultPayload, makeTempDir, removeTree, writePackage, type Files } from './helpers'

const silent = { log: () => undefined, error: () => undefined }
const ID = 'com.example.tool'

let dir: string
let pkgs: string
let root: string

function newStore(overrides: Partial<ConstructorParameters<typeof CliToolStore>[0]> = {}): CliToolStore {
  return new CliToolStore({
    root,
    runtimePath: process.execPath,
    runtimeNodeVersion: process.versions.node,
    log: silent,
    ...overrides,
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (err) {
    return err instanceof CliToolError ? err.code : `NOT_TYPED: ${String(err)}`
  }
  return undefined
}

function storeEntries(): string[] {
  const toolDir = join(root, 'store', ID)
  return existsSync(toolDir) ? readdirSync(toolDir).sort() : []
}

function stagingLeft(): string[] {
  const staging = join(root, 'staging')
  return existsSync(staging) ? readdirSync(staging) : []
}

beforeEach(() => {
  dir = makeTempDir()
  pkgs = join(dir, 'pkgs')
  root = join(dir, 'cli')
  mkdirSync(pkgs)
})

afterEach(() => {
  removeTree(dir)
})

describe('cli-tools store: import transaction', () => {
  it('installs v1 as current into a content-addressed read-only directory', async () => {
    const store = newStore()
    const result = await store.importPackage(writePackage(pkgs), { source: 'user-import' })
    expect(result).toMatchObject({ id: ID, version: '1.0.0', installed: true, current: '1.0.0', previous: null })

    const entries = storeEntries()
    const hex12 = Buffer.from(result.integrity.slice(7), 'base64').toString('hex').slice(0, 12)
    expect(entries).toEqual([`1.0.0-${hex12}`])
    const entry = join(root, 'store', ID, entries[0], 'payload', 'bin', 'tool.js')
    expect(statSync(entry).mode & 0o222).toBe(0)

    const state = await store.readState()
    expect(state.tools[ID].versions['1.0.0']).toMatchObject({ source: 'user-import', dir: `store/${ID}/${entries[0]}` })
    expect(stagingLeft()).toEqual([])
  })

  it('upgrades to v2 and keeps v1 installed as the previous version', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const v2 = await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    expect(v2).toMatchObject({ current: '2.0.0', previous: '1.0.0', installed: true })
    expect(storeEntries()).toHaveLength(2)
  })

  it('can import without activating', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const v2 = await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog', activate: false })
    expect(v2.current).toBe('1.0.0')
  })

  it('keeps v1 current and leaves no staging when v2 fails integrity', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const bad = writePackage(pkgs, { version: '2.0.0', integrity: `sha256-${Buffer.alloc(32).toString('base64')}` })
    expect(await codeOf(store.importPackage(bad, { source: 'catalog' }))).toBe('DIGEST_MISMATCH')

    const state = await store.readState()
    expect(state.tools[ID].current).toBe('1.0.0')
    expect(Object.keys(state.tools[ID].versions)).toEqual(['1.0.0'])
    expect(storeEntries()).toHaveLength(1)
    expect(stagingLeft()).toEqual([])
  })

  it('treats identical re-import as a no-op and refuses different content under the same version', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'user-import' })
    const again = await store.importPackage(writePackage(pkgs), { source: 'user-import' })
    expect(again.installed).toBe(false)

    const changed = writePackage(pkgs, { payload: defaultPayload('1.0.0', 'changed') })
    expect(await codeOf(store.importPackage(changed, { source: 'user-import' }))).toBe('VERSION_CONFLICT')
    expect(storeEntries()).toHaveLength(1)
  })

  it('checks an expected archive digest', async () => {
    const store = newStore()
    const file = writePackage(pkgs)
    expect(await codeOf(store.importPackage(file, { source: 'catalog', expectedArchiveSha256: 'ab'.repeat(32) })))
      .toBe('DIGEST_MISMATCH')
    expect(await store.readState()).toEqual({ schema: 1, tools: {} })
  })

  it('rejects a missing entry file and a missing guide', async () => {
    const store = newStore()
    const noEntry = writePackage(pkgs, { commands: [{ name: 'tool', entry: 'bin/missing.js' }] })
    expect(await codeOf(store.importPackage(noEntry, { source: 'user-import' }))).toBe('MANIFEST_INVALID')
    const noGuide = writePackage(pkgs, { manifest: { guide: 'guide/SKILL.md' } })
    expect(await codeOf(store.importPackage(noGuide, { source: 'user-import' }))).toBe('MANIFEST_INVALID')
    const withGuide = writePackage(pkgs, { manifest: { guide: 'guide/SKILL.md' }, extra: { 'guide/SKILL.md': '# Tool' } })
    expect((await store.importPackage(withGuide, { source: 'user-import' })).installed).toBe(true)
  })

  it('rejects a package for another platform or a newer runtime', async () => {
    const store = newStore({ platform: 'darwin', arch: 'arm64' })
    const other = writePackage(pkgs, { manifest: { platforms: ['win32-x64'] } })
    expect(await codeOf(store.importPackage(other, { source: 'catalog' }))).toBe('PLATFORM_UNSUPPORTED')
    const newer = writePackage(pkgs, { manifest: { runtime: { kind: 'halo-node', minNode: '999' } } })
    expect(await codeOf(store.importPackage(newer, { source: 'catalog' }))).toBe('RUNTIME_VERSION_UNSUPPORTED')
    const binary = writePackage(pkgs, { manifest: { runtime: { kind: 'binary' } } })
    expect(await codeOf(store.importPackage(binary, { source: 'catalog' }))).toBe('RUNTIME_KIND_UNSUPPORTED')
  })

  it('refuses a corrupt state file instead of resetting it', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'state.json'), '{not json')
    const store = newStore()
    expect(await codeOf(store.importPackage(writePackage(pkgs), { source: 'user-import' }))).toBe('STATE_CORRUPT')
    expect(readFileSync(join(root, 'state.json'), 'utf-8')).toBe('{not json')
    expect(storeEntries()).toEqual([])
  })
})

describe('cli-tools store: archive safety', () => {
  function rawZip(entries: Files): string {
    const data: Record<string, Uint8Array> = {}
    for (const [k, v] of Object.entries(entries)) data[k] = typeof v === 'string' ? strToU8(v) : v
    const file = join(pkgs, `raw-${Math.random().toString(36).slice(2)}.hcli`)
    writeFileSync(file, zipSync(data))
    return file
  }

  it('rejects entries that escape the package', async () => {
    const file = rawZip({ 'manifest.json': '{}', 'payload/../../evil.js': 'x' })
    expect(await codeOf(newStore().importPackage(file, { source: 'user-import' }))).toBe('PATH_UNSAFE')
    expect(existsSync(join(dir, 'evil.js'))).toBe(false)
  })

  it('rejects unknown top-level entries', async () => {
    const file = rawZip({ 'manifest.json': '{}', 'scripts/install.sh': 'x' })
    expect(await codeOf(newStore().importPackage(file, { source: 'user-import' }))).toBe('PACKAGE_INVALID')
  })

  it('rejects case-insensitive collisions', async () => {
    const file = rawZip({ 'manifest.json': '{}', 'payload/A.js': 'x', 'payload/a.js': 'y' })
    expect(await codeOf(newStore().importPackage(file, { source: 'user-import' }))).toBe('PATH_UNSAFE')
  })

  it('enforces the entry limit and the expanded size limit', async () => {
    const many: Files = { 'manifest.json': '{}' }
    for (let i = 0; i < 6; i++) many[`payload/f${i}.js`] = 'x'
    const limits = { maxArchiveBytes: 1 << 20, maxExtractedBytes: 1 << 20, maxEntries: 5 }
    expect(await codeOf(newStore({ archiveLimits: limits }).importPackage(rawZip(many), { source: 'user-import' })))
      .toBe('PACKAGE_INVALID')
    const big = rawZip({ 'manifest.json': '{}', 'payload/big.js': 'x'.repeat(4096) })
    const small = { maxArchiveBytes: 1 << 20, maxExtractedBytes: 1024, maxEntries: 100 }
    expect(await codeOf(newStore({ archiveLimits: small }).importPackage(big, { source: 'user-import' })))
      .toBe('PACKAGE_INVALID')
  })

  it('rejects a file that is not a zip and an archive without a manifest', async () => {
    const notZip = join(pkgs, 'x.hcli')
    writeFileSync(notZip, 'plain text')
    expect(await codeOf(newStore().importPackage(notZip, { source: 'user-import' }))).toBe('PACKAGE_INVALID')
    expect(await codeOf(newStore().importPackage(rawZip({ 'payload/a.js': 'x' }), { source: 'user-import' })))
      .toBe('MANIFEST_INVALID')
  })
})

describe('cli-tools store: pure-JS rule', () => {
  const base = (): Files => defaultPayload('1.0.0')

  it.each([
    ['a compiled addon', { 'build/Release/addon.node': 'x' }],
    ['binding.gyp', { 'binding.gyp': '{}' }],
    ['an install script', { 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', scripts: { postinstall: 'node x' } }) }],
    ['gypfile', { 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', gypfile: true }) }],
    ['an os-pinned package', { 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', os: ['darwin'] }) }],
    ['per-platform optional packages', {
      'package.json': JSON.stringify({ name: 'tool', optionalDependencies: { '@scope/tool-darwin-arm64': '1.0.0' } }),
    }],
    ['an ELF image', { 'bin/helper': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0]) }],
    ['a Mach-O image', { 'bin/helper': new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0]) }],
    ['a PE image', { 'bin/helper.exe': new Uint8Array([0x4d, 0x5a, 0x90, 0]) }],
  ])('rejects %s', async (_label, extra) => {
    const file = writePackage(pkgs, { payload: { ...base(), ...extra } })
    expect(await codeOf(newStore().importPackage(file, { source: 'user-import' }))).toBe('NATIVE_NOT_ALLOWED')
    expect(stagingLeft()).toEqual([])
  })

  it('accepts ordinary scripts and non-platform optional dependencies', async () => {
    const payload = {
      ...base(),
      'package.json': JSON.stringify({ name: 'tool', scripts: { test: 'x', prepare: 'y' }, optionalDependencies: { chalk: '5' } }),
      'README.md': 'MZ is just text here',
    }
    expect((await newStore().importPackage(writePackage(pkgs, { payload }), { source: 'user-import' })).installed).toBe(true)
  })
})

function launcher(command = 'tool', id = ID): string {
  return join(root, 'tools', id, 'bin', command)
}

describe('cli-tools store: launchers per tool', () => {
  it('writes launchers for the current version and swaps them in on an upgrade, keeping the installation', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const first = await store.readInstallRecord(ID)
    expect(first).toMatchObject({
      schema: 1, toolId: ID, version: '1.0.0', installId: expect.stringMatching(/^[0-9a-f]{6}$/),
      commands: [{ name: 'tool', launcher: launcher() }],
    })
    expect((await store.readState()).tools[ID].installId).toBe(first!.installId)
    expect(readFileSync(launcher(), 'utf-8')).toContain('1.0.0-')

    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    expect(await store.readInstallRecord(ID)).toMatchObject({ version: '2.0.0', installId: first!.installId })
    expect(readFileSync(launcher(), 'utf-8')).toContain('2.0.0-')
    expect(readdirSync(join(root, 'tools'))).toEqual([ID])
  })

  it('leaves launchers alone when nothing they are written from changed', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const written = statSync(join(root, 'tools', ID, 'install.json')).mtimeMs
    await store.syncLaunchers()
    await store.importPackage(writePackage(pkgs, { id: 'com.example.other', commands: [{ name: 'other', entry: 'bin/tool.js' }] }), { source: 'catalog' })
    expect(statSync(join(root, 'tools', ID, 'install.json')).mtimeMs).toBe(written)
    expect(readdirSync(join(root, 'tools')).sort()).toEqual(['com.example.other', ID])
  })

  it('takes the launchers of a revoked or disabled tool away and brings them back for the same installation', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const { installId } = (await store.readInstallRecord(ID))!
    await store.setRevoked(ID, true)
    expect(existsSync(join(root, 'tools', ID))).toBe(false)
    await store.setRevoked(ID, false)
    await store.setDisabled(ID, true)
    expect(existsSync(join(root, 'tools', ID))).toBe(false)
    await store.setDisabled(ID, false)
    expect((await store.readInstallRecord(ID))?.installId).toBe(installId)
  })

  it('gives a tool installed again after removal a new installation id', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'user-import' })
    const { installId } = (await store.readInstallRecord(ID))!
    await store.removeTool(ID)
    expect(existsSync(join(root, 'tools', ID))).toBe(false)
    await store.importPackage(writePackage(pkgs, { version: '1.1.0' }), { source: 'user-import' })
    expect((await store.readInstallRecord(ID))?.installId).not.toBe(installId)
  })

  it('writes no launchers while the runtime is missing, without failing the import', async () => {
    const store = newStore({ runtimePath: join(dir, 'no-such-runtime') })
    expect((await store.importPackage(writePackage(pkgs), { source: 'catalog' })).installed).toBe(true)
    expect(existsSync(join(root, 'tools'))).toBe(false)
  })

  it('removes the per-session views and pins of earlier builds', async () => {
    mkdirSync(join(root, 'views', 'abc', 'bin'), { recursive: true })
    mkdirSync(join(root, 'locks'), { recursive: true })
    writeFileSync(join(root, 'locks', 'p1.json'), '{}')
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.syncLaunchers()
    expect(existsSync(join(root, 'views'))).toBe(false)
    expect(existsSync(join(root, 'locks'))).toBe(false)
    expect(existsSync(launcher())).toBe(true)
  })

  it('records where the skill of an installation went, and carries it across version changes', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const { installId } = (await store.readInstallRecord(ID))!
    const skill = { name: `tool-com-example-tool-${installId}`, path: join(dir, 'skills', 'SKILL.md') }
    expect(await store.recordSkillLocation(ID, 'ffffff', skill)).toBe(false)
    expect(await store.recordSkillLocation(ID, installId, skill)).toBe(true)
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    expect((await store.readInstallRecord(ID))?.skill).toEqual(skill)
    expect(await store.recordSkillLocation(ID, installId, null)).toBe(true)
    expect((await store.readInstallRecord(ID))?.skill).toBeUndefined()
  })
})

describe('cli-tools store: removal, rollback and verification', () => {
  it('refuses the current version, deletes one never launched at once and defers one this process launched', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    await store.importPackage(writePackage(pkgs, { version: '3.0.0' }), { source: 'catalog', activate: false })

    expect(await codeOf(store.removeVersion(ID, '2.0.0'))).toBe('IN_USE')
    expect(await store.removeVersion(ID, '3.0.0')).toEqual({ deferred: false })
    expect(await store.removeVersion(ID, '1.0.0')).toEqual({ deferred: true })
    expect(Object.keys((await store.readState()).tools[ID].versions)).toEqual(['2.0.0'])
    // A command started from 1.0.0 in this process may still run.
    expect(storeEntries()).toHaveLength(2)
    expect((await store.readState()).pendingCleanup).toHaveLength(1)

    const next = newStore()
    expect(await next.collectPendingCleanup()).toBe(1)
    expect(storeEntries()).toHaveLength(1)
    expect((await next.readState()).pendingCleanup).toBeUndefined()
    expect(await codeOf(next.removeVersion(ID, '1.0.0'))).toBe('NOT_FOUND')
  })

  it('rolls back to an installed version', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    expect(await store.activateVersion(ID, '1.0.0')).toEqual({ current: '1.0.0', previous: '2.0.0' })
    expect(readFileSync(launcher(), 'utf-8')).toContain('1.0.0-')
    expect(await codeOf(store.activateVersion(ID, '9.9.9'))).toBe('NOT_FOUND')
  })

  it('detects tampering with an installed version', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    expect(await store.verifyVersion(ID, '1.0.0')).toBe(true)
    const entry = join(root, 'store', ID, storeEntries()[0], 'payload', 'bin', 'tool.js')
    chmodSync(entry, 0o644)
    writeFileSync(entry, 'console.log("tampered")\n')
    expect(await store.verifyVersion(ID, '1.0.0')).toBe(false)
  })
})

describe('cli-tools store: launchers', () => {
  it('writes .cmd plus an sh twin on Windows', async () => {
    const store = newStore({ platform: 'win32', arch: 'x64', runtimePath: process.execPath })
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const binDir = join(root, 'tools', ID, 'bin')
    expect(readdirSync(binDir).sort()).toEqual(['tool', 'tool.cmd'])
    expect((await store.readInstallRecord(ID))?.commands).toEqual([{ name: 'tool', launcher: launcher(), cmdLauncher: `${launcher()}.cmd` }])
    const cmd = readFileSync(join(binDir, 'tool.cmd'), 'utf-8')
    expect(cmd).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(cmd).toContain('set "NODE_PATH="\r\n')
    expect(readFileSync(join(binDir, 'tool'), 'utf-8')).toContain('unset NODE_PATH\n')
    expect(cmd).toContain(`--require "${join(root, 'tools', ID, 'argv-preload.cjs')}"`)
    expect(readFileSync(join(root, 'tools', ID, 'argv-preload.cjs'), 'utf-8')).toContain('process.defaultApp = true')
    expect(cmd).toContain('%*')
    expect(cmd).toContain('exit /b %ERRORLEVEL%')
    expect(cmd.includes('\r\n')).toBe(true)
  })

  it('reaches a runtime in a non-ASCII folder through a link, so the .cmd holds only ASCII', async () => {
    const runtimeDir = join(dir, 'Halo内测版本')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'Halo.exe'), '')
    const nonAsciiRoot = join(dir, '张三', 'cli')
    const store = newStore({ root: nonAsciiRoot, platform: 'win32', arch: 'x64', runtimePath: join(runtimeDir, 'Halo.exe') })
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const cmd = readFileSync(join(nonAsciiRoot, 'tools', ID, 'bin', 'tool.cmd'), 'utf-8')
    expect(/^[\x00-\x7f]*$/.test(cmd)).toBe(true)
    const runtimeRef = /"%~dp0([^"]*Halo\.exe)"/.exec(cmd)?.[1]
    expect(runtimeRef).toMatch(/^\.\.\\\.\.\\\.\.\\runtime\\[0-9a-f]{16}\\Halo\.exe$/)
    const link = join(nonAsciiRoot, 'runtime', runtimeRef!.split('\\')[4])
    expect(realpathSync(link)).toBe(realpathSync(runtimeDir))
    expect(cmd).toContain('--require "%~dp0..\\argv-preload.cjs"')

    // New launchers reuse the link; a wrong one is replaced, never followed.
    rmSync(link)
    symlinkSync(dir, link)
    await store.importPackage(writePackage(pkgs, { version: '1.1.0' }), { source: 'catalog' })
    expect(realpathSync(link)).toBe(realpathSync(runtimeDir))
    expect(existsSync(join(dir, '张三'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('runs a tool through the sh launcher with args, cwd, stdin and exit code', async () => {
    const payload: Files = {
      'bin/tool.js': [
        "let input = ''",
        "process.stdin.on('data', d => { input += d })",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ args: process.argv.slice(2), script: process.argv[1], defaultApp: process.defaultApp, cwd: process.cwd(), input, asNode: process.env.ELECTRON_RUN_AS_NODE, nodePath: process.env.NODE_PATH ?? '' }))",
        '  process.exit(7)',
        '})',
        '',
      ].join('\n'),
    }
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { payload }), { source: 'user-import' })
    const work = join(dir, "work dir 'quoted'")
    mkdirSync(work)
    const result = spawnSync(launcher(), ['a b', '--flag=$HOME', "it's"], {
      cwd: work,
      input: 'from-stdin',
      encoding: 'utf-8',
      windowsHide: true,
      env: { PATH: '/usr/bin:/bin', NODE_PATH: join(dir, 'inherited-modules') },
    })
    expect(result.status).toBe(7)
    const out = JSON.parse(result.stdout.trim())
    expect(out).toEqual({
      args: ['a b', '--flag=$HOME', "it's"],
      script: join(root, 'store', ID, storeEntries()[0], 'payload', 'bin', 'tool.js'),
      defaultApp: true,
      cwd: realpathSync(work),
      input: 'from-stdin',
      asNode: '1',
      nodePath: '',
    })
  })
})

describe('cli-tools store: tool skills', () => {
  const GUIDE = '---\ndescription: Query example tickets.\nallowed-tools: Bash(*)\n---\n# Example\nRun `tool list`.\n'

  function guidedPackage(spec: Parameters<typeof writePackage>[1] = {}): string {
    return writePackage(pkgs, {
      ...spec,
      manifest: { name: 'Example', description: 'From the manifest.', guide: 'guide/SKILL.md', ...spec?.manifest },
      extra: { 'guide/SKILL.md': GUIDE, ...spec?.extra },
    })
  }

  async function skillOf(store: CliToolStore, toolId = ID) {
    return (await store.readCurrentToolSkills()).skills.find(skill => skill.toolId === toolId)?.describe()
  }

  function overrideOf(content: string, revision: number) {
    return { revision, sha256: createHash('sha256').update(content).digest('hex'), content, signature: null }
  }

  it('names the installation and carries the launcher path and the guide itself', async () => {
    const store = newStore()
    const file = guidedPackage()
    expect((await store.previewPackage(file)).skill).toEqual({ name: cliSkillName('tool', ID, ''), description: 'Query example tickets.', source: 'package' })
    await store.importPackage(file, { source: 'user-import' })
    const { installId } = (await store.readInstallRecord(ID))!
    const skill = await skillOf(store)
    expect(Object.keys(skill!)).toEqual(['toolId', 'installId', 'name', 'description', 'body'])
    expect(skill).toMatchObject({
      toolId: ID, installId, name: cliSkillName('tool', ID, installId),
      description: 'Companion skill for the tool command-line tool. Query example tickets.',
    })
    expect(skill!.name).toBe(`tool-com-example-tool-${installId}`)
    expect(skill!.body).toContain(`\`${launcher()}\``)
    expect(skill!.body).toContain('Run `tool list`.')
    expect(skill!.body).not.toMatch(/allowed-tools|HALO_CLI_TOOLS_BIN|TOOLS\.md/)
  })

  it('falls back to the package description, then to a generated line', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { manifest: { description: 'From the manifest.' } }), { source: 'user-import' })
    await store.importPackage(writePackage(pkgs, { id: 'com.example.other', commands: [{ name: 'other', entry: 'bin/tool.js' }] }), { source: 'user-import' })
    const state = await store.readState()
    const skills = await store.describeToolSkills(state)
    expect(skills).toEqual({
      [ID]: { name: cliSkillName('tool', ID, state.tools[ID].installId!), description: 'From the manifest.', source: 'manifest' },
      'com.example.other': {
        name: cliSkillName('other', 'com.example.other', state.tools['com.example.other'].installId!),
        description: 'Use the com.example.other command-line tool.', source: 'default',
      },
    })
    expect((await store.readCurrentToolSkills()).skills.map(skill => skill.toolId)).toEqual(['com.example.other', ID])
    expect((await skillOf(store, 'com.example.other'))!.body).toContain('Run the tool with `--help`')
  })

  it('takes an administrator guide into the skill and keeps the name', async () => {
    const store = newStore()
    await store.importPackage(guidedPackage(), { source: 'catalog' })
    const integrity = (await store.readState()).tools[ID].versions['1.0.0'].integrity
    const before = await skillOf(store)
    const { skills: [{ fingerprint }] } = await store.readCurrentToolSkills()

    const full = '---\ndescription: Use for example tickets.\n---\n# Usage notes\nRun `tool --check` first.\n'
    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: ['1.0.0'], guides: { '1.0.0': { integrity, override: overrideOf(full, 1) } } }])
    const after = await skillOf(store)
    expect(after).toMatchObject({ name: before!.name, description: 'Companion skill for the tool command-line tool. Use for example tickets.' })
    expect(after!.body).toContain('Run `tool --check` first.')
    expect(after!.body).not.toContain('Run `tool list`.')
    expect((await store.readCurrentToolSkills()).skills[0].fingerprint).not.toBe(fingerprint)
    expect((await store.describeToolSkills(await store.readState()))[ID]).toMatchObject({ description: 'Use for example tickets.', source: 'admin' })
  })

  it.skipIf(process.platform === 'win32')('writes a skill for a registered program', async () => {
    const file = join(dir, 'mytool.sh')
    writeFileSync(file, '#!/bin/sh\necho hi\n')
    chmodSync(file, 0o755)
    const store = newStore()
    await store.registerExternal({ path: file, interpreter: null, command: 'mytool', name: 'My tool' })
    const skill = await skillOf(store, 'external.mytool')
    expect(skill).toMatchObject({ description: 'Companion skill for the mytool command-line tool. Use the My tool command-line tool.' })
    expect(skill!.body).toContain(launcher('mytool', 'external.mytool'))
    expect(spawnSync(launcher('mytool', 'external.mytool'), [], { encoding: 'utf-8' }).stdout).toBe('hi\n')
  })

  it('shows the current skill in the management view', async () => {
    const store = newStore()
    await store.importPackage(guidedPackage(), { source: 'user-import' })
    const state = await store.readState()
    const [view] = buildToolViews(state, new Set(), await store.describeToolSkills(state))
    expect(view.skill).toEqual({ name: cliSkillName('tool', ID, state.tools[ID].installId!), description: 'Query example tickets.', source: 'package' })
    expect(buildToolViews(state)[0].skill).toBeUndefined()
  })
})
