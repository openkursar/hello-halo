import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import { createSkillLibrary, subscribeToolSkillSync } from '../../../../src/main/apps/skills'
import { cliSkillName } from '../../../../src/main/services/cli-tools/skills'
import { signedBytes, signedGuideBytes, signedSkillBytes } from '../../../../src/main/services/cli-tools/signature'
import { buildManifest, removeTree, writePackage, type PackageSpec } from '../../services/cli-tools/helpers'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => globalThis.__HALO_TEST_DIR__,
}))

const id = 'example.offline'
const version = '1.0.0'
const launchName = 'test-offline-fixture'
const packageSpec: PackageSpec = {
  id, version, commands: [{ name: launchName, entry: 'bin/tool.js' }],
  manifest: { guide: 'guide/usage.md' },
  extra: { 'guide/usage.md': '---\ndescription: Archive description\n---\nArchive usage\n' },
}
const skillName = cliSkillName(id)
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
function guide(description: string, marker: string, revision = 1) {
  const content = `---\ndescription: ${description}\n---\n${marker}\n`
  return { revision, sha256: hash(content), content, signature: null }
}

let root: string
let presetDir: string
let toolRoot: string
let archive: string
let archiveBytes: Buffer

beforeEach(() => {
  root = realpathSync(globalThis.__HALO_TEST_DIR__)
  globalThis.__HALO_TEST_DIR__ = root
  presetDir = join(root, 'preset')
  toolRoot = join(root, 'cli')
  mkdirSync(presetDir)
  archive = join(presetDir, `${id}-${version}.hcli`)
  renameSync(writePackage(root, packageSpec), archive)
  archiveBytes = readFileSync(archive)
})

afterEach(() => { removeTree(root) })

function catalogEntry(overrides: Record<string, unknown> = {}) {
  return { id, source: 'builtin', revoked: false, versions: [], ...overrides }
}

function exactEntry(overrides: Record<string, unknown> = {}) {
  return {
    version, manifestSchema: 'halo.cli/1', archiveSha256: hash(archiveBytes), integrity: String(buildManifest(packageSpec).integrity),
    downloadUrl: '/unused/offline.hcli', ...overrides,
  }
}

function writeCatalog(...tools: Record<string, unknown>[]) {
  writeFileSync(join(presetDir, 'catalog.json'), JSON.stringify({ schema: 'halo.cli.catalog/1', tools }))
}

async function boot() {
  vi.resetModules()
  const host = await import('../../../../src/main/services/cli-tools')
  host.initCliTools({ root: toolRoot, presetDir, runtimePath: process.execPath })
  return host
}

type Host = Awaited<ReturnType<typeof boot>>

async function checkPin(host: Host, marker: string) {
  const env: Record<string, string> = {}
  const bin = await host.applyCliToolsEnv(env, { entry: 'terminal', engine: 'test' })
  checkLauncher(bin, marker)
}

function checkLauncher(bin: string | null | undefined, marker: string) {
  expect(bin).toBeTruthy()
  const index = readFileSync(join(bin!, '..', 'TOOLS.md'), 'utf8')
  const row = index.split('\n').find(line => line.startsWith(`| \`${launchName}\` | ${id} |`))
  expect(row).toBeTruthy()
  const linked = row?.match(/\| `([^`]+)` \|$/)?.[1]
  expect(linked).toBeTruthy()
  expect(readFileSync(linked!, 'utf8')).toContain(marker)
  const cmd = join(bin!, process.platform === 'win32' ? `${launchName}.cmd` : launchName)
  const stdout = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/c', cmd], { encoding: 'utf8' })
    : execFileSync(cmd, { encoding: 'utf8' })
  expect(stdout.trim()).toBe('hello 1.0.0')
}

function setupSkillLibrary() {
  const db = createDatabaseManager(join(root, 'database'))
  const appDb = db.getAppDatabase()
  db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)
  const manager = createAppManagerService({
    store: new AppManagerStore(appDb), getSpacePath: () => null, getAppDataPath: () => null,
    getGlobalAppDir: () => join(root, 'halo'), trashItem: async () => { throw new Error('Unexpected removal') },
  })
  const library = createSkillLibrary({ context: spaceId => ({
    manager, spaceId, haloDir: join(root, 'halo'), workDir: null, spaceDataPath: null, legacyGlobalRoots: [],
  }), trash: async () => { throw new Error('Unexpected removal') }, openFolder: () => undefined })
  return { db, manager, library }
}

async function coldSession(config: 'preset' | 'empty' | 'unconfigured' = 'preset') {
  vi.resetModules()
  const host = await import('../../../../src/main/services/cli-tools')
  const { createCliToolSkillStartup } = await import('../../../../src/main/bootstrap/cli-tool-skills')
  const { registerAppBridge } = await import('../../../../src/main/services/app-bridge')
  const { buildUserSessionSdkOptions } = await import('../../../../src/main/services/agent/sdk-config')
  const { prepareSessionSkills } = await import('../../../../src/main/services/agent/skill-availability')
  const startup = createCliToolSkillStartup(join(toolRoot, 'skill-sync-stamp'))
  const synchronize = vi.fn(startup.afterPrepare)
  if (config !== 'unconfigured') host.initCliTools({
    root: toolRoot, presetDir: config === 'empty' ? null : presetDir, runtimePath: process.execPath, prepareSessionSkills: synchronize,
  })
  const start = async () => {
    const options = await buildUserSessionSdkOptions({
      engineId: 'halo', cliToolsEntry: 'chat', spaceId: 'test-space', conversationId: 'test-conversation',
      workDir: root, electronPath: process.execPath, credentials: {
        anthropicBaseUrl: 'http://127.0.0.1:1', anthropicApiKey: '', sdkModel: 'synthetic-model', displayModel: 'synthetic-model',
      },
    })
    return { ...await prepareSessionSkills(options), bin: options.env[host.CLI_TOOLS_BIN_ENV] as string | undefined }
  }
  return { host, startup, synchronize, start, registerAppBridge }
}

it('materializes the offline CLI skill before the immediate first session discovers it, without executing idle preparation', async () => {
  const { db, manager, library } = setupSkillLibrary()
  const { host, startup, synchronize, start, registerAppBridge } = await coldSession()
  const file = join(root, '.agents', 'skills', skillName, 'SKILL.md')
  const offline = guide('Cold-start guide description', 'Cold-start usage')
  writeCatalog(catalogEntry({ versions: [exactEntry({ guide: offline })] }))
  try {
    const pending = start()
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce())
    expect(existsSync(file)).toBe(false)
    const terminal = await host.applyCliToolsEnv({}, { entry: 'terminal', engine: 'test' })
    expect(terminal).toBeTruthy()
    expect(synchronize).toHaveBeenCalledOnce()
    startup.attachManager(manager)
    registerAppBridge({ getAppManager: () => manager, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
      getEffectiveSkillCatalog: library.effectiveCatalog })
    const first = await pending
    expect(first.catalog).toEqual([{ name: skillName, description: 'Cold-start guide description', source: { kind: 'file', path: file } }])
    expect(readFileSync(file, 'utf8')).toContain('HALO_CLI_TOOLS_BIN/../TOOLS.md')
    checkLauncher(first.bin, 'Cold-start usage')
    expect(startup.afterPrepare()).toBeUndefined()
  } finally {
    await startup.dispose()
    db.closeAll()
  }
})

it.each(['empty', 'unconfigured'] as const)('does not wait for CLI skill synchronization on a %s installation', async config => {
  const { startup, synchronize, start, registerAppBridge } = await coldSession(config)
  registerAppBridge({ getAppManager: () => null, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
    getEffectiveSkillCatalog: () => [] })
  try {
    expect(await start()).toEqual({ catalog: [], bin: undefined })
    expect(synchronize).not.toHaveBeenCalled()
  } finally { await startup.dispose() }
})

it('keeps the session runnable after a static skill write failure and retries it on the next session', async () => {
  const { db, manager, library } = setupSkillLibrary()
  const { startup, start, registerAppBridge } = await coldSession()
  const upsert = vi.spyOn(manager, 'reconcileManagedToolSkill').mockRejectedValueOnce(new Error('Controlled skill write failure'))
  registerAppBridge({ getAppManager: () => manager, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
    getEffectiveSkillCatalog: library.effectiveCatalog })
  startup.attachManager(manager)
  try {
    const first = await start()
    expect(first.catalog).toEqual([])
    checkLauncher(first.bin, 'Archive usage')
    const second = await start()
    expect(second.catalog).toEqual([expect.objectContaining({ name: skillName, description: 'Archive description' })])
    expect(upsert).toHaveBeenCalledTimes(2)
  } finally {
    await startup.dispose()
    db.closeAll()
  }
})

it('releases a session waiting for App Manager if startup is abandoned', async () => {
  const { startup, synchronize, start, registerAppBridge } = await coldSession()
  registerAppBridge({ getAppManager: () => null, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
    getEffectiveSkillCatalog: () => [] })
  const pending = start()
  await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce())
  await startup.dispose()
  expect((await pending).bin).toBeTruthy()
})

it('bounds the wait when App Manager never becomes ready', async () => {
  const { startup, synchronize, start, registerAppBridge } = await coldSession()
  registerAppBridge({ getAppManager: () => null, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
    getEffectiveSkillCatalog: () => [] })
  const realSetTimeout = globalThis.setTimeout
  const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) =>
    realSetTimeout(handler, delay === 10_000 ? 10 : delay, ...args))
  try {
    const session = await start()
    expect(synchronize).toHaveBeenCalledOnce()
    expect(session.catalog).toEqual([])
    expect(session.bin).toBeTruthy()
  } finally {
    timeout.mockRestore()
    await startup.dispose()
  }
})

it('lists the real static skill on fresh offline install, follows its pinned guide and command, and preserves customization on a sidecar-only change', async () => {
  const { db, manager, library } = setupSkillLibrary()
  const pushSkills = async (host: Host) => {
    const sync = subscribeToolSkillSync({
      stampPath: join(root, 'skill-sync'), onDidChange: host.onDidChangeCurrentTools, readSnapshot: host.readCurrentToolSkills,
      upsert: skill => manager.reconcileManagedToolSkill(skill), remove: toolId => manager.removeManagedToolSkill(toolId),
      listManagedIds: () => manager.listManagedToolSkillIds(),
    })
    try {
      await host.prepareCliTools()
      await sync.afterPrepare(host.getPreparedCurrentToolsRevision())
    } finally { await sync.dispose() }
  }
  const versionGuide = guide('Version guide description', 'Version guide usage')
  const skill = guide('Tool skill description', 'Tool skill usage')
  const missing = catalogEntry({ id: 'example.not-bundled', skill })
  writeCatalog(catalogEntry({ versions: [exactEntry({ guide: versionGuide })], skill }), missing)
  const before = statSync(archive).mtimeMs
  try {
    const first = await boot()
    await pushSkills(first)
    const file = join(root, '.agents', 'skills', skillName, 'SKILL.md')
    expect(library.effectiveCatalog('test-space')).toEqual([
      { name: skillName, description: 'Version guide description', source: { kind: 'file', path: file } },
    ])
    expect(readFileSync(file, 'utf8')).toContain('HALO_CLI_TOOLS_BIN/../TOOLS.md')
    await checkPin(first, 'Version guide usage')
    expect(Object.keys((await first.readCliToolState())!.tools)).toEqual([id])
    expect(readFileSync(archive)).toEqual(archiveBytes)

    const custom = `---\nname: ${skillName}\ndescription: My own description\n---\nMy custom instructions.\n`
    writeFileSync(file, custom)
    writeCatalog(catalogEntry({ versions: [exactEntry({ guide: guide('New description', 'New usage', 2) })], skill }))
    const second = await boot()
    await pushSkills(second)
    expect(statSync(archive).mtimeMs).toBe(before)
    expect(readFileSync(file, 'utf8')).toBe(custom)
    expect(library.effectiveCatalog('test-space')[0]?.description).toBe('My own description')
    await checkPin(second, 'New usage')

    const live = guide('Live description', 'Live usage', 3)
    await second.applyCatalogStatus([{ id, revoked: false, versions: [version], guides: {
      [version]: { integrity: exactEntry().integrity, override: live },
    } }])
    writeCatalog(catalogEntry({ skill: guide('Stale description', 'Stale usage', 4) }))
    const third = await boot()
    await pushSkills(third)
    await checkPin(third, 'Live usage')
    expect(readFileSync(file, 'utf8')).toBe(custom)
    await third.applyCatalogStatus([{ id, revoked: false, versions: [version], guides: {
      [version]: { integrity: exactEntry().integrity, override: null },
    } }])
    writeCatalog(catalogEntry({ skill: guide('Stale again', 'Still stale', 5) }))
    const fourth = await boot()
    await checkPin(fourth, 'Archive usage')
  } finally { db.closeAll() }
})

it('attaches signed zero-version tool text only to a valid local archive', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signature = (bytes: Buffer) => ({ alg: 'ed25519', keyId: 'ephemeral', value: sign(null, bytes, privateKey).toString('base64') })
  writeFileSync(join(presetDir, 'trusted-keys.json'), JSON.stringify({ schema: 'halo.cli.trust/1', keys: [{
    keyId: 'ephemeral', alg: 'ed25519', publicKey: publicKey.export({ format: 'jwk' }).x!.replace(/-/g, '+').replace(/_/g, '/') + '=',
  }] }))
  const plain = guide('Signed description', 'Signed tool usage')
  const skill = { ...plain, signature: signature(signedSkillBytes({ id, ...plain })) }
  writeCatalog(catalogEntry({ skill }), catalogEntry({ id: 'example.missing', skill }))
  const host = await boot()
  await checkPin(host, 'Signed tool usage')
  expect(Object.keys((await host.readCliToolState())!.tools)).toEqual([id])

  const otherGuide = guide('Wrong domain', 'Should never load', 2)
  const fields = { id, ...exactEntry() }
  writeCatalog(catalogEntry({ versions: [exactEntry({
    signature: signature(signedBytes(fields)),
    guide: { ...otherGuide, signature: signature(signedSkillBytes({ id, ...otherGuide })) },
  })], skill: { ...plain, revision: 2 } }))
  const app = await boot()
  app.initCliTools({ root: join(root, 'fresh-cli'), presetDir, runtimePath: process.execPath })
  await checkPin(app, 'Archive usage')

  const valid = guide('Signed version description', 'Signed version usage', 3)
  writeCatalog(catalogEntry({ versions: [exactEntry({ signature: signature(signedBytes(fields)),
    guide: { ...valid, signature: signature(signedGuideBytes({ id, version, ...valid })) },
  })] }))
  await checkPin(await boot(), 'Signed version usage')

  writeCatalog(catalogEntry({ versions: [exactEntry()] }))
  const unsigned = await boot()
  unsigned.initCliTools({ root: join(root, 'unsigned-cli'), presetDir, runtimePath: process.execPath })
  expect((await unsigned.readCliToolState())?.tools).toEqual({})
})

it.each(['archive hash', 'payload integrity', 'tool id', 'version', 'renamed revoked'] as const)(
  'does not publish a preset rejected by its bundled %s', async error => {
    if (error === 'tool id') renameSync(writePackage(root, { ...packageSpec, id: 'example.substituted' }), archive)
    if (error === 'version') renameSync(writePackage(root, { ...packageSpec, version: '2.0.0' }), archive)
    if (error === 'renamed revoked') renameSync(archive, join(presetDir, 'arbitrary.hcli'))
    const entry = exactEntry(error === 'archive hash' ? { archiveSha256: 'f'.repeat(64) }
      : error === 'payload integrity' ? { integrity: `sha256-${Buffer.alloc(32).toString('base64')}` } : {})
    writeCatalog(catalogEntry({ revoked: error === 'renamed revoked', versions: [entry] }))
    const host = await boot()
    expect((await host.readCliToolState())?.tools).toEqual({})
    expect(await host.applyCliToolsEnv({}, { entry: 'terminal', engine: 'test' })).toBeNull()
  },
)

it('does not let a bundled revocation replace a live decision, or clear live revocation with an allowed preset', async () => {
  const noSidecar = await boot()
  await checkPin(noSidecar, 'Archive usage')
  await noSidecar.applyCatalogStatus([{ id, revoked: false, versions: [] }])
  writeCatalog(catalogEntry({ revoked: true, versions: [exactEntry()] }))
  const staleRevoke = await boot()
  await checkPin(staleRevoke, 'Archive usage')
  expect((await staleRevoke.readCliToolState())?.tools[id]?.revoked).toBe(false)

  await staleRevoke.applyCatalogStatus([{ id, revoked: true, versions: [] }])
  writeCatalog(catalogEntry({ versions: [exactEntry()], skill: guide('Should not revive', 'Revive') }))
  const stalePermit = await boot()
  expect((await stalePermit.readCliToolState())?.tools[id]).toMatchObject({ revoked: true, current: version })
  expect(await stalePermit.applyCliToolsEnv({}, { entry: 'terminal', engine: 'test' })).toBeNull()
})
