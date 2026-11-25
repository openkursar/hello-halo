import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { delimiter, join } from 'path'
import { createHash } from 'crypto'
import { CliToolStore } from '../../../../src/main/services/cli-tools'
import type { CatalogPackageExpectation } from '../../../../src/main/services/cli-tools'
import { buildManifest, makeTempDir, removeTree, writePackage } from './helpers'

const ID = 'com.example.tool'

let dir: string
let root: string
let presetDir: string
let pkgs: string

type Host = typeof import('../../../../src/main/services/cli-tools/host')

/** A fresh module instance stands for a fresh app process. */
async function startHost(options: { presetDir?: string | null } = {}): Promise<Host> {
  vi.resetModules()
  const host = await import('../../../../src/main/services/cli-tools/host')
  host.initCliTools({
    root,
    runtimePath: process.execPath,
    presetDir: options.presetDir === undefined ? presetDir : options.presetDir,
  })
  return host
}

function directStore(): CliToolStore {
  return new CliToolStore({
    root,
    runtimePath: process.execPath,
    runtimeNodeVersion: process.versions.node,
    log: { log: () => undefined, error: () => undefined },
  })
}

function preset(version: string): string {
  const file = writePackage(pkgs, { version })
  const target = join(presetDir, `tool-${version}.hcli`)
  writeFileSync(target, readFileSync(file))
  return target
}

beforeEach(() => {
  dir = makeTempDir()
  root = join(dir, 'cli')
  presetDir = join(dir, 'preset')
  pkgs = join(dir, 'pkgs')
  mkdirSync(presetDir)
  mkdirSync(pkgs)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTree(dir)
})

describe('cli-tools host: environments', () => {
  it('leaves an environment unchanged before init and when no tool exists', async () => {
    vi.resetModules()
    const bare = await import('../../../../src/main/services/cli-tools/host')
    const env: Record<string, string | undefined> = { PATH: '/usr/bin', HALO_CLI_TOOLS_BIN: '/stale' }
    expect(await bare.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })).toBeNull()
    expect(env).toEqual({ PATH: '/usr/bin' })

    const host = await startHost()
    const empty: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(empty, { entry: 'other', engine: 'claude' })).toBeNull()
    expect(empty).toEqual({ PATH: '/usr/bin' })
  })

  it('imports a bundled tool on first use and appends its launchers after the existing PATH', async () => {
    preset('1.0.0')
    const host = await startHost()
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    const binDir = await host.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })
    expect(binDir).toBeTruthy()
    expect(env.PATH).toBe(`/usr/bin${delimiter}${binDir}`)
    expect(env[host.CLI_TOOLS_BIN_ENV]).toBe(binDir)
    expect(existsSync(join(binDir!, process.platform === 'win32' ? 'tool.cmd' : 'tool'))).toBe(true)
    expect(existsSync(join(binDir!, '..', 'TOOLS.md'))).toBe(true)
    const state = await directStore().readState()
    expect(state.tools[ID]).toMatchObject({ current: '1.0.0' })
    expect(state.tools[ID].versions['1.0.0'].source).toBe('preset')
    expect(existsSync(join(root, 'preset-stamp.json'))).toBe(true)
  })

  it('keeps the same directory until the tool set changes', async () => {
    preset('1.0.0')
    const host = await startHost()
    const first = await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'other', engine: 'claude' })
    const second = await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'terminal', engine: 'terminal' })
    expect(second).toBe(first)

    await directStore().importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'user-import' })
    const third = await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'other', engine: 'codex' })
    expect(third).not.toBe(first)
    expect(readFileSync(join(third!, '..', 'TOOLS.md'), 'utf-8')).toContain('2.0.0')
    // The earlier set stays pinned while this process lives.
    expect(existsSync(first!)).toBe(true)
  })

  it('exposes a command the user already has as halo-<name> and leaves theirs first on PATH', async () => {
    const userBin = join(dir, 'user-bin')
    mkdirSync(userBin)
    writeFileSync(join(userBin, process.platform === 'win32' ? 'tool.cmd' : 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    preset('1.0.0')
    const host = await startHost()
    const env: Record<string, string | undefined> = { PATH: userBin }
    const binDir = await host.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })
    expect(env.PATH!.split(delimiter)[0]).toBe(userBin)
    expect(readdirSync(binDir!).some(name => name.startsWith('halo-tool'))).toBe(true)
    expect(readdirSync(binDir!).some(name => name === 'tool' || name === 'tool.cmd')).toBe(false)
  })

  it('degrades to no tools when the runtime is missing', async () => {
    preset('1.0.0')
    vi.resetModules()
    const host = await import('../../../../src/main/services/cli-tools/host')
    host.initCliTools({ root, runtimePath: join(dir, 'missing-runtime'), presetDir })
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })).toBeNull()
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})

describe('cli-tools host: bundled tools across launches', () => {
  it('releases the pins of the previous process on start', async () => {
    preset('1.0.0')
    const before = await startHost()
    await before.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'other', engine: 'claude' })
    expect(readdirSync(join(root, 'locks'))).toHaveLength(1)

    await new Promise(resolve => setTimeout(resolve, 5))
    const after = await startHost()
    await after.prepareCliTools()
    expect(existsSync(join(root, 'locks')) ? readdirSync(join(root, 'locks')) : []).toEqual([])
  })

  it('upgrades a bundled version but keeps a version the user chose', async () => {
    preset('1.0.0')
    await (await startHost()).prepareCliTools()
    rmPreset()
    preset('1.1.0')
    await (await startHost()).prepareCliTools()
    expect((await directStore().readState()).tools[ID].current).toBe('1.1.0')

    await directStore().importPackage(writePackage(pkgs, { version: '3.0.0' }), { source: 'user-import' })
    rmPreset()
    preset('2.0.0')
    await (await startHost()).prepareCliTools()
    const tool = (await directStore().readState()).tools[ID]
    expect(tool.current).toBe('3.0.0')
    expect(Object.keys(tool.versions).sort()).toEqual(['1.0.0', '1.1.0', '2.0.0', '3.0.0'])
  })

  it('retries a failed bundled package on the next launch and skips an unchanged directory', async () => {
    preset('1.0.0')
    writeFileSync(join(presetDir, 'broken.hcli'), 'not a zip')
    await (await startHost()).prepareCliTools()
    expect(existsSync(join(root, 'preset-stamp.json'))).toBe(false)
    expect((await directStore().readState()).tools[ID].current).toBe('1.0.0')

    rmPreset('broken.hcli')
    await (await startHost()).prepareCliTools()
    const stamp = readFileSync(join(root, 'preset-stamp.json'), 'utf-8')
    expect(JSON.parse(stamp).files).toHaveLength(1)

    const importSpy = vi.spyOn(CliToolStore.prototype, 'importPackage')
    await (await startHost()).prepareCliTools()
    expect(importSpy).not.toHaveBeenCalled()
  })

  it('decides activation from the version that was current before the import', async () => {
    const host = await startHost({ presetDir: null })
    const tool = (current: string | null, source: string, autoInstall = false) => ({
      tools: { [ID]: { current, revoked: false, versions: current ? { [current]: { source } } : {}, ...(autoInstall ? { autoInstall: true } : {}) } },
    }) as never
    expect(host.shouldActivatePreset({ tools: {} } as never, ID, '1.0.0')).toBe(true)
    expect(host.shouldActivatePreset(tool(null, 'preset'), ID, '1.0.0')).toBe(true)
    expect(host.shouldActivatePreset(tool('1.0.0', 'preset'), ID, '1.1.0')).toBe(true)
    expect(host.shouldActivatePreset(tool('1.0.0', 'user-import'), ID, '2.0.0')).toBe(false)
    expect(host.shouldActivatePreset(tool('1.0.0', 'catalog'), ID, '2.0.0')).toBe(false)
    // A newer installer overtakes an older delivered version, never a newer one.
    expect(host.shouldActivatePreset(tool('1.0.0', 'catalog', true), ID, '2.0.0')).toBe(true)
    expect(host.shouldActivatePreset(tool('3.0.0', 'catalog', true), ID, '2.0.0')).toBe(false)
  })
})

describe('cli-tools host: administrator catalog', () => {
  function sha256(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  }

  function expectation(file: string, version: string, overrides: Partial<CatalogPackageExpectation> = {}) {
    return {
      id: ID,
      version,
      archiveSha256: sha256(file),
      integrity: buildManifest({ version }).integrity as string,
      ...overrides,
    }
  }

  it('reports no state and refuses an install before the host is initialized', async () => {
    vi.resetModules()
    const bare = await import('../../../../src/main/services/cli-tools/host')
    expect(await bare.readCliToolState()).toBeNull()
    expect(await bare.applyCatalogRevocations({ [ID]: true })).toEqual([])
    const file = writePackage(pkgs, { version: '1.0.0' })
    await expect(bare.installCatalogPackage(file, expectation(file, '1.0.0'))).rejects.toMatchObject({ code: 'RUNTIME_MISSING' })
  })

  it('installs a verified catalog package as the current version over a bundled one', async () => {
    preset('1.0.0')
    const host = await startHost()
    const file = writePackage(pkgs, { version: '1.1.0' })
    const result = await host.installCatalogPackage(file, expectation(file, '1.1.0'))
    expect(result).toMatchObject({ id: ID, version: '1.1.0' })

    const state = await host.readCliToolState()
    expect(state!.tools[ID].current).toBe('1.1.0')
    expect(state!.tools[ID].versions['1.1.0'].source).toBe('catalog')
    expect(state!.tools[ID].versions['1.0.0']).toBeTruthy()
  })

  it('leaves the installed versions untouched when the package differs from the catalog', async () => {
    preset('1.0.0')
    const host = await startHost()
    const file = writePackage(pkgs, { version: '1.1.0' })
    const before = await host.readCliToolState()

    await expect(host.installCatalogPackage(file, expectation(file, '1.1.0', { archiveSha256: '0'.repeat(64) })))
      .rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    await expect(host.installCatalogPackage(file, expectation(file, '1.1.0', { integrity: `sha256-${'A'.repeat(43)}=` })))
      .rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    await expect(host.installCatalogPackage(file, expectation(file, '1.1.0', { id: 'com.example.other' })))
      .rejects.toMatchObject({ code: 'PACKAGE_INVALID' })
    await expect(host.installCatalogPackage(file, expectation(file, '1.2.0')))
      .rejects.toMatchObject({ code: 'PACKAGE_INVALID' })

    expect(await host.readCliToolState()).toEqual(before)
  })

  it('revokes only listed installed tools and keeps them out of new executions', async () => {
    preset('1.0.0')
    const host = await startHost()
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })).toBeTruthy()

    expect(await host.applyCatalogRevocations({ [ID]: true, 'com.example.absent': true })).toEqual([ID])
    expect(await host.applyCatalogRevocations({ [ID]: true })).toEqual([])
    expect((await host.readCliToolState())!.tools['com.example.absent']).toBeUndefined()

    const after: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(after, { entry: 'other', engine: 'claude' })).toBeNull()
    expect(after).toEqual({ PATH: '/usr/bin' })

    expect(await host.applyCatalogRevocations({ [ID]: false })).toEqual([ID])
    const restored: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(restored, { entry: 'other', engine: 'claude' })).toBeTruthy()
  })
})

function rmPreset(name?: string): void {
  for (const file of readdirSync(presetDir)) {
    if (!name || file === name) removeTree(join(presetDir, file))
  }
}

describe('cli-tools host: local management', () => {
  it('previews against what is installed and imports without preempting the current choice', async () => {
    preset('1.0.0')
    const host = await startHost()
    const file = writePackage(pkgs, { version: '2.0.0' })
    const preview = await host.previewUserPackage(file)
    expect(preview).toMatchObject({
      id: ID,
      version: '2.0.0',
      existing: { current: '1.0.0', currentSource: 'preset' },
      sameVersion: null,
      clashes: { tool: null },
    })
    expect((await host.readCliToolState())!.tools[ID].versions['2.0.0']).toBeUndefined()

    await host.importUserPackage(file, { archiveSha256: preview.archiveSha256, makeCurrent: false })
    let state = await host.readCliToolState()
    expect(state!.tools[ID].current).toBe('1.0.0')
    expect(state!.tools[ID].versions['2.0.0'].source).toBe('user-import')

    await host.setCliToolCurrent(ID, '2.0.0')
    state = await host.readCliToolState()
    expect(state!.tools[ID].current).toBe('2.0.0')

    // A later bundled upgrade does not take over the user's choice.
    preset('1.5.0')
    const next = await startHost()
    await next.prepareCliTools()
    expect((await next.readCliToolState())!.tools[ID].current).toBe('2.0.0')

    const same = await next.previewUserPackage(file)
    expect(same.sameVersion).toBe('identical')
    const overview = await next.getCliToolsOverview()
    expect(overview).toMatchObject({ available: true, signature: 'off', pendingCleanup: 0 })
    expect(overview.tools[0].versions.map(v => v.source)).toEqual(['user-import', 'preset', 'preset'])
  })

  it('reclaims files deferred by an earlier process at the next start', async () => {
    const host = await startHost({ presetDir: null })
    const file = writePackage(pkgs)
    const preview = await host.previewUserPackage(file)
    await host.importUserPackage(file, { archiveSha256: preview.archiveSha256, makeCurrent: true })
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })).toBeTruthy()
    expect(await host.removeCliTool(ID)).toEqual({ deferred: 1 })
    expect(readdirSync(join(root, 'store', ID))).toHaveLength(1)

    const next = await startHost({ presetDir: null })
    await next.prepareCliTools()
    expect(existsSync(join(root, 'store', ID)) ? readdirSync(join(root, 'store', ID)) : []).toEqual([])
    expect((await next.getCliToolsOverview()).pendingCleanup).toBe(0)
  })
})

describe('cli-tools host: releasing session pins', () => {
  const lockEntries = () => (existsSync(join(root, 'locks')) ? readdirSync(join(root, 'locks')) : [])
    .map(name => JSON.parse(readFileSync(join(root, 'locks', name), 'utf-8')) as { entry: string; executionId: string })

  // Only the sweep timer is faked, so a test decides when a sweep runs.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('records the entry on each pin and does nothing without a session pin', async () => {
    preset('1.0.0')
    const host = await startHost()
    expect(await host.releaseIdleCliTools()).toEqual({ released: 0, waiting: 0 })
    await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'app-chat', engine: 'claude' })
    await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'automation', engine: 'claude' })
    expect(lockEntries().map(lock => lock.entry).sort()).toEqual(['app-chat', 'automation'])
    expect(lockEntries().every(lock => lock.executionId.includes(`-${lock.entry}-`))).toBe(true)
  })

  it('releases an unheld pin only after the grace period, keeping a held one', async () => {
    const host = await startHost({ presetDir: null })
    await directStore().importPackage(writePackage(pkgs), { source: 'user-import' })
    const v1 = await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'chat', engine: 'claude' })
    await directStore().importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'user-import' })
    const v2 = await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'chat', engine: 'claude' })
    expect(v2).not.toBe(v1)
    host.holdCliTools(v2!)
    await host.removeCliToolVersion(ID, '1.0.0')
    expect(existsSync(v1!)).toBe(true)

    const t0 = 1_000_000
    // The first sweep only notes that v1 is unheld; v2 is held.
    expect(await host.releaseIdleCliTools(t0)).toEqual({ released: 0, waiting: 1 })
    expect(await host.releaseIdleCliTools(t0 + host.CLI_TOOLS_IDLE_GRACE_MS - 1)).toEqual({ released: 0, waiting: 1 })
    expect(existsSync(v1!)).toBe(true)

    expect(await host.releaseIdleCliTools(t0 + host.CLI_TOOLS_IDLE_GRACE_MS)).toEqual({ released: 1, waiting: 0 })
    expect(existsSync(v1!)).toBe(false)
    expect(existsSync(v2!)).toBe(true)
    expect(readdirSync(join(root, 'store', ID))).toHaveLength(1)
    expect((await host.getCliToolsOverview()).pendingCleanup).toBe(0)
  })

  it('restarts the grace period while a pin is held again', async () => {
    preset('1.0.0')
    const host = await startHost()
    const bin = await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'im', engine: 'claude' })
    const grace = host.CLI_TOOLS_IDLE_GRACE_MS
    expect((await host.releaseIdleCliTools(0)).waiting).toBe(1)
    const release = host.holdCliTools(bin!)
    expect((await host.releaseIdleCliTools(grace)).waiting).toBe(0)
    release()
    expect(await host.releaseIdleCliTools(grace + 1)).toEqual({ released: 0, waiting: 1 })
    expect(await host.releaseIdleCliTools(2 * grace + 1)).toEqual({ released: 1, waiting: 0 })
    expect(lockEntries()).toEqual([])
  })

  it('counts holds, ignores a repeated release and sweeps after the last one ends', async () => {
    preset('1.0.0')
    const host = await startHost()
    const bin = await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'automation', engine: 'claude' })
    const first = host.holdCliTools(bin!)
    const second = host.holdCliTools(bin!)
    first()
    first()
    // Still held by the second session: no sweep is scheduled.
    expect(vi.getTimerCount()).toBe(0)
    second()
    expect(vi.getTimerCount()).toBe(1)
    // The scheduled sweep finds the pin unheld and waits out the grace period.
    await vi.advanceTimersByTimeAsync(1000)
    expect(lockEntries().map(lock => lock.entry)).toEqual(['automation'])
    expect(vi.getTimerCount()).toBe(1)
    expect(host.holdCliTools(undefined)).toBeTypeOf('function')
  })

  it('never releases a terminal pin', async () => {
    preset('1.0.0')
    const host = await startHost()
    await host.applyCliToolsEnv({ PATH: '/usr/bin' }, { entry: 'terminal', engine: 'terminal' })
    expect(await host.releaseIdleCliTools(0)).toEqual({ released: 0, waiting: 0 })
    expect(await host.releaseIdleCliTools(10 * host.CLI_TOOLS_IDLE_GRACE_MS)).toEqual({ released: 0, waiting: 0 })
    expect(lockEntries().map(lock => lock.entry)).toEqual(['terminal'])
  })
})
