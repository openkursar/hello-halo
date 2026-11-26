import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { delimiter, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliToolStore, type CliSupportFilesConfig, type PinnedExecution } from '../../../../src/main/services/cli-tools'
import { placeSupportFiles, SUPPORT_FAILURE } from '../../../../src/main/services/cli-tools/support-files'
import { makeTempDir, removeTree, writePackage } from './helpers'

const ID = 'com.example.tool'
const VERSION = '1.0.0'
const TARGET = 'helpers/scripts/loader.cjs'
const pin = { holder: 'process', entry: 'chat', engine: 'test' } as const
const entry = { executionId: 'old', entry: 'chat', engine: 'test' } as const

let temp: string
let root: string
let deployment: string
let log: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }

beforeEach(() => {
  temp = realpathSync(makeTempDir())
  root = join(temp, 'store-root')
  deployment = join(temp, 'deployment')
  mkdirSync(deployment)
  writeFileSync(join(deployment, 'helper.cjs'), 'module.exports = "original"')
  log = { log: vi.fn(), error: vi.fn() }
})

afterEach(() => removeTree(temp))

function configured(files: unknown = [{ source: 'helper.cjs', target: TARGET }]): CliSupportFilesConfig {
  return { productDir: deployment, files }
}

function store(supportFiles?: CliSupportFilesConfig): CliToolStore {
  return new CliToolStore({ root, runtimePath: process.execPath, runtimeNodeVersion: '22.18.0', log, supportFiles })
}

function versionRoot(digest: string): string {
  return join(root, 'store', ID, `${VERSION}-${Buffer.from(digest.slice(7), 'base64').toString('hex').slice(0, 12)}`)
}

function run(pin: PinnedExecution): { entry: string; helper: string; value: string | null } {
  const bin = pin.binDir!
  const output = process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', join(bin, 'tool.cmd')], { encoding: 'utf8' })
    : execFileSync(join(bin, 'tool'), { encoding: 'utf8' })
  return JSON.parse(output)
}

function invoke(pinned: PinnedExecution, command = 'tool') {
  const launcher = join(pinned.binDir!, command)
  const options = { encoding: 'utf8' as const, env: { ...process.env, MARKER_FILE: join(temp, 'ran') } }
  return process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `${launcher}.cmd`], options)
    : spawnSync(launcher, [], options)
}

function expectRefusal(pinned: PinnedExecution, command = 'tool'): void {
  const output = invoke(pinned, command)
  expect(output.status).toBe(1)
  expect(output.stderr.trim()).toBe(`SUPPORT_FILES_INVALID: ${SUPPORT_FAILURE}`)
  expect(output.stdout).toBe('')
  expect(existsSync(join(temp, 'ran'))).toBe(false)
}

function makeTool(): string {
  return writePackage(temp, {
    commands: [{ name: 'tool', entry: 'vendor/sdk/tool.cjs' }],
    payload: {
      'vendor/sdk/tool.cjs': `
        const fs = require('fs');
        const path = require('path');
        if (process.env.MARKER_FILE) fs.writeFileSync(process.env.MARKER_FILE, 'entry ran');
        const helper = path.resolve(__dirname, '../../../${TARGET}');
        console.log(JSON.stringify({ entry: __filename, helper, value: fs.existsSync(helper) ? require(helper) : null }));
      `,
    },
    extra: { 'guide/guide.md': 'original guide', 'LICENSES/LICENSE.txt': 'original license' },
  })
}

describe('managed CLI support files', () => {
  it.each(['preset', 'catalog', 'user-import'] as const)('places support files during %s import', async source => {
    const cli = store(configured())
    const result = await cli.importPackage(makeTool(), { source })
    const base = versionRoot(result.integrity)
    const helper = join(base, TARGET)
    expect(readFileSync(helper, 'utf8')).toBe('module.exports = "original"')
    expect(lstatSync(helper).isFile()).toBe(true)
    if (process.platform !== 'win32') expect(lstatSync(helper).mode & 0o222).toBe(0)
    expect(await cli.verifyVersion(ID, VERSION)).toBe(true)
    const pinned = (await cli.pinCurrent(pin))!
    expect(pinned.lock.tools[0].supportDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(pinned.lock.tools[0].supportVariant).toBeUndefined()
    expect(run(pinned)).toEqual({ entry: join(base, 'payload/vendor/sdk/tool.cjs'), helper, value: 'original' })
  })

  it('never reads support config or writes helper files for registered external programs', async () => {
    const cli = store(configured([{ source: '../private.cjs', target: TARGET }]))
    const program = join(temp, 'external.cjs')
    writeFileSync(program, 'console.log("external")')
    const external = await cli.registerExternal({ path: program, name: 'External', command: 'external', interpreter: 'halo-node' })
    const pinned = (await cli.pinCurrent(pin))!
    expect(pinned.lock.tools).toEqual([expect.objectContaining({ id: external.id })])
    expect(pinned.lock.tools[0].supportDigest).toBeUndefined()
    expect(existsSync(join(temp, TARGET))).toBe(false)
    expect(existsSync(join(root, 'support'))).toBe(false)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('rejects any unsafe required source without installing only the valid subset or leaking paths', async () => {
    const outside = join(temp, 'outside.cjs')
    writeFileSync(outside, 'outside')
    writeFileSync(join(deployment, 'large.cjs'), Buffer.alloc(1024 * 1024 + 1))
    mkdirSync(join(deployment, 'folder'))
    if (process.platform !== 'win32') {
      symlinkSync(deployment, join(deployment, 'linked'))
      symlinkSync(join(deployment, 'helper.cjs'), join(deployment, 'linked-file.cjs'))
    } else {
      symlinkSync(deployment, join(deployment, 'linked'), 'junction')
    }
    writeFileSync(join(deployment, 'empty'), '')
    linkSync(join(deployment, 'helper.cjs'), join(deployment, 'hard-linked'))
    writeFileSync(join(deployment, 'valid.cjs'), 'module.exports = "valid"')
    const paths = ['../outside.cjs', outside, 'linked/helper.cjs', 'large.cjs', 'folder', 'empty', 'hard-linked']
    if (process.platform !== 'win32') paths.push('linked-file.cjs')
    const packagePath = makeTool()
    for (const source of paths) {
      const cli = store(configured([{ source: 'valid.cjs', target: TARGET }, { source, target: 'second.cjs' }]))
      await expect(cli.importPackage(packagePath, { source: 'user-import' })).rejects.toMatchObject({ code: 'SUPPORT_FILES_INVALID' })
      expect((await cli.readState()).tools).toEqual({})
    }
    expect(log.error).toHaveBeenCalledWith(expect.any(String), { field: 'cliTools.supportFiles[1].source', reason: expect.any(String) })
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(temp)
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('outside.cjs')
  })

  it('rejects unsafe targets and leaves package files alone', async () => {
    const targets = ['../bad', '/absolute', 'C:/drive', 'C:drive', 'dir\\bad', 'dir//bad', 'dir/./bad', 'dir/..',
      'payload/vendor/sdk/tool.cjs', 'PAYLOAD', 'Manifest.json', 'manifest.json/child', 'guide/guide.md',
      'LICENSES/LICENSE.txt', '.halo-support.json', 'dir/file:alternate', 'dir/nul.txt', 'dir/file.', 'dir/trailing ']
    const healthy = store()
    const packagePath = makeTool()
    const result = await healthy.importPackage(packagePath, { source: 'catalog' })
    const base = versionRoot(result.integrity)
    for (const target of targets) {
      const cli = store(configured([{ source: 'helper.cjs', target }]))
      await expect(cli.importPackage(packagePath, { source: 'catalog' })).rejects.toMatchObject({ code: 'SUPPORT_FILES_INVALID' })
    }
    expect(await healthy.verifyVersion(ID, VERSION)).toBe(true)
    expect(readFileSync(join(base, 'guide/guide.md'), 'utf8')).toBe('original guide')
    expect(readFileSync(join(base, 'LICENSES/LICENSE.txt'), 'utf8')).toBe('original license')
    expect(log.error).toHaveBeenCalledWith(expect.any(String), { field: 'cliTools.supportFiles[0].target', reason: 'invalid-path' })
  })

  it('uses exclusive placement when a file or directory entry is already present', async () => {
    const dir = join(temp, 'existing-root')
    mkdirSync(dir)
    writeFileSync(join(dir, 'existing-file'), 'package')
    mkdirSync(join(dir, 'existing-dir'))
    const files = ['existing-file', 'existing-file/child', 'existing-dir'].map((target, index) => ({ index, target, bytes: Buffer.from('support') }))
    for (const file of files) {
      await expect(placeSupportFiles(dir, [file], log)).rejects.toMatchObject({ code: 'SUPPORT_FILES_INVALID' })
    }
    expect(readFileSync(join(dir, 'existing-file'), 'utf8')).toBe('package')
    expect(lstatSync(join(dir, 'existing-dir')).isDirectory()).toBe(true)
    expect(log.error).toHaveBeenCalledTimes(3)
  })

  it.each([[TARGET, TARGET], ['Helpers/a.cjs', 'helpers/b.cjs'], ['helpers', TARGET], [TARGET, 'helpers/scripts']])(
    'refuses portable target collision %s with %s', async (first, second) => {
      const cli = store(configured([first, second].map(target => ({ source: 'helper.cjs', target }))))
      await expect(cli.importPackage(makeTool(), { source: 'catalog' })).rejects.toMatchObject({ code: 'SUPPORT_FILES_INVALID' })
      expect((await cli.readState()).tools).toEqual({})
    },
  )

  it.each(['missing', 'same-size overwrite', 'empty', 'hardlink', 'linked ancestor', 'linked root', 'symlink'] as const)(
    'the same launcher never enters the program after %s', async change => {
      if (change === 'symlink' && process.platform === 'win32') return
      const cli = store(configured())
      const result = await cli.importPackage(makeTool(), { source: 'catalog' })
      const pinned = (await cli.pinCurrent(pin))!
      const helper = join(versionRoot(result.integrity), TARGET)
      const original = readFileSync(helper)
      expect(invoke(pinned).status).toBe(0)
      expect(readFileSync(join(temp, 'ran'), 'utf8')).toBe('entry ran')
      unlinkSync(join(temp, 'ran'))
      if (change === 'linked ancestor' || change === 'linked root') {
        const dir = change === 'linked root' ? versionRoot(result.integrity) : dirname(helper)
        chmodSync(dirname(dir), 0o755)
        chmodSync(dir, 0o755)
        const moved = `${dir}-moved`
        renameSync(dir, moved)
        symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir')
      } else {
        chmodSync(dirname(helper), 0o755)
        chmodSync(helper, 0o644)
        if (change === 'same-size overwrite') writeFileSync(helper, Buffer.alloc(original.length, 0x41))
        else if (change === 'empty') writeFileSync(helper, '')
        else {
          unlinkSync(helper)
          if (change === 'hardlink' || change === 'symlink') {
            const identical = join(temp, 'identical.cjs')
            writeFileSync(identical, original)
            if (change === 'hardlink') linkSync(identical, helper)
            else symlinkSync(identical, helper)
          }
        }
      }
      expectRefusal(pinned)
      const refused = (await cli.pinCurrent(pin))!
      expect(refused.lock.viewKey).not.toBe(pinned.lock.viewKey)
      expectRefusal(refused)
    },
  )

  it('refuses an incomplete variant even after a previous pin cached its view', async () => {
    const base = store()
    await base.importPackage(makeTool(), { source: 'catalog' })
    const cli = store(configured())
    const healthy = (await cli.pinCurrent(pin))!
    expect(healthy.lock.tools[0].supportVariant).toBe(true)
    const helper = run(healthy).helper
    chmodSync(dirname(helper), 0o755)
    chmodSync(helper, 0o644)
    unlinkSync(helper)
    expectRefusal(healthy)
    const refused = (await cli.pinCurrent(pin))!
    expect(refused.lock.viewKey).not.toBe(healthy.lock.viewKey)
    expectRefusal(refused)
    writeFileSync(helper, 'module.exports = "original"')
    expect((await cli.pinCurrent(pin))?.lock.viewKey).toBe(healthy.lock.viewKey)
    expect(run(healthy).value).toBe('original')
  })

  it('refuses a bad deployment without masking a system command or blocking a registered program', async () => {
    const legacy = store(configured())
    const result = await legacy.importPackage(makeTool(), { source: 'catalog' })
    const program = join(temp, 'external.cjs')
    writeFileSync(program, 'console.log("external marker")')
    await legacy.registerExternal({ path: program, name: 'External', command: 'external', interpreter: 'halo-node' })
    const system = join(temp, 'system')
    mkdirSync(system)
    const systemPath = join(system, process.platform === 'win32' ? 'tool.cmd' : 'tool')
    writeFileSync(systemPath, process.platform === 'win32' ? '@echo system marker\r\n' : '#!/bin/sh\necho system marker\n', { mode: 0o755 })
    const missing = 'not-present.cjs'
    const cli = store(configured([{ source: missing, target: TARGET }]))
    const options = { ...pin, basePath: [system, process.env.PATH].join(delimiter) }
    const refused = (await cli.pinCurrent(options))!
    expect(refused.lock.commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'tool', exposedAs: 'halo-tool' })]))
    expect(existsSync(join(refused.binDir!, 'tool'))).toBe(false)
    expectRefusal(refused, 'halo-tool')
    expect(invoke(refused, 'external').stdout.trim()).toBe('external marker')
    const guide = readFileSync(join(refused.binDir!, '..', 'TOOLS.md'), 'utf8')
    expect(guide).toContain('Unavailable commands')
    expect(guide).not.toContain('| `halo-tool` |')
    expect(guide).toContain('| `external` |')
    expect(readFileSync(join(versionRoot(result.integrity), TARGET), 'utf8')).toContain('original')
    writeFileSync(join(deployment, missing), 'module.exports = "original"')
    const repaired = (await cli.pinCurrent(options))!
    expect(repaired.lock.viewKey).not.toBe(refused.lock.viewKey)
    expectRefusal(refused, 'halo-tool')
    expect(invoke(repaired, 'halo-tool').status).toBe(0)
  })

  it('does not give an existing unguarded view to a newly configured execution', async () => {
    const legacy = store(configured([]))
    await legacy.importPackage(makeTool(), { source: 'user-import' })
    const old = await legacy.pinExecution(entry)
    const opened = await legacy.pinCurrent(pin)
    expect(opened?.binDir).toBe(old.binDir)
    expect(run(old).value).toBeNull()
    const cli = store(configured())
    await expect(cli.pinExecution(entry)).rejects.toMatchObject({ code: 'SUPPORT_FILES_INVALID' })
    const next = (await cli.pinCurrent(pin))!
    expect(next.binDir).not.toBe(old.binDir)
    expect(run(next).value).toBe('original')
  })

  it('uses a distinct immutable runtime for changed and removed support files, then cleans up with the version', async () => {
    const first = store(configured())
    const result = await first.importPackage(makeTool(), { source: 'user-import' })
    const before = await first.pinExecution(entry)
    const old = run(before)
    writeFileSync(join(deployment, 'helper.cjs'), 'module.exports = "updated"')
    const next = store(configured())
    const after = (await next.pinCurrent(pin))!
    const updated = run(after)
    expect(after.lock.viewKey).not.toBe(before.lock.viewKey)
    expect(after.lock.tools[0]).toMatchObject({ integrity: result.integrity, supportVariant: true })
    expect(updated.value).toBe('updated')
    expect(run(await next.pinExecution(entry))).toEqual(old)
    expect(updated.entry).not.toBe(old.entry)
    expect(updated.helper).not.toBe(old.helper)
    expect(realpathSync(updated.entry)).toBe(updated.entry)
    expect(realpathSync(updated.helper)).toBe(updated.helper)
    expect(dirname(dirname(dirname(dirname(updated.entry))))).toBe(dirname(dirname(dirname(updated.helper))))
    expect(lstatSync(updated.entry).isFile()).toBe(true)
    expect(await next.verifyVersion(ID, VERSION)).toBe(true)

    const removed = store()
    const withoutSupport = (await removed.pinCurrent(pin))!
    const empty = run(withoutSupport)
    expect(empty.value).toBeNull()
    expect(withoutSupport.lock.viewKey).not.toBe(after.lock.viewKey)
    expect(run(after)).toEqual(updated)
    expect(await removed.removeTool(ID)).toEqual({ deferred: 1 })
    expect(await removed.collectPendingCleanup()).toBe(0)
    for (const pinned of [before, after, withoutSupport]) await removed.releaseExecution(pinned.lock.executionId)
    expect(await removed.collectPendingCleanup()).toBe(1)
    for (const path of [old.entry, old.helper, updated.entry, updated.helper, empty.entry]) expect(existsSync(path)).toBe(false)
  })

  it('reinstalls a pending version without replacing the files an earlier pin reads', async () => {
    const cli = store(configured())
    const packagePath = makeTool()
    await cli.importPackage(packagePath, { source: 'user-import' })
    const before = await cli.pinExecution(entry)
    const old = run(before)
    await cli.removeTool(ID)
    writeFileSync(join(deployment, 'helper.cjs'), 'module.exports = "new"')
    const next = store(configured())
    await next.importPackage(packagePath, { source: 'user-import' })
    expect(run(before)).toEqual(old)
    expect(run((await next.pinCurrent(pin))!).value).toBe('new')
    expect((await next.readState()).pendingCleanup).toBeUndefined()
  })
})
