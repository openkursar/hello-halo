import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from 'fs'
import { basename, join } from 'path'
import { CliToolStore, validateCredentialBinding, type CliCredentialBinding } from '../../../../src/main/services/cli-tools'
import { makeTempDir, removeTree, writePackage } from './helpers'

const ID = 'com.example.tool'
const OTHER = 'com.example.other'
const SECRET = 'tok-secret-0123456789'

let dir: string
let pkgs: string
let root: string
let credFile: string
let logs: string[]

const printEnv = (version: string) => ({
  'bin/tool.js': `console.log(JSON.stringify({ v: ${JSON.stringify(version)}, token: process.env.TOOL_TOKEN ?? null, host: process.env.TOOL_HOST ?? null }))\n`,
  'package.json': JSON.stringify({ name: 'tool', version }),
})

function binding(overrides: Partial<CliCredentialBinding> = {}): CliCredentialBinding {
  return { toolId: ID, env: 'TOOL_TOKEN', file: credFile, staticEnv: { TOOL_HOST: 'http://127.0.0.1:9' }, ...overrides }
}

function newStore(bindings: CliCredentialBinding[] = [binding()]): CliToolStore {
  const sink = (...args: unknown[]) => { logs.push(JSON.stringify(args)) }
  return new CliToolStore({
    root,
    runtimePath: process.execPath,
    runtimeNodeVersion: process.versions.node,
    log: { log: sink, error: sink },
    credentialBindings: bindings,
  })
}

function run(binDir: string, command = 'tool', env: Record<string, string> = {}): { token: string | null; host: string | null } {
  const result = spawnSync(join(binDir, command), [], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', ...env } })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!)
}

function writeCredential(token: string, expiresAt: number): void {
  writeFileSync(credFile, JSON.stringify({ token, expiresAt }), { mode: 0o600 })
}

/** Every file of a view, skills included, for leak checks. */
function viewText(binDir: string): string {
  const viewDir = join(binDir, '..')
  const files = (readdirSync(viewDir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
  return files.map(f => readFileSync(f, 'utf-8')).join('\n')
}

beforeEach(() => {
  dir = makeTempDir()
  pkgs = join(dir, 'pkgs')
  root = join(dir, 'cli')
  credFile = join(dir, 'identity', 'aud.json')
  mkdirSync(pkgs)
  mkdirSync(join(dir, 'identity'))
  logs = []
})

afterEach(() => {
  removeTree(dir)
})

describe.skipIf(process.platform === 'win32')('cli-tools credential binding', () => {
  it('gives a catalog tool the credential only while the file holds an unexpired value', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { payload: printEnv('1.0.0') }), { source: 'catalog' })
    const { binDir } = await store.pinExecution({ executionId: 'e1', entry: 'chat', engine: 'claude' })

    // Not signed in: an inherited value is removed, the fixed address is set.
    expect(run(binDir!, 'tool', { TOOL_TOKEN: 'inherited' })).toEqual({ v: '1.0.0', token: null, host: 'http://127.0.0.1:9' })

    writeCredential(SECRET, Date.now() + 60_000)
    expect(run(binDir!).token).toBe(SECRET)

    writeCredential(SECRET, Date.now() - 1)
    expect(run(binDir!).token).toBeNull()

    writeFileSync(credFile, 'not json')
    expect(run(binDir!).token).toBeNull()

    // Nothing the agent or a log can see carries the value.
    writeCredential(SECRET, Date.now() + 60_000)
    expect(viewText(binDir!)).not.toContain(SECRET)
    expect(logs.join('\n')).not.toContain(SECRET)
    const guide = readFileSync(join(binDir!, '..', 'TOOLS.md'), 'utf-8')
    expect(guide).toContain('enterprise sign-in (provided by Halo)')
    expect(guide).toContain('Never ask for, print, store or pass a credential')
    expect(guide).toContain('organization icon beside the send button')
    const skill = await (await store.readCurrentToolSkills()).skills[0].describe()
    expect(skill.body).not.toMatch(/enterprise sign-in|organization icon/i)
    expect(skill.body).not.toContain(SECRET)
  })

  it('binds a version shipped with the build', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { payload: printEnv('1.0.0') }), { source: 'preset' })
    const { binDir } = await store.pinExecution({ executionId: 'e1', entry: 'chat', engine: 'claude' })
    writeCredential(SECRET, Date.now() + 60_000)
    expect(run(binDir!).token).toBe(SECRET)
  })

  it('never binds a user import or another tool', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { payload: printEnv('1.0.0') }), { source: 'user-import' })
    await store.importPackage(writePackage(pkgs, { id: OTHER, payload: printEnv('1.0.0'), commands: [{ name: 'other', entry: 'bin/tool.js' }] }), { source: 'catalog' })
    writeCredential(SECRET, Date.now() + 60_000)
    const { binDir } = await store.pinExecution({ executionId: 'e1', entry: 'chat', engine: 'claude' })
    expect(run(binDir!, 'tool')).toEqual({ v: '1.0.0', token: null, host: null })
    expect(run(binDir!, 'other')).toEqual({ v: '1.0.0', token: null, host: null })
    expect(readdirSync(join(binDir!, '..')).filter(f => f.startsWith('credential-'))).toEqual([])
    expect(readFileSync(join(binDir!, '..', 'TOOLS.md'), 'utf-8')).not.toContain('enterprise sign-in')
  })

  it('switches to the bound launcher when the catalog version becomes current, and back', async () => {
    const store = newStore()
    await store.importPackage(writePackage(pkgs, { payload: printEnv('1.0.0') }), { source: 'catalog' })
    await store.importPackage(writePackage(pkgs, { version: '2.0.0', payload: printEnv('2.0.0') }), { source: 'user-import' })
    writeCredential(SECRET, Date.now() + 60_000)
    const user = await store.pinExecution({ executionId: 'e1', entry: 'chat', engine: 'claude' })
    expect(run(user.binDir!)).toMatchObject({ v: '2.0.0', token: null })
    await store.activateVersion(ID, '1.0.0')
    const catalog = await store.pinExecution({ executionId: 'e2', entry: 'chat', engine: 'claude' })
    expect(run(catalog.binDir!)).toMatchObject({ v: '1.0.0', token: SECRET })
  })

  it('keeps the view of unbound tools unchanged', async () => {
    await newStore([]).importPackage(writePackage(pkgs, { payload: printEnv('1.0.0') }), { source: 'catalog' })
    const plain = await newStore([]).pinExecution({ executionId: 'e1', entry: 'chat', engine: 'claude' })
    const elsewhere = await newStore([binding({ toolId: OTHER })]).pinExecution({ executionId: 'e2', entry: 'chat', engine: 'claude' })
    const bound = await newStore().pinExecution({ executionId: 'e3', entry: 'chat', engine: 'claude' })
    expect(basename(join(elsewhere.binDir!, '..'))).toBe(basename(join(plain.binDir!, '..')))
    expect(bound.binDir).not.toBe(plain.binDir)
  })

  it('ignores an invalid binding and logs only the field', async () => {
    const store = newStore([binding({ env: 'NODE_OPTIONS' })])
    await store.importPackage(writePackage(pkgs, { payload: printEnv('1.0.0') }), { source: 'catalog' })
    const { binDir } = await store.pinExecution({ executionId: 'e1', entry: 'chat', engine: 'claude' })
    writeCredential(SECRET, Date.now() + 60_000)
    expect(run(binDir!).token).toBeNull()
    expect(logs.join('\n')).toContain('Credential binding ignored')
  })
})

describe('cli-tools credential binding validation', () => {
  const base: CliCredentialBinding = { toolId: ID, env: 'TOOL_TOKEN', file: '/abs/aud.json' }
  it('accepts a plain binding', () => {
    expect(validateCredentialBinding({ ...base, staticEnv: { TOOL_HOST: 'x' } })).toEqual({ ok: true, binding: { ...base, staticEnv: { TOOL_HOST: 'x' } } })
  })
  it.each([
    [{ env: 'PATH' }, 'env'],
    [{ env: 'NODE_OPTIONS' }, 'env'],
    [{ env: 'DYLD_INSERT_LIBRARIES' }, 'env'],
    [{ env: 'ELECTRON_RUN_AS_NODE' }, 'env'],
    [{ env: '1BAD' }, 'env'],
    [{ file: 'relative.json' }, 'file'],
    [{ toolId: '' }, 'toolId'],
    [{ staticEnv: { TOOL_TOKEN: 'x' } }, 'staticEnv name'],
    [{ staticEnv: { LD_PRELOAD: 'x' } }, 'staticEnv name'],
    [{ staticEnv: { TOOL_HOST: 'a\0b' } }, 'staticEnv value'],
  ])('rejects %j', (patch, field) => {
    expect(validateCredentialBinding({ ...base, ...patch } as CliCredentialBinding)).toEqual({ ok: false, field })
  })
})
