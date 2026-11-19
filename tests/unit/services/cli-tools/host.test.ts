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
    const tool = (current: string | null, source: string) => ({
      tools: { [ID]: { current, revoked: false, versions: current ? { [current]: { source } } : {} } },
    }) as never
    expect(host.shouldActivatePreset({ tools: {} } as never, ID)).toBe(true)
    expect(host.shouldActivatePreset(tool(null, 'preset'), ID)).toBe(true)
    expect(host.shouldActivatePreset(tool('1.0.0', 'preset'), ID)).toBe(true)
    expect(host.shouldActivatePreset(tool('1.0.0', 'user-import'), ID)).toBe(false)
    expect(host.shouldActivatePreset(tool('1.0.0', 'catalog'), ID)).toBe(false)
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
