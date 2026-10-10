import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createPackage } from '@electron/asar'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const cliPath = require.resolve('@anthropic-ai/claude-code/cli.js')
const bootstrapPath = path.join(path.dirname(cliPath), 'windows-hide.cjs')
const bootstrap = readFileSync(bootstrapPath, 'utf8')

function install(platform: string) {
  const spawn = vi.fn(function (this: unknown, options: unknown) { return { owner: this, options } })
  class ChildProcess { declare spawn: typeof spawn }
  Object.assign(ChildProcess.prototype, { spawn })
  const childProcess = {
    ChildProcess,
    spawnSync: vi.fn(function (this: unknown, ...args: unknown[]) { return { owner: this, args } }),
    execFileSync: vi.fn(function (this: unknown, ...args: unknown[]) { return { owner: this, args } }),
    execSync: vi.fn(function (this: unknown, ...args: unknown[]) { return { owner: this, args } }),
  }
  const originals = { ...childProcess, spawn }
  const syncBuiltinESMExports = vi.fn()
  vm.runInNewContext(bootstrap, {
    process: { platform },
    require: (name: string) => {
      if (name === 'node:child_process') return childProcess
      if (name === 'node:module') return { syncBuiltinESMExports }
      throw new Error(`Unexpected bootstrap dependency: ${name}`)
    },
  })
  return { childProcess, originals, syncBuiltinESMExports }
}

describe('Windows packaged console bootstrap', () => {
  const packScript = path.resolve(__dirname, '../../../../scripts/afterPack.cjs')
  const scope = { require: createRequire(packScript), __dirname: path.dirname(packScript), module: { exports: {} }, process, console }
  vm.runInNewContext(`${readFileSync(packScript, 'utf8')}\nmodule.exports = validateWindowsConsoleBootstrap;`, scope)
  const validate = scope.module.exports as (context: { electronPlatformName: string }, pkg: { exists: (file: string) => boolean; read: (file: string) => Buffer }) => void
  const packagedCli = 'node_modules/@anthropic-ai/claude-code/cli.js'
  const packagedBootstrap = 'node_modules/@anthropic-ai/claude-code/windows-hide.cjs'
  const source = readFileSync(cliPath)
  const pkg = (files: Record<string, Buffer>) => ({ exists: (file: string) => file in files, read: (file: string) => files[file] })

  it('accepts a Windows artifact only when the bootstrap is bundled and imported', () => {
    expect(() => validate({ electronPlatformName: 'win32' }, pkg({ [packagedCli]: source, [packagedBootstrap]: Buffer.from(bootstrap) }))).not.toThrow()
  })

  it('rejects a Windows artifact whose packer dropped the bootstrap', () => {
    expect(() => validate({ electronPlatformName: 'win32' }, pkg({ [packagedCli]: source }))).toThrow(/bootstrap is missing/)
  })

  it('rejects an unpatched Windows CLI even when the bootstrap file is present', () => {
    expect(() => validate({ electronPlatformName: 'win32' }, pkg({ [packagedCli]: Buffer.from('#!/usr/bin/env node'), [packagedBootstrap]: Buffer.from(bootstrap) }))).toThrow(/bootstrap is missing/)
  })

  it('validates a real asar containing the patched CLI and its Windows SDK fallback copy', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'halo-console-package-'))
    const input = path.join(root, 'input')
    const resources = path.join(root, 'output', 'resources')
    const codeDir = path.join(input, 'node_modules/@anthropic-ai/claude-code')
    const sdkDir = path.join(input, 'node_modules/@anthropic-ai/claude-agent-sdk')
    try {
      for (const dir of [codeDir, sdkDir, resources]) mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(codeDir, 'cli.js'), source)
      writeFileSync(path.join(codeDir, 'windows-hide.cjs'), bootstrap)
      writeFileSync(path.join(sdkDir, 'cli.js'), source)
      await createPackage(input, path.join(resources, 'app.asar'))
      const readerScope = { ...scope, module: { exports: {} } }
      vm.runInNewContext(`${readFileSync(packScript, 'utf8')}\nmodule.exports = createPackageReader;`, readerScope)
      const createReader = readerScope.module.exports as (context: { electronPlatformName: string; appOutDir: string }) => ReturnType<typeof pkg>
      const context = { electronPlatformName: 'win32', appOutDir: path.dirname(resources) }
      const packaged = createReader(context)
      expect(() => validate(context, packaged)).not.toThrow()
      expect(packaged.read('node_modules/@anthropic-ai/claude-agent-sdk/cli.js').toString()).toContain("import '../claude-code/windows-hide.cjs';")
      expect(packaged.read(packagedBootstrap).toString()).toBe(bootstrap)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves builds without Claude Code and other operating systems alone', () => {
    expect(() => validate({ electronPlatformName: 'win32' }, pkg({}))).not.toThrow()
    expect(() => validate({ electronPlatformName: 'darwin' }, pkg({ [packagedCli]: source }))).not.toThrow()
  })
})

describe('Windows CLI console policy', () => {
  it('loads before CLI initialization, including the SDK fallback copy', () => {
    for (const file of [cliPath, path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'cli.js')]) {
      const source = readFileSync(file, 'utf8')
      expect(source.split('\n').slice(0, 7)).toContain("import '../claude-code/windows-hide.cjs';")
    }
  })

  it.each(['darwin', 'linux'])('does not modify Node child-process functions on %s', (platform) => {
    const { childProcess, originals, syncBuiltinESMExports } = install(platform)
    expect(childProcess.ChildProcess.prototype.spawn).toBe(originals.spawn)
    for (const name of ['spawnSync', 'execFileSync', 'execSync'] as const) {
      expect(childProcess[name]).toBe(originals[name])
    }
    expect(syncBuiltinESMExports).not.toHaveBeenCalled()
  })

  it('hides normalized asynchronous launches without changing their environment or pipes', () => {
    const { childProcess, originals, syncBuiltinESMExports } = install('win32')
    const owner = new childProcess.ChildProcess()
    const options = { file: 'cmd.exe', args: ['/c', 'dir'], envPairs: ['PATH=C:\\Git'], stdio: ['pipe'], windowsHide: false }
    const result = childProcess.ChildProcess.prototype.spawn.call(owner, options)
    expect(originals.spawn).toHaveBeenCalledWith({ ...options, windowsHide: true })
    expect(result.owner).toBe(owner)
    expect((result.options as typeof options).envPairs).toBe(options.envPairs)
    expect((result.options as typeof options).stdio).toBe(options.stdio)
    expect(options.windowsHide).toBe(false)
    expect(syncBuiltinESMExports).toHaveBeenCalledOnce()
  })

  it.each(['spawnSync', 'execFileSync'] as const)('hides %s with every supported argument shape', (name) => {
    const { childProcess, originals } = install('win32')
    const options = { cwd: 'C:\\Workspace With Spaces', encoding: 'utf8', timeout: 3000, windowsHide: false }
    const forms: unknown[][] = [
      ['git.exe'],
      ['git.exe', options],
      ['git.exe', ['--version']],
      ['git.exe', ['--version'], options],
      ['git.exe', undefined, options],
      ['git.exe', null, options],
    ]
    for (const args of forms) {
      const index = Array.isArray(args[1]) || (args[1] == null && args.length > 2) ? 2 : 1
      const result = childProcess[name](...args)
      expect(originals[name]).toHaveBeenLastCalledWith(...args.slice(0, index), { ...(args[index] as object), windowsHide: true })
      expect(result.owner).toBe(childProcess)
    }
    expect(options.windowsHide).toBe(false)
  })

  it('hides the actual bundled Git Bash path probe on every new CLI process', () => {
    const source = readFileSync(cliPath, 'utf8')
    const probe = source.match(/function ([\w$]+)\(([\w$]+)\)\{try\{return ([\w$]+)\(`dir "\$\{[\w$]+\}"`,\{stdio:"pipe"\}\),!0\}catch\{return!1\}\}/)
    expect(probe, 'Revalidate the bundled CLI startup probe when upgrading Claude Code').not.toBeNull()
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    for (let rebuild = 0; rebuild < 3; rebuild++) {
      const { childProcess, originals } = install('win32')
      expect(vm.runInNewContext(`(${probe![0]})(${JSON.stringify(bash)})`, { [probe![3]]: childProcess.execSync })).toBe(true)
      expect(originals.execSync).toHaveBeenCalledWith(`dir "${bash}"`, { stdio: 'pipe', windowsHide: true })
    }
  })

  it('covers real Node async entry points, promisified calls and named ESM sync imports', () => {
    const script = `
      import assert from 'node:assert/strict'
      import cp, { execSync, execFileSync, spawnSync } from 'node:child_process'
      import { createRequire } from 'node:module'
      import { promisify } from 'node:util'
      const captured = []
      cp.ChildProcess.prototype.spawn = function (options) {
        captured.push(options)
        return 0
      }
      const sync = []
      for (const name of ['execSync', 'execFileSync', 'spawnSync']) {
        cp[name] = (...args) => { sync.push({ name, args }); return 'OK' }
      }
      Object.defineProperty(process, 'platform', { value: 'win32' })
      createRequire(${JSON.stringify(bootstrapPath)})(${JSON.stringify(bootstrapPath)})
      assert.equal(execSync, cp.execSync)
      assert.equal(execFileSync, cp.execFileSync)
      assert.equal(spawnSync, cp.spawnSync)
      const command = 'dir "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"'
      assert.equal(execSync(command, { stdio: 'pipe' }), 'OK')
      execFileSync('git.exe', ['--version'], { encoding: 'utf8' })
      spawnSync('git.exe', ['--version'])
      for (const call of sync) {
        assert.equal(call.args.at(-1).windowsHide, true)
      }
      const env = { PATH: 'C:\\\\Windows\\\\System32', TEST: 'kept' }
      cp.spawn('cmd.exe', ['/c', 'dir'], { env, windowsHide: false })
      cp.exec('dir', { windowsHide: false }, () => {})
      cp.execFile('git.exe', ['--version'], { windowsHide: false }, () => {})
      const pending = promisify(cp.exec)('dir', { windowsHide: false })
      assert.equal(typeof pending.then, 'function')
      cp.fork('server.cjs', [], { env, windowsHide: false })
      assert.equal(captured.length, 5)
      for (const options of captured) assert.equal(options.windowsHide, true)
      assert.ok(captured[0].envPairs.includes('TEST=kept'))
      assert.ok(captured[4].stdio.includes('ipc'))
    `
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })).toBe('')
  })

  it('keeps invalid synchronous options for Node to reject', () => {
    const { childProcess, originals } = install('win32')
    childProcess.execSync('dir', 'invalid-options')
    expect(originals.execSync).toHaveBeenCalledWith('dir', 'invalid-options')
  })
})
