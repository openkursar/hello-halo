import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { prerequisiteFailures, terminalShellFailure } from '../../../scripts/acceptance/lib/execution.mjs'

async function trackProbeDirectories(context) {
  const directories = []
  const create = fs.mkdtemp.bind(fs)
  context.mock.method(fs, 'mkdtemp', async (...args) => {
    const directory = await create(...args)
    directories.push(directory)
    return directory
  })
  context.after(async () => {
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true })
  })
  return directories
}

test('file-link readiness probes the host without retaining its temporary files', async context => {
  const directories = await trackProbeDirectories(context)
  const problems = await prerequisiteFailures(process.cwd(), { requirements: ['file-symlinks'] })
  if (process.platform !== 'win32') assert.deepEqual(problems, [])
  else assert(problems.length === 0 || problems.every(problem => /File symbolic-link creation and reading are unavailable/.test(problem)))
  assert.equal(directories.length, 1)
  await assert.rejects(fs.access(directories[0]), { code: 'ENOENT' })
})

test('a denied file-link operation becomes an explicit prerequisite failure and still cleans its probe', async context => {
  const directories = await trackProbeDirectories(context)
  context.mock.method(fs, 'symlink', async () => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }) })
  const problems = await prerequisiteFailures(process.cwd(), { requirements: ['file-symlinks'] })
  assert.deepEqual(problems, ['File symbolic-link creation and reading are unavailable (EPERM)'])
  assert.equal(directories.length, 1)
  await assert.rejects(fs.access(directories[0]), { code: 'ENOENT' })
})

function shellProbe(overrides = {}) {
  const calls = []
  const options = {
    platform: 'darwin', environment: { PATH: '/unowned/commands', SHELL: '/unowned/shell' },
    stat: async file => { calls.push({ operation: 'stat', file }); return { isFile: () => true } },
    access: async (file, mode) => { calls.push({ operation: 'access', file, mode }) },
    run: async (file, args, settings) => { calls.push({ operation: 'run', file, args, settings }); return { stdout: 'HALO_ACCEPTANCE_POWERSHELL_READY', stderr: '' } },
    ...overrides,
  }
  return { calls, options }
}

test('the macOS terminal prerequisite checks only the fixed executable without running a profile or borrowing PATH', async () => {
  const probe = shellProbe()
  assert.equal(await terminalShellFailure(probe.options), null)
  assert.deepEqual(probe.calls, [{ operation: 'stat', file: '/bin/bash' }, { operation: 'access', file: '/bin/bash', mode: fsConstants.X_OK }])
  assert.deepEqual(probe.options.environment, { PATH: '/unowned/commands', SHELL: '/unowned/shell' })
})

test('missing or non-executable fixed shells yield a clear block without exposing exception contents', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const probe = shellProbe({ access: async () => { throw Object.assign(new Error('private path and credential payload'), { code }) } })
    assert.equal(await terminalShellFailure(probe.options), `The fixed macOS /bin/bash shell is unavailable (${code})`)
    assert.equal(probe.calls.some(call => call.operation === 'run'), false)
  }
  const directory = shellProbe({ stat: async () => ({ isFile: () => false }) })
  assert.match(await terminalShellFailure(directory.options), /not a regular executable file/)
  assert.deepEqual(directory.calls, [])
})

test('simulated Windows checks use the absolute OS shell and one bounded profile-free read-only command', async () => {
  for (const environment of [{ SystemRoot: 'C:\\Windows', WINDIR: 'D:\\Other', PATH: 'Z:\\unowned' }, { WINDIR: 'D:/Operating System', PATH: 'Z:\\unowned' }]) {
    const before = structuredClone(environment)
    const probe = shellProbe({ platform: 'win32', environment })
    assert.equal(await terminalShellFailure(probe.options), null)
    const expected = environment.SystemRoot ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'D:\\Operating System\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    assert.equal(probe.calls.filter(call => call.operation === 'run').length, 1)
    assert.equal(probe.calls[0].file, expected)
    assert.deepEqual(probe.calls[1], { operation: 'access', file: expected, mode: fsConstants.F_OK })
    const invoked = probe.calls[2]
    assert.equal(invoked.file, expected)
    assert.deepEqual(invoked.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.Write('HALO_ACCEPTANCE_POWERSHELL_READY')"])
    assert.deepEqual(invoked.settings, { timeout: 3000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true, shell: false })
    assert.equal(Object.hasOwn(invoked.settings, 'env'), false)
    assert.deepEqual(environment, before)
  }
})

test('simulated Windows never resolves a relative, UNC, missing or substituted system root through PATH', async () => {
  for (const environment of [{}, { SystemRoot: 'Windows' }, { SystemRoot: 'C:Windows' }, { SystemRoot: '\\Windows' }, { SystemRoot: '\\\\server\\share' }, { SystemRoot: '%SYSTEMROOT%' }, { SystemRoot: 'C:\\Windows\nprivate' }]) {
    const probe = shellProbe({ platform: 'win32', environment: { PATH: 'C:\\fallback', ...environment } })
    assert.match(await terminalShellFailure(probe.options), /absolute local SystemRoot or WINDIR/)
    assert.deepEqual(probe.calls, [])
  }
})

test('simulated Windows startup failures or wrong receipts remain blocked without serializing stdout, stderr or paths', async () => {
  const failures = [
    Object.assign(new Error('private credential'), { code: 'ENOENT', stdout: 'private stdout', stderr: 'private stderr' }),
    Object.assign(new Error('private credential'), { code: 1, stdout: 'private stdout', stderr: 'private stderr' }),
    Object.assign(new Error('private credential'), { killed: true, code: null, stderr: 'private stderr' }),
  ]
  for (const failure of failures) {
    const probe = shellProbe({ platform: 'win32', environment: { SystemRoot: 'C:\\Private Root' }, run: async () => { throw failure } })
    const result = await terminalShellFailure(probe.options)
    assert.match(result, /PowerShell.*unavailable/)
    assert.doesNotMatch(result, /private|Private Root|stdout|stderr|credential/)
  }
  const wrong = shellProbe({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, run: async () => ({ stdout: 'private unexpected output', stderr: 'private stderr' }) })
  assert.equal(await terminalShellFailure(wrong.options), 'Windows PowerShell did not return its read-only startup receipt')
})

test('unsupported interactive-terminal platforms are blocked before filesystem or command probing', async () => {
  const probe = shellProbe({ platform: 'linux' })
  assert.match(await terminalShellFailure(probe.options), /macOS or Windows.*unsupported/)
  assert.deepEqual(probe.calls, [])
})

test('the registered prerequisite reports actual host shell readiness', async () => {
  const missing = await prerequisiteFailures(process.cwd(), { requirements: ['terminal-shell'] })
  if (process.platform === 'darwin') assert.deepEqual(missing, [])
  else if (process.platform === 'linux') assert.match(missing.join('; '), /host is unsupported/)
  else assert(missing.length === 0 || missing.every(reason => /Windows/.test(reason)))
})
