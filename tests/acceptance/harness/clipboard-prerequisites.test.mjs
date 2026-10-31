import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { macClipboardFailure } from '../../../scripts/acceptance/lib/clipboard-readiness.mjs'
import { prerequisiteFailures } from '../../../scripts/acceptance/lib/execution.mjs'

function clipboardProbe(overrides = {}) {
  const calls = []
  const root = '/fixture/project'
  const directory = '/fixture/owned-probe'
  const developer = '/fixture/selected-developer'
  const compiler = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc')
  const appKit = path.join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/AppKit.framework')
  let compiled = false
  const files = new Set(['/usr/bin/xcode-select', '/usr/bin/xcrun', compiler, path.join(root, 'tests/e2e/fixtures/clipboard-macos.swift')])
  const directories = new Set([developer, appKit])
  const filesystem = {
    async stat(file) {
      calls.push({ operation: 'stat', file })
      return { isFile: () => files.has(file) || (compiled && file === path.join(directory, 'clipboard')), isDirectory: () => directories.has(file) }
    },
    async access(file, mode) { calls.push({ operation: 'access', file, mode }) },
    async mkdtemp(prefix) { calls.push({ operation: 'mkdtemp', prefix }); return directory },
    async readFile(file, encoding) { calls.push({ operation: 'readFile', file, encoding }); return developer },
    async rm(file, options) { calls.push({ operation: 'rm', file, options }) },
  }
  const environment = { PATH: '/unowned/bin', HOME: '/fixture/private-home' }
  const options = { platform: 'darwin', environment, filesystem,
    async run(cwd, args, settings) {
      calls.push({ operation: 'run', cwd, args, settings })
      if (settings.executable === '/usr/bin/xcrun') compiled = true
      return { code: 0, timedOut: false, cleanupFailed: false, log: 'private compiler output must never be returned' }
    },
    ...overrides,
  }
  return { root, directory, developer, compiler, appKit, files, directories, filesystem, calls, options, environment }
}

test('the clipboard prerequisite uses owned bounded selection and compiles the public AppKit helper without running it or accessing clipboard contents', async () => {
  const fixture = clipboardProbe()
  const before = structuredClone(fixture.environment)
  assert.equal(await macClipboardFailure(fixture.root, fixture.options), null)
  const runs = fixture.calls.filter(call => call.operation === 'run')
  assert.equal(runs.length, 2)
  assert.equal(runs[0].settings.executable, process.execPath)
  assert.equal(runs[0].args[0], '-e')
  assert.match(runs[0].args[1], /execFileSync\('\/usr\/bin\/xcode-select', \['-p'\]/)
  assert.doesNotMatch(runs[0].args[1], /xcrun|--install|NSPasteboard|capture|restore/)
  assert.equal(runs[0].args[2], path.join(fixture.directory, 'developer-directory.txt'))
  assert.equal(runs[0].settings.timeoutMs, 5000)
  assert.deepEqual(runs[1].args, ['--no-cache', 'swiftc', '-O', '-module-cache-path', path.join(fixture.directory, 'module-cache'), path.join(fixture.root, 'tests/e2e/fixtures/clipboard-macos.swift'), '-o', path.join(fixture.directory, 'clipboard')])
  assert.equal(runs[1].settings.executable, '/usr/bin/xcrun')
  assert.equal(runs[1].settings.environment.DEVELOPER_DIR, fixture.developer)
  assert.equal(runs[1].settings.environment.TMPDIR, fixture.directory + path.sep)
  assert.equal(runs[1].settings.environment.CLANG_MODULE_CACHE_PATH, path.join(fixture.directory, 'module-cache'))
  assert.equal(runs[1].settings.timeoutMs, 30000)
  assert(runs.every(call => call.settings.producerRole === 'clipboard-readiness'))
  const compileIndex = fixture.calls.indexOf(runs[1])
  for (const file of [fixture.developer, fixture.compiler, fixture.appKit]) assert(fixture.calls.slice(0, compileIndex).some(call => call.operation === 'stat' && call.file === file))
  assert.deepEqual(fixture.calls.at(-1), { operation: 'rm', file: fixture.directory, options: { recursive: true, force: true } })
  assert.deepEqual(fixture.environment, before)
})

test('platforms without the complete-format native backend remain blocked without commands or filesystem probes', async () => {
  for (const platform of ['win32', 'linux']) {
    const fixture = clipboardProbe({ platform })
    assert.match(await macClipboardFailure(fixture.root, fixture.options), /requires the macOS AppKit fixture.*no full-format fixture backend/)
    assert.deepEqual(fixture.calls, [])
  }
})

test('missing selected tools or SDKs block before invoking xcrun and never request installation', async () => {
  for (const missing of ['selector', 'developer', 'compiler', 'sdk', 'custom-toolchain']) {
    const fixture = clipboardProbe()
    if (missing === 'selector') fixture.files.delete('/usr/bin/xcode-select')
    if (missing === 'developer') fixture.directories.delete(fixture.developer)
    if (missing === 'compiler') fixture.files.delete(fixture.compiler)
    if (missing === 'sdk') fixture.directories.delete(fixture.appKit)
    if (missing === 'custom-toolchain') fixture.options.environment.TOOLCHAINS = 'unowned-toolchain'
    assert.match(await macClipboardFailure(fixture.root, fixture.options), /requires installed|selected.*unavailable|no executable Swift|no macOS SDK|custom Swift toolchain/)
    assert.equal(fixture.calls.filter(call => call.operation === 'run' && call.settings.executable === '/usr/bin/xcrun').length, 0)
  }
})

test('selection errors, invalid selected paths and compiler failures return redacted readiness failures and clean owned files', async () => {
  for (const failure of ['selection', 'relative-path', 'compiler', 'timeout']) {
    const fixture = clipboardProbe()
    const run = fixture.options.run
    fixture.options.run = async (...args) => {
      const result = await run(...args)
      if ((failure === 'selection' && args[2].executable === process.execPath) || (['compiler', 'timeout'].includes(failure) && args[2].executable === '/usr/bin/xcrun')) return { ...result, code: 1, timedOut: failure === 'timeout', log: 'private directory and credentials' }
      return result
    }
    if (failure === 'relative-path') fixture.filesystem.readFile = async () => 'relative/developer'
    const reason = await macClipboardFailure(fixture.root, fixture.options)
    assert.match(reason, /developer directory|could not build/)
    assert.doesNotMatch(reason, /private|credential|fixture\/|compiler output/)
    assert(fixture.calls.some(call => call.operation === 'rm'))
  }
})

test('unconfirmed process exit retains its owned files and cannot be called ready', async () => {
  for (const rejected of [false, true]) {
    const fixture = clipboardProbe()
    fixture.options.run = async () => {
      if (rejected) throw new Error('private process payload')
      return { code: 1, timedOut: true, cleanupFailed: true, log: 'private process payload' }
    }
    assert.match(await macClipboardFailure(fixture.root, fixture.options), /exit is unconfirmed.*retained/)
    assert.equal(fixture.calls.some(call => call.operation === 'rm'), false)
  }
})

test('a failed owned-directory removal blocks readiness without disclosing error contents', async () => {
  const fixture = clipboardProbe()
  fixture.filesystem.rm = async () => { throw new Error('private path') }
  assert.equal(await macClipboardFailure(fixture.root, fixture.options), 'Owned clipboard readiness files could not be removed; readiness is unconfirmed')
})

test('the registered prerequisite invokes only its selected instance and preserves missing-backend blocks', async () => {
  const calls = []
  const options = { clipboardProbe: async root => { calls.push(root); return 'Synthetic complete-format clipboard backend is unavailable' } }
  assert.deepEqual(await prerequisiteFailures('/fixture/project', { requirements: [] }, options), [])
  assert.deepEqual(calls, [])
  assert.deepEqual(await prerequisiteFailures('/fixture/project', { requirements: ['mac-clipboard'] }, options), ['Synthetic complete-format clipboard backend is unavailable'])
  assert.deepEqual(calls, ['/fixture/project'])
})
