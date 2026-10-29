import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packaged-command-environment-'))
after(() => fs.rm(directory, { recursive: true, force: true }))
const compiled = path.join(directory, 'environment.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/packaged-command-environment.ts', import.meta.url))], outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { packagedCommandEnvironment, nativeCommandPath, commandOrigin, inspectHostCommands, inspectPackagedToolOrigins } = await import(pathToFileURL(compiled).href)

test('the default policy preserves ordinary packaged-fixture environments without mutating their source', () => {
  const source = { PATH: '/developer/bin:/usr/bin', NODE_PATH: '/developer/modules', SHELL: '/custom/shell' }
  const environment = packagedCommandEnvironment(source, 'inherit', 'darwin')
  assert.deepEqual(environment, source)
  assert.notEqual(environment, source)
  environment.PATH = 'changed copy'
  assert.equal(source.PATH, '/developer/bin:/usr/bin')
})

test('system-only POSIX launches exclude inherited command paths and startup overrides in a real child', async () => {
  const source = { ...process.env, PATH: '/developer/bin:/tooling/bin', Path: '/alternate/tools', NODE_PATH: '/developer/modules', NODE_OPTIONS: '--require=/not/a/test/module', BASH_ENV: '/startup/bash', ENV: '/startup/sh', ZDOTDIR: '/startup/zsh', SHELL: '/custom/bash', AGENT_SHELL: '/custom/zsh', AGENT_GIT_BASH_PATH: '/custom/bash.exe', CLAUDE_CODE_GIT_BASH_PATH: '/custom/other-bash.exe' }
  for (const platform of ['darwin', 'linux']) {
    const environment = packagedCommandEnvironment(source, 'system-only', platform)
    assert.equal(environment.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
    for (const name of ['Path', 'NODE_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELL', 'AGENT_SHELL', 'AGENT_GIT_BASH_PATH', 'CLAUDE_CODE_GIT_BASH_PATH']) assert.equal(environment[name], undefined)
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', "process.stdout.write(JSON.stringify({path:process.env.PATH,nodePath:process.env.NODE_PATH,bashEnv:process.env.BASH_ENV}))"], { env: environment })
    assert.deepEqual(JSON.parse(stdout), { path: environment.PATH })
  }
  assert.equal(source.PATH, '/developer/bin:/tooling/bin')
  assert.equal(source.NODE_PATH, '/developer/modules')
})

test('Windows uses the actual SystemRoot and clears all case variants of command overrides', () => {
  const environment = packagedCommandEnvironment({ SystemRoot: 'D:\\System Windows', Path: 'C:\\developer', PATH: 'C:\\other', node_path: 'C:\\modules', ComSpec: 'C:\\custom\\cmd.exe', PATHEXT: '.EXE;.PY', TEMP: 'D:\\temporary' }, 'system-only', 'win32')
  assert.deepEqual(Object.keys(environment).filter(key => key.toLowerCase() === 'path'), ['PATH'])
  assert.equal(environment.PATH, 'D:\\System Windows\\System32;D:\\System Windows;D:\\System Windows\\System32\\Wbem;D:\\System Windows\\System32\\WindowsPowerShell\\v1.0')
  assert.equal(environment.SystemRoot, 'D:\\System Windows')
  assert.equal(environment.ComSpec, 'D:\\System Windows\\System32\\cmd.exe')
  assert.equal(environment.PATHEXT, '.COM;.EXE;.BAT;.CMD')
  assert.equal(environment.TEMP, 'D:\\temporary')
  assert.equal(environment.node_path, undefined)
  assert.throws(() => packagedCommandEnvironment({}, 'system-only', 'win32'), /absolute Windows SystemRoot/)
  assert.equal(nativeCommandPath('/d/System Windows/rg.exe', 'win32'), 'd:/System Windows/rg.exe')
  assert.equal(nativeCommandPath('rg is a function', 'win32'), null)
})

async function runtimeFixture(context) {
  const root = await fs.mkdtemp(path.join(directory, 'origin-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const bundle = path.join(root, 'Application')
  const resources = process.platform === 'darwin' ? path.join(bundle, 'Contents', 'Resources') : path.join(bundle, 'resources')
  const profile = path.join(root, 'profile')
  const userData = path.join(profile, 'electron-user-data')
  const host = path.join(root, 'host-tools')
  const write = async file => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'Synthetic provenance fixture'); await fs.chmod(file, 0o755); return file }
  const executable = await write(path.join(bundle, 'runtime', process.platform === 'win32' ? 'Application.exe' : 'Application'))
  const rg = await write(path.join(resources, 'tools', process.platform === 'win32' ? 'rg.exe' : 'rg'))
  const node = await write(path.join(host, process.platform === 'win32' ? 'node.exe' : 'node'))
  const shim = await write(path.join(userData, 'office-runtime', 'bin', 'halo-node'))
  const exceljs = await write(path.join(resources, 'office-runtime', 'node_modules', 'exceljs', 'index.js'))
  const docx = await write(path.join(resources, 'office-runtime', 'node_modules', 'docx', 'index.js'))
  const runtime = { platform: process.platform, cwd: profile, commandPath: host, appPath: path.join(resources, 'app.asar'), resources, userData, profile, execPath: executable }
  const outputs = (changes = {}) => ({
    rg: `ACCEPTANCE_RG_PATH=${changes.rg ?? rg}\nripgrep 14.1.1\n`,
    office: `ACCEPTANCE_OFFICE_SHIM=${changes.shim ?? shim}\noffice-runtime-ok\nACCEPTANCE_OFFICE_ORIGIN=${JSON.stringify({ execPath: changes.executable ?? executable, exceljs: changes.exceljs ?? exceljs, docx })}\n`,
  })
  return { root, bundle, resources, profile, host, write, rg, node, shim, exceljs, docx, runtime, outputs }
}

test('reintroduced host rg fails provenance even when a package rg also exists; an unused system node alone does not', async context => {
  const fixture = await runtimeFixture(context)
  const noHostRg = inspectHostCommands(fixture.runtime)
  assert.equal(noHostRg.rg.origin, 'missing')
  assert.equal(noHostRg.node.origin, 'external')
  assert.equal(noHostRg.hostRgExcluded, true)
  const outputs = fixture.outputs()
  assert.equal(inspectPackagedToolOrigins(outputs.rg, outputs.office, fixture.runtime).verified, true)
  const externalRg = await fixture.write(path.join(fixture.host, path.basename(fixture.rg)))
  const contaminated = inspectHostCommands({ ...fixture.runtime, commandPath: fixture.host + path.delimiter + path.dirname(fixture.rg) })
  assert.equal(contaminated.rg.resolvedPath, await fs.realpath(externalRg))
  assert.equal(contaminated.hostRgExcluded, false)
  assert.equal(inspectHostCommands({ ...fixture.runtime, commandPath: path.dirname(fixture.rg) }).rg.origin, 'package')
})

test('the real command receipts must identify a package rg, package executable and package Office libraries', async context => {
  const fixture = await runtimeFixture(context)
  const valid = fixture.outputs()
  const observed = inspectPackagedToolOrigins(valid.rg, valid.office, fixture.runtime)
  assert.equal(observed.verified, true)
  assert.equal(observed.office.shim.origin, 'generated-shim')
  assert.equal(observed.office.executable.origin, 'package')
  const external = await fixture.write(path.join(fixture.host, 'external-runtime'))
  for (const changes of [{ rg: external }, { executable: fixture.node }, { exceljs: external }, { shim: external }]) {
    const output = fixture.outputs(changes)
    assert.equal(inspectPackagedToolOrigins(output.rg, output.office, fixture.runtime).verified, false)
  }
  assert.equal(inspectPackagedToolOrigins('ripgrep 15.2.0', 'office-runtime-ok', fixture.runtime).verified, false)
  assert.equal(inspectPackagedToolOrigins(valid.rg + valid.rg, valid.office, fixture.runtime).verified, false)
})

test('package-looking aliases cannot conceal an external binary or library', async context => {
  const fixture = await runtimeFixture(context)
  const outside = path.join(fixture.root, 'external-package-files')
  await fixture.write(path.join(outside, 'rg'))
  await fixture.write(path.join(outside, 'index.js'))
  const link = path.join(fixture.resources, 'linked-tools')
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(commandOrigin(path.join(link, 'rg'), fixture.runtime).origin, 'external')
  const output = fixture.outputs({ exceljs: path.join(link, 'index.js') })
  assert.equal(inspectPackagedToolOrigins(output.rg, output.office, fixture.runtime).verified, false)
  assert.equal(commandOrigin('rg is a function', fixture.runtime).origin, 'unverified')
})

test('an Office shim directory redirected outside the isolated profile is not generated-shim evidence', async context => {
  const fixture = await runtimeFixture(context)
  const outside = path.join(fixture.root, 'outside-shims')
  const externalShim = await fixture.write(path.join(outside, 'halo-node'))
  const shimDirectory = path.dirname(fixture.shim)
  await fs.rename(shimDirectory, `${shimDirectory}-original`)
  await fs.symlink(outside, shimDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  const origin = commandOrigin(fixture.shim, fixture.runtime, true)
  assert.equal(origin.resolvedPath, await fs.realpath(externalShim))
  assert.equal(origin.origin, 'external')
  const output = fixture.outputs()
  const observed = inspectPackagedToolOrigins(output.rg, output.office, fixture.runtime)
  assert.equal(observed.office.shim.origin, 'external')
  assert.equal(observed.office.executable.origin, 'package')
  assert.equal(observed.office.libraries.exceljs.origin, 'package')
  assert.equal(observed.verified, false)
})

test('an unambiguous rg alias still needs a real package-owned target, including safely quoted spaces', async context => {
  const fixture = await runtimeFixture(context)
  const portable = value => value.replaceAll('\\', '/')
  const rg = portable(fixture.rg)
  const spaced = portable(await fixture.write(path.join(fixture.resources, 'tools with spaces', path.basename(fixture.rg))))
  for (const reported of [`alias rg=${rg}`, `alias rg='${rg}'`, `alias rg="${rg}"`, `alias rg='"${spaced}"'`, `alias rg="'${spaced}'"`]) {
    const output = fixture.outputs({ rg: reported })
    const observed = inspectPackagedToolOrigins(output.rg, output.office, fixture.runtime)
    assert.equal(observed.rg.origin, 'package', reported)
    assert.equal(observed.rg.requestedPath, reported)
    assert.equal(observed.verified, true)
  }
  const external = portable(await fixture.write(path.join(fixture.host, path.basename(fixture.rg))))
  const output = fixture.outputs({ rg: `alias rg=${external}` })
  const observed = inspectPackagedToolOrigins(output.rg, output.office, fixture.runtime)
  assert.equal(observed.rg.origin, 'external')
  assert.equal(observed.verified, false)
})

test('rg aliases with flags, multiple commands, substitutions or functions cannot establish command provenance', async context => {
  const fixture = await runtimeFixture(context)
  const rg = fixture.rg.replaceAll('\\', '/')
  // A matching file on disk must not make a multiword alias expansion acceptable.
  await fixture.write(`${fixture.rg} --hidden`)
  const rejected = [
    `alias rg=${rg} --hidden`, `alias rg='${rg} --hidden'`,
    `alias rg='${rg}; printf injected'`, `alias rg='${rg} | cat'`,
    `alias rg='${rg} && printf injected'`, `alias rg='${rg} > output'`,
    `alias rg='$(printf ${rg})'`, 'alias rg="`printf substituted`"',
    `alias rg='${rg}*'`, `alias rg='${rg}' extra`,
    `rg() { ${rg}; }`, `alias other=${rg}`, 'alias rg=relative/rg',
  ]
  for (const reported of rejected) {
    const output = fixture.outputs({ rg: reported })
    const observed = inspectPackagedToolOrigins(output.rg, output.office, fixture.runtime)
    assert.equal(observed.rg.origin, 'unverified', reported)
    assert.equal(observed.verified, false)
  }
})
