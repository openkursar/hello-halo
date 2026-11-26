/**
 * Local management: preview before import, no preemption, user disable,
 * preset protection, deferred deletion, registered existing programs, and
 * catalog status (delisted / withdrawn / update).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CliToolError, CliToolStore, buildToolViews } from '../../../../src/main/services/cli-tools'
import { defaultPayload, makeTempDir, removeTree, writePackage } from './helpers'

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

beforeEach(() => {
  dir = makeTempDir()
  pkgs = join(dir, 'pkgs')
  root = join(dir, 'cli')
  mkdirSync(pkgs)
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTree(dir)
})

describe('cli-tools manage: import preview', () => {
  it('describes a package without running any of it or installing it', async () => {
    const marker = join(dir, 'ran.txt')
    const payload = {
      ...defaultPayload('1.0.0'),
      // Would leave a marker if anything executed it during preview.
      'bin/tool.js': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`,
    }
    const file = writePackage(pkgs, {
      payload,
      manifest: { name: 'Example', sideEffects: 'read-only', auth: { method: 'none' } },
    })
    const store = newStore()
    const preview = await store.previewPackage(file)
    expect(preview).toMatchObject({ id: ID, version: '1.0.0', name: 'Example', commands: ['tool'], platforms: ['any'], sideEffects: 'read-only', auth: 'none' })
    expect(preview.archiveBytes).toBeGreaterThan(0)
    expect(existsSync(marker)).toBe(false)
    expect((await store.readState()).tools[ID]).toBeUndefined()
    expect(storeEntries()).toEqual([])
    expect(existsSync(join(root, 'staging')) ? readdirSync(join(root, 'staging')) : []).toEqual([])
  })

  it.each([
    ['an install script', { payload: { ...defaultPayload('1.0.0'), 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', scripts: { postinstall: 'x' } }) } }, 'NATIVE_NOT_ALLOWED'],
    ['a native module', { payload: { ...defaultPayload('1.0.0'), 'build/addon.node': 'x' } }, 'NATIVE_NOT_ALLOWED'],
    ['another platform', { manifest: { platforms: ['win32-x64'] } }, 'PLATFORM_UNSUPPORTED'],
    ['a wrong digest', { integrity: `sha256-${'A'.repeat(43)}=` }, 'DIGEST_MISMATCH'],
  ])('rejects %s in preview', async (_label, spec, code) => {
    const store = newStore({ platform: 'darwin', arch: 'arm64' })
    expect(await codeOf(store.previewPackage(writePackage(pkgs, spec)))).toBe(code)
    expect((await store.readState()).tools[ID]).toBeUndefined()
  })

  it('rejects a path escaping the package in preview', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const file = join(pkgs, 'escape.hcli')
    writeFileSync(file, zipSync({ 'manifest.json': strToU8('{}'), 'payload/../../evil.js': strToU8('x') }))
    expect(await codeOf(newStore().previewPackage(file))).toBe('PATH_UNSAFE')
    expect(existsSync(join(dir, 'evil.js'))).toBe(false)
  })

  it('refuses to import a file that changed after preview', async () => {
    const store = newStore()
    const file = writePackage(pkgs)
    const preview = await store.previewPackage(file)
    writeFileSync(file, readFileSync(writePackage(pkgs, { version: '1.0.0', payload: defaultPayload('1.0.0', 'other') })))
    expect(await codeOf(store.importPackage(file, { source: 'user-import', expectedArchiveSha256: preview.archiveSha256 })))
      .toBe('DIGEST_MISMATCH')
  })
})

describe('cli-tools manage: sources do not preempt a choice', () => {
  it('keeps a catalog current when a user import arrives, until the user asks', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { version: '1.0.0' }), { source: 'catalog' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'user-import', activate: false })
    expect((await store.readState()).tools[ID].current).toBe('1.0.0')
    await store.activateVersion(ID, '2.0.0')
    expect((await store.readState()).tools[ID].current).toBe('2.0.0')
  })

  it('reports VERSION_CONFLICT for the same version with other content', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    const other = writePackage(pkgs, { payload: defaultPayload('1.0.0', 'different') })
    expect(await codeOf(store.importPackage(other, { source: 'user-import' }))).toBe('VERSION_CONFLICT')
  })
})

describe('cli-tools manage: disable, preset protection, deferred removal', () => {
  it('disables separately from revocation and excludes the tool from new pins', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.setDisabled(ID, true)
    const state = await store.readState()
    expect(state.tools[ID]).toMatchObject({ disabled: true, revoked: false })
    expect(await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })).toBeNull()
    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: ['1.0.0'] }])
    expect((await store.readState()).tools[ID].disabled).toBe(true)
    await store.setDisabled(ID, false)
    expect(await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })).not.toBeNull()
  })

  it('never deletes a preset version or a tool holding one', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { version: '1.0.0' }), { source: 'preset' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    expect(await codeOf(store.removeVersion(ID, '1.0.0'))).toBe('PRESET_PROTECTED')
    expect(await codeOf(store.removeTool(ID))).toBe('PRESET_PROTECTED')
    expect(storeEntries()).toHaveLength(2)
  })

  it('removes a whole tool, deferring the files a running task pins', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'user-import' })
    await store.pinExecution({ executionId: 'run', entry: 'chat', engine: 'claude' })
    expect(await store.removeTool(ID)).toEqual({ deferred: 1 })
    expect((await store.readState()).tools[ID]).toBeUndefined()
    expect(storeEntries()).toHaveLength(1)
    await store.releaseExecution('run')
    expect(await store.collectPendingCleanup()).toBe(1)
    expect(storeEntries()).toEqual([])
  })

  it('keeps a pending directory when the same version is reinstalled', async () => {
    const store = newStore()
    const file = writePackage(pkgs)
    await store.importPackage(file, { source: 'user-import' })
    await store.pinExecution({ executionId: 'run', entry: 'chat', engine: 'claude' })
    await store.removeTool(ID)
    await store.importPackage(file, { source: 'user-import' })
    await store.releaseExecution('run')
    expect(await store.collectPendingCleanup()).toBe(0)
    expect(storeEntries()).toHaveLength(1)
    expect((await store.readState()).pendingCleanup).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('cli-tools manage: registered existing programs', () => {
  function program(body = '#!/bin/sh\necho "external:$1"\nexit 7\n'): string {
    const file = join(dir, 'mytool.sh')
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    return file
  }

  it('records only path and fingerprint and runs the original file with args and exit code', async () => {
    const file = program('#!/bin/sh\nprintf "%s\\n" "external:$1:$NODE_PATH"\nexit 7\n')
    const before = readFileSync(file, 'utf-8')
    const store = newStore()
    const { id, current } = await store.registerExternal({ path: file, interpreter: null, command: 'mytool', name: 'My tool' })
    expect(id).toBe('external.mytool')
    expect(current).toBe('external')
    const record = (await store.readState()).tools[id].versions.external
    expect(record.external).toMatchObject({ path: file, interpreter: null, size: before.length })
    expect(record.external!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(root, 'store', id))).toBe(false)

    const pin = await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })
    const run = spawnSync(join(pin!.binDir!, 'mytool'), ['hello'], {
      encoding: 'utf-8', env: { ...process.env, NODE_PATH: 'inherited-modules' },
    })
    expect(run.stdout.trim()).toBe('external:hello:inherited-modules')
    expect(run.status).toBe(7)
    expect(readFileSync(join(pin!.binDir!, '..', 'TOOLS.md'), 'utf-8'))
      .toContain('| `mytool` | external.mytool | - | unknown | unknown | - |')
  })

  it('runs a .mjs script on the bundled Node without the inherited NODE_PATH', async () => {
    const file = join(dir, 'script.mjs')
    writeFileSync(file, 'console.log("node:" + process.argv.slice(2).join(",") + ":" + (process.env.NODE_PATH ?? ""))\n')
    const store = newStore()
    await store.registerExternal({ path: file, interpreter: 'halo-node', command: 'myscript', name: 'Script' })
    const pin = await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })
    const run = spawnSync(join(pin!.binDir!, 'myscript'), ['a', 'b'], {
      encoding: 'utf-8', env: { ...process.env, NODE_PATH: 'inherited-modules' },
    })
    expect(run.stdout.trim()).toBe('node:a,b:')
  })

  it('validates the command name and the file', async () => {
    const file = program()
    const store = newStore()
    expect(await codeOf(store.registerExternal({ path: file, interpreter: null, command: 'halo-x', name: 'x' }))).toBe('EXTERNAL_INVALID')
    expect(await codeOf(store.registerExternal({ path: file, interpreter: null, command: 'Bad Name', name: 'x' }))).toBe('EXTERNAL_INVALID')
    expect(await codeOf(store.registerExternal({ path: 'relative/path', interpreter: null, command: 'ok', name: 'x' }))).toBe('EXTERNAL_INVALID')
    expect(await codeOf(store.registerExternal({ path: file, interpreter: 'halo-node', command: 'ok', name: 'x' }))).toBe('EXTERNAL_INVALID')
    const plain = join(dir, 'plain')
    writeFileSync(plain, 'x')
    chmodSync(plain, 0o644)
    expect(await codeOf(store.registerExternal({ path: plain, interpreter: null, command: 'ok', name: 'x' }))).toBe('EXTERNAL_INVALID')
  })

  it('blocks a changed or missing program from new pins until re-confirmed', async () => {
    const file = program()
    const store = newStore()
    const { id } = await store.registerExternal({ path: file, interpreter: null, command: 'mytool', name: 'My tool' })
    const first = await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })
    expect(first).not.toBeNull()

    writeFileSync(file, '#!/bin/sh\necho changed\n')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(await store.pinCurrent({ holder: 'p2', entry: 'other', engine: 'claude' })).toBeNull()
    const state = await store.readState()
    expect(state.tools[id].versions.external.external!.changed).toBe('modified')
    expect(buildToolViews(state, [])[0].status).toBe('external-changed')

    await store.reconfirmExternal(id)
    const again = await store.pinCurrent({ holder: 'p3', entry: 'other', engine: 'claude' })
    expect(again).not.toBeNull()
    // The new fingerprint gives a new view, so sessions rebuild with the confirmed file.
    expect(again!.binDir).not.toBe(first!.binDir)

    removeTree(file)
    expect(await store.pinCurrent({ holder: 'p4', entry: 'other', engine: 'claude' })).toBeNull()
    expect((await store.readState()).tools[id].versions.external.external!.changed).toBe('missing')
  })

  it('treats a touched but identical file as unchanged', async () => {
    const file = program()
    const store = newStore()
    await store.registerExternal({ path: file, interpreter: null, command: 'mytool', name: 'My tool' })
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })).not.toBeNull()
  })

  it('removing the registration leaves the program file untouched', async () => {
    const file = program()
    const before = readFileSync(file)
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'catalog' })
    await store.registerExternal({ path: file, interpreter: null, command: 'mytool', name: 'Mine', toolId: ID })
    expect((await store.readState()).tools[ID].current).toBe('1.0.0')
    expect(await store.removeVersion(ID, 'external')).toEqual({ deferred: false })
    expect(readFileSync(file)).toEqual(before)

    const { id } = await store.registerExternal({ path: file, interpreter: null, command: 'mytool', name: 'Mine' })
    expect(await store.removeTool(id)).toEqual({ deferred: 0 })
    expect(readFileSync(file)).toEqual(before)
  })
})

describe('cli-tools manage: catalog status', () => {
  async function catalogTool(store: CliToolStore, version = '1.0.0') {
    await store.importPackage(writePackage(pkgs, { version }), { source: 'catalog' })
  }

  it('marks a catalog tool delisted when the catalog has neither versions nor a revocation', async () => {
    const store = newStore()
    await catalogTool(store)
    expect(await store.applyCatalogStatus([])).toEqual([ID])
    expect((await store.readState()).tools[ID].delisted).toBe(true)
    expect(await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })).toBeNull()

    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: [] }])
    expect((await store.readState()).tools[ID].delisted).toBe(true)

    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: ['1.0.0'] }])
    expect((await store.readState()).tools[ID].delisted).toBeUndefined()
    expect(await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })).not.toBeNull()
  })

  it('treats a revocation-only entry as revoked, not delisted', async () => {
    const store = newStore()
    await catalogTool(store)
    await store.applyCatalogStatus([{ id: ID, revoked: true, versions: [] }])
    const tool = (await store.readState()).tools[ID]
    expect(tool).toMatchObject({ revoked: true })
    expect(tool.delisted).toBeUndefined()
  })

  it('never delists a tool the catalog did not provide', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs), { source: 'user-import' })
    await store.applyCatalogStatus([])
    expect((await store.readState()).tools[ID].delisted).toBeUndefined()
  })

  it('flags a withdrawn version without disabling it and offers the update', async () => {
    const store = newStore()
    await catalogTool(store)
    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: ['1.1.0', '2.0.0'] }])
    const tool = (await store.readState()).tools[ID]
    expect(tool.versions['1.0.0'].withdrawn).toBe(true)
    expect(tool.catalogUpdate).toBe('2.0.0')
    expect(await store.pinCurrent({ holder: 'p', entry: 'other', engine: 'claude' })).not.toBeNull()
    // Nothing was downloaded.
    expect(storeEntries()).toHaveLength(1)
  })

  it('offers no update when an installed version is as new, and none to a revoked tool', async () => {
    const store = newStore()
    await catalogTool(store, '2.0.0')
    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: ['1.0.0', '2.0.0'] }])
    expect((await store.readState()).tools[ID].catalogUpdate).toBeUndefined()
    await store.applyCatalogStatus([{ id: ID, revoked: true, versions: ['3.0.0'] }])
    expect((await store.readState()).tools[ID].catalogUpdate).toBeUndefined()
    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: ['10.0.0'] }])
    expect((await store.readState()).tools[ID].catalogUpdate).toBe('10.0.0')
  })

  it('stops offering an update once that version is installed, without waiting for the next catalog read', async () => {
    const store = newStore()
    await catalogTool(store)
    await store.applyCatalogStatus([{ id: ID, revoked: false, versions: ['1.0.0', '2.0.0'] }])
    expect((await store.readState()).tools[ID].catalogUpdate).toBe('2.0.0')
    await catalogTool(store, '1.5.0')
    expect((await store.readState()).tools[ID].catalogUpdate).toBe('2.0.0')
    await catalogTool(store, '2.0.0')
    expect((await store.readState()).tools[ID].catalogUpdate).toBeUndefined()
  })

  it('projects views with sources, status and removability', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { version: '1.0.0' }), { source: 'preset' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0' }), { source: 'catalog' })
    await store.importPackage(writePackage(pkgs, { version: '3.0.0' }), { source: 'user-import', activate: false })
    await store.pinExecution({ executionId: 'run', entry: 'chat', engine: 'claude' })
    const [view] = buildToolViews(await store.readState(), await store.listExecutionLocks())
    expect(view).toMatchObject({ id: ID, current: '2.0.0', status: 'available', hasPreset: true, commands: ['tool'] })
    expect(view.versions.map(v => [v.version, v.source, v.current, v.removable, v.inUse])).toEqual([
      ['3.0.0', 'user-import', false, true, false],
      ['2.0.0', 'catalog', true, false, true],
      ['1.0.0', 'preset', false, false, false],
    ])
  })
})
