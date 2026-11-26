import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
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

const launcherOf = (command = 'tool', id = ID) => join(root, 'tools', id, 'bin', process.platform === 'win32' ? `${command}.cmd` : command)

describe('cli-tools host: launchers and skills', () => {
  it('imports a bundled tool when prepared and gives it launchers at a fixed path', async () => {
    preset('1.0.0')
    const host = await startHost()
    await host.prepareCliTools()
    expect(existsSync(launcherOf())).toBe(true)
    const state = await directStore().readState()
    expect(state.tools[ID]).toMatchObject({ current: '1.0.0', installId: expect.stringMatching(/^[0-9a-f]{6}$/) })
    expect(state.tools[ID].versions['1.0.0'].source).toBe('preset')
    expect(existsSync(join(root, 'preset-stamp.json'))).toBe(true)
    expect(existsSync(join(root, 'views'))).toBe(false)
    expect(existsSync(join(root, 'locks'))).toBe(false)
  })

  it('keeps the launcher path across versions and writes no launcher without a runtime', async () => {
    preset('1.0.0')
    const host = await startHost()
    await host.prepareCliTools()
    await directStore().importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'user-import' })
    expect(readFileSync(launcherOf(), 'utf-8')).toContain('2.0.0-')

    removeTree(root)
    vi.resetModules()
    const missing = await import('../../../../src/main/services/cli-tools/host')
    missing.initCliTools({ root, runtimePath: join(dir, 'missing-runtime'), presetDir })
    await missing.prepareCliTools()
    expect(existsSync(join(root, 'tools'))).toBe(false)
  })

  it('lists organization tools whose skill is installed, and drops them with their launchers', async () => {
    preset('1.0.0')
    const host = await startHost()
    await host.prepareCliTools()
    expect(host.peekOrganizationTools()).toEqual([])
    const { installId } = (await directStore().readInstallRecord(ID))!
    const skill = { name: `tool-com-example-tool-${installId}`, path: join(dir, 'skills', 'SKILL.md') }
    await host.recordCliToolSkill(ID, installId, skill)
    expect(host.peekOrganizationTools()).toEqual([{ toolId: ID, name: ID, skillName: skill.name }])
    expect((await directStore().readInstallRecord(ID))?.skill).toEqual(skill)

    await directStore().importPackage(writePackage(pkgs, { id: 'com.example.mine', commands: [{ name: 'mine', entry: 'bin/tool.js' }] }), { source: 'user-import' })
    const mine = (await directStore().readInstallRecord('com.example.mine'))!
    await host.recordCliToolSkill('com.example.mine', mine.installId, { name: 'mine-x', path: join(dir, 'mine') })
    expect(host.peekOrganizationTools().map(tool => tool.toolId)).toEqual([ID])

    await host.setCliToolDisabled(ID, true)
    await vi.waitFor(() => expect(host.peekOrganizationTools()).toEqual([]))
    expect(existsSync(launcherOf())).toBe(false)
  })
})

describe('cli-tools host: bundled tools across launches', () => {
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

  it('revokes only listed installed tools and takes their launchers away', async () => {
    preset('1.0.0')
    const host = await startHost()
    await host.prepareCliTools()
    expect(existsSync(launcherOf())).toBe(true)

    expect(await host.applyCatalogRevocations({ [ID]: true, 'com.example.absent': true })).toEqual([ID])
    expect(await host.applyCatalogRevocations({ [ID]: true })).toEqual([])
    expect((await host.readCliToolState())!.tools['com.example.absent']).toBeUndefined()
    expect(existsSync(launcherOf())).toBe(false)

    expect(await host.applyCatalogRevocations({ [ID]: false })).toEqual([ID])
    expect(existsSync(launcherOf())).toBe(true)
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
    expect(existsSync(launcherOf())).toBe(true)
    expect(await host.removeCliTool(ID)).toEqual({ deferred: 1 })
    expect(readdirSync(join(root, 'store', ID))).toHaveLength(1)

    const next = await startHost({ presetDir: null })
    await next.prepareCliTools()
    expect(existsSync(join(root, 'store', ID)) ? readdirSync(join(root, 'store', ID)) : []).toEqual([])
    expect((await next.getCliToolsOverview()).pendingCleanup).toBe(0)
  })
})
