import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { strToU8, zipSync } from 'fflate'
import { CliToolError, CliToolStore } from '../../../../src/main/services/cli-tools'
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

describe('cli-tools store: execution pins', () => {
  it('keeps a running execution on v1 after upgrade while the next one gets v2', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const first = await store.pinExecution({ executionId: 'run-1', entry: 'chat', engine: 'claude' })
    expect(first.reused).toBe(false)
    expect(first.lock.tools).toEqual([expect.objectContaining({ id: ID, version: '1.0.0' })])

    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    const again = await store.pinExecution({ executionId: 'run-1', entry: 'chat', engine: 'claude' })
    expect(again.reused).toBe(true)
    expect(again.binDir).toBe(first.binDir)
    expect(again.lock.tools[0].version).toBe('1.0.0')

    const next = await store.pinExecution({ executionId: 'run-2', entry: 'automation', engine: 'dsh' })
    expect(next.lock.tools[0].version).toBe('2.0.0')
    expect(next.binDir).not.toBe(first.binDir)
    expect(readFileSync(join(next.binDir!, 'tool'), 'utf-8')).toContain('2.0.0-')
  })

  it('shares one view between executions with the same tool set', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const a = await store.pinExecution({ executionId: 'a', entry: 'chat', engine: 'claude' })
    const b = await store.pinExecution({ executionId: 'b', entry: 'team', engine: 'claude' })
    expect(a.binDir).toBe(b.binDir)
  })

  it('exposes a conflicting command as halo-<name>', async () => {
    const userBin = join(dir, 'user-bin')
    mkdirSync(userBin)
    writeFileSync(join(userBin, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    const store = newStore({ platform: 'linux' })
    await store.importPackage(writePackage(pkgs), { source: 'user-import' })
    const pinned = await store.pinExecution({ executionId: 'x', entry: 'chat', engine: 'claude', basePath: userBin })
    expect(pinned.lock.commands).toEqual([expect.objectContaining({ command: 'tool', exposedAs: 'halo-tool', conflict: true })])
    expect(existsSync(join(pinned.binDir!, 'halo-tool'))).toBe(true)
    expect(existsSync(join(pinned.binDir!, 'tool'))).toBe(false)
  })

  it('excludes revoked tools from new executions only', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const before = await store.pinExecution({ executionId: 'before', entry: 'chat', engine: 'claude' })
    await store.setRevoked(ID, true)
    const after = await store.pinExecution({ executionId: 'after', entry: 'chat', engine: 'claude' })
    expect(after.lock.tools).toEqual([])
    expect(after.binDir).toBeNull()
    expect((await store.pinExecution({ executionId: 'before', entry: 'chat', engine: 'claude' })).binDir).toBe(before.binDir)
  })

  it('reports a missing runtime', async () => {
    const store = newStore({ runtimePath: join(dir, 'no-such-runtime') })
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    expect(await codeOf(store.pinExecution({ executionId: 'x', entry: 'chat', engine: 'claude' }))).toBe('RUNTIME_MISSING')
  })

  it('stores locks for unsafe execution ids under a hash', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.pinExecution({ executionId: '../../escape', entry: 'chat', engine: 'claude' })
    expect(readdirSync(join(root, 'locks'))[0]).toMatch(/^x-[0-9a-f]{32}\.json$/)
    expect((await store.readExecutionLock('../../escape'))?.executionId).toBe('../../escape')
  })
})

describe('cli-tools store: pins held by a process', () => {
  it('pins nothing when no tool is usable', async () => {
    const store = newStore()
    expect(await store.pinCurrent({ holder: 'p1', entry: 'other', engine: 'claude' })).toBeNull()
    expect(existsSync(join(root, 'locks'))).toBe(false)
  })

  it('reuses one lock per tool set and keeps the earlier set pinned after an update', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const first = await store.pinCurrent({ holder: 'p1', entry: 'other', engine: 'claude' })
    const again = await store.pinCurrent({ holder: 'p1', entry: 'other', engine: 'codex' })
    expect(first?.reused).toBe(false)
    expect(again?.reused).toBe(true)
    expect(again?.binDir).toBe(first?.binDir)
    expect(first?.lock).toMatchObject({ holder: 'p1', entry: 'other', executionId: `p1-other-${first?.lock.viewKey}` })

    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    const next = await store.pinCurrent({ holder: 'p1', entry: 'other', engine: 'claude' })
    expect(next?.lock.tools[0].version).toBe('2.0.0')
    expect(next?.binDir).not.toBe(first?.binDir)
    expect(readdirSync(join(root, 'locks'))).toHaveLength(2)
    // The earlier set is still pinned: its record goes, its files wait for cleanup.
    expect(await store.removeVersion(ID, '1.0.0')).toEqual({ deferred: true })
    expect(storeEntries()).toHaveLength(2)
  })

  it('releases the locks of other holders only', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.pinCurrent({ holder: 'old', entry: 'other', engine: 'claude' })
    await store.pinExecution({ executionId: 'legacy', entry: 'chat', engine: 'claude' })
    await store.pinCurrent({ holder: 'now', entry: 'terminal', engine: 'terminal' })
    expect(await store.releaseOtherHolders('now')).toBe(2)
    const left = readdirSync(join(root, 'locks')).map(name => JSON.parse(readFileSync(join(root, 'locks', name), 'utf-8')).holder)
    expect(left).toEqual(['now'])
    expect(await store.releaseOtherHolders('now')).toBe(0)
  })

  it('writes TOOLS.md describing each command of the view', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, {
      extra: { 'guide/README.md': '# guide\n' },
      manifest: { guide: 'guide/README.md', sideEffects: 'read-only', auth: { method: 'none' } },
    }), { source: 'catalog' })
    const pin = await store.pinCurrent({ holder: 'p1', entry: 'other', engine: 'claude' })
    const guide = readFileSync(join(pin!.binDir!, '..', 'TOOLS.md'), 'utf-8')
    expect(guide).toContain('| `tool` | com.example.tool | 1.0.0 | read-only | none |')
    const guidePath = /\| `([^`]+README\.md)` \|/.exec(guide)?.[1]
    expect(guidePath && readFileSync(guidePath, 'utf-8')).toBe('# guide\n')
    expect(guide).toContain('halo-<name>')
  })
})

describe('cli-tools store: removal, rollback and verification', () => {
  it('refuses the current version, defers pinned files, and cleans them once released', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.pinExecution({ executionId: 'run-1', entry: 'chat', engine: 'claude' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })

    expect(await codeOf(store.removeVersion(ID, '2.0.0'))).toBe('IN_USE')
    expect(await store.removeVersion(ID, '1.0.0')).toEqual({ deferred: true })
    expect(Object.keys((await store.readState()).tools[ID].versions)).toEqual(['2.0.0'])
    // Still pinned by run-1: the files stay and the pin still resolves.
    expect(storeEntries()).toHaveLength(2)
    expect((await store.readState()).pendingCleanup).toHaveLength(1)
    expect((await store.pinExecution({ executionId: 'run-1', entry: 'chat', engine: 'claude' })).reused).toBe(true)
    expect(await store.collectPendingCleanup()).toBe(0)
    expect(storeEntries()).toHaveLength(2)

    expect(await store.releaseExecution('run-1')).toBe(true)
    expect(await store.collectPendingCleanup()).toBe(1)
    expect(storeEntries()).toHaveLength(1)
    expect((await store.readState()).pendingCleanup).toBeUndefined()
    expect(await codeOf(store.removeVersion(ID, '1.0.0'))).toBe('NOT_FOUND')
  })

  it('prunes views no lock refers to', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.pinExecution({ executionId: 'a', entry: 'chat', engine: 'claude' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    await store.pinExecution({ executionId: 'b', entry: 'chat', engine: 'claude' })
    await store.releaseExecution('a')
    expect(await store.pruneViews()).toBe(1)
    expect(readdirSync(join(root, 'views'))).toHaveLength(1)
  })

  it('rolls back to an installed version', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    expect(await store.activateVersion(ID, '1.0.0')).toEqual({ current: '1.0.0', previous: '2.0.0' })
    const pinned = await store.pinExecution({ executionId: 'r', entry: 'chat', engine: 'claude' })
    expect(pinned.lock.tools[0].version).toBe('1.0.0')
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
    const pinned = await store.pinExecution({ executionId: 'w', entry: 'chat', engine: 'claude' })
    const files = readdirSync(pinned.binDir!).sort()
    expect(files).toEqual(['tool', 'tool.cmd'])
    const cmd = readFileSync(join(pinned.binDir!, 'tool.cmd'), 'utf-8')
    expect(cmd).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(cmd).toContain(`--require "${join(pinned.binDir!, '..', 'argv-preload.cjs')}"`)
    expect(readFileSync(join(pinned.binDir!, '..', 'argv-preload.cjs'), 'utf-8')).toContain('process.defaultApp = true')
    expect(cmd).toContain('%*')
    expect(cmd).toContain('exit /b %ERRORLEVEL%')
    expect(cmd.includes('\r\n')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('runs a tool through the sh launcher with args, cwd, stdin and exit code', async () => {
    const payload: Files = {
      'bin/tool.js': [
        "let input = ''",
        "process.stdin.on('data', d => { input += d })",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ args: process.argv.slice(2), script: process.argv[1], defaultApp: process.defaultApp, cwd: process.cwd(), input, asNode: process.env.ELECTRON_RUN_AS_NODE }))",
        '  process.exit(7)',
        '})',
        '',
      ].join('\n'),
    }
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { payload }), { source: 'user-import' })
    const pinned = await store.pinExecution({ executionId: 'run', entry: 'chat', engine: 'claude' })
    const work = join(dir, "work dir 'quoted'")
    mkdirSync(work)
    const result = spawnSync(join(pinned.binDir!, 'tool'), ['a b', '--flag=$HOME', "it's"], {
      cwd: work,
      input: 'from-stdin',
      encoding: 'utf-8',
      windowsHide: true,
      env: { PATH: '/usr/bin:/bin' },
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
    })
  })
})
