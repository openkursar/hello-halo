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
const described = (text: string) => `Companion skill for the ${launchName} command-line tool. ${text}`
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

function launcherIn(cliRoot: string): string {
  return join(cliRoot, 'tools', id, 'bin', process.platform === 'win32' ? `${launchName}.cmd` : launchName)
}

function runLauncher(cliRoot = toolRoot): void {
  const cmd = launcherIn(cliRoot)
  const stdout = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/c', cmd], { encoding: 'utf8' })
    : execFileSync(cmd, { encoding: 'utf8' })
  expect(stdout.trim()).toBe('hello 1.0.0')
}

async function skillOf(host: Host) {
  const snapshot = await host.readCurrentToolSkills()
  return snapshot!.skills.find(skill => skill.toolId === id)!.describe()
}

/** The tool runs from its launcher and its skill carries the expected guide. */
async function checkTool(host: Host, marker: string, cliRoot = toolRoot): Promise<void> {
  await host.prepareCliTools()
  const skill = await skillOf(host)
  expect(skill.body).toContain(marker)
  expect(skill.body).toContain(launcherIn(cliRoot).replace(/\.cmd$/, ''))
  runLauncher(cliRoot)
}

async function checkNoTool(host: Host, cliRoot = toolRoot): Promise<void> {
  await host.prepareCliTools()
  expect(existsSync(join(cliRoot, 'tools', id))).toBe(false)
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

async function coldStart(config: 'preset' | 'empty' | 'unconfigured' = 'preset') {
  vi.resetModules()
  const host = await import('../../../../src/main/services/cli-tools')
  const { createCliToolSkillStartup } = await import('../../../../src/main/bootstrap/cli-tool-skills')
  const { registerAppBridge } = await import('../../../../src/main/services/app-bridge')
  const { buildUserSessionSdkOptions } = await import('../../../../src/main/services/agent/sdk-config')
  const { prepareSessionSkills } = await import('../../../../src/main/services/agent/skill-availability')
  const startup = createCliToolSkillStartup(join(toolRoot, 'skill-sync-stamp'))
  if (config !== 'unconfigured') host.initCliTools({ root: toolRoot, presetDir: config === 'empty' ? null : presetDir, runtimePath: process.execPath })
  const start = async () => {
    const options = await buildUserSessionSdkOptions({
      engineId: 'halo', spaceId: 'test-space', conversationId: 'test-conversation',
      workDir: root, electronPath: process.execPath, credentials: {
        anthropicBaseUrl: 'http://127.0.0.1:1', anthropicApiKey: '', sdkModel: 'synthetic-model', displayModel: 'synthetic-model',
      },
    })
    return { ...await prepareSessionSkills(options), env: options.env as Record<string, string | undefined> }
  }
  return { host, startup, start, registerAppBridge }
}

it('installs the offline CLI skill with its launcher when the store is prepared, and sessions add nothing to their environment', async () => {
  const { db, manager, library } = setupSkillLibrary()
  const { host, startup, start, registerAppBridge } = await coldStart()
  writeCatalog(catalogEntry({ versions: [exactEntry({ guide: guide('Cold-start guide description', 'Cold-start usage') })] }))
  registerAppBridge({ getAppManager: () => manager, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
    getEffectiveSkillCatalog: library.effectiveCatalog })
  startup.attachManager(manager)
  try {
    await startup.prepareInBackground()
    const { installId } = (await host.readCliToolState())!.tools[id]
    const name = `${launchName}-example-offline-${installId}`
    const file = join(root, '.agents', 'skills', name, 'SKILL.md')
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))
    await vi.waitFor(async () => expect((await new (await import('../../../../src/main/services/cli-tools')).CliToolStore({
      root: toolRoot, runtimePath: process.execPath, runtimeNodeVersion: process.versions.node,
    }).readInstallRecord(id))?.skill).toEqual({ name, path: file }))
    const session = await start()
    expect(session.catalog).toEqual([{ name, description: described('Cold-start guide description'), source: { kind: 'file', path: file } }])
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(launcherIn(toolRoot).replace(/\.cmd$/, ''))
    expect(text).toContain('Cold-start usage')
    expect(text).not.toMatch(/HALO_CLI_TOOLS_BIN|TOOLS\.md/)
    expect(Object.keys(session.env).filter(key => /HALO_CLI|CLI_TOOLS/.test(key))).toEqual([])
    expect(String(session.env.PATH ?? '')).not.toContain(join(toolRoot, 'tools'))
    runLauncher()
  } finally {
    await startup.dispose()
    db.closeAll()
  }
})

it.each(['empty', 'unconfigured'] as const)('adds no tool and no skill on a %s installation', async config => {
  const { startup, start, registerAppBridge } = await coldStart(config)
  registerAppBridge({ getAppManager: () => null, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
    getEffectiveSkillCatalog: () => [] })
  try {
    await startup.prepareInBackground()
    expect((await start()).catalog).toEqual([])
    expect(existsSync(join(toolRoot, 'tools'))).toBe(false)
  } finally { await startup.dispose() }
})

it('retries a failed skill write at the next start while the launcher already works', async () => {
  const { db, manager, library } = setupSkillLibrary()
  const first = await coldStart()
  first.registerAppBridge({ getAppManager: () => manager, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
    getEffectiveSkillCatalog: library.effectiveCatalog })
  const upsert = vi.spyOn(manager, 'reconcileManagedToolSkill').mockRejectedValueOnce(new Error('Controlled skill write failure'))
  first.startup.attachManager(manager)
  try {
    await first.startup.prepareInBackground()
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce())
    runLauncher()
    expect((await first.start()).catalog).toEqual([])
    await first.startup.dispose()

    const second = await coldStart()
    second.registerAppBridge({ getAppManager: () => manager, onMcpAppsChange: () => () => {}, createHaloAppsMcpServer: () => null,
      getEffectiveSkillCatalog: library.effectiveCatalog })
    second.startup.attachManager(manager)
    await second.startup.prepareInBackground()
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect((await second.start()).catalog).toEqual([expect.objectContaining({ description: described('Archive description') })]))
    await second.startup.dispose()
  } finally {
    db.closeAll()
  }
})

it('does not hold the idle queue when App Manager never arrives', async () => {
  const { startup } = await coldStart()
  await startup.prepareInBackground()
  runLauncher()
  await startup.dispose()
})

it('lists the real static skill on fresh offline install, follows its pinned guide and command, and preserves customization on a sidecar-only change', async () => {
  const { db, manager, library } = setupSkillLibrary()
  const pushSkills = async (host: Host) => {
    const sync = subscribeToolSkillSync({
      stampPath: join(root, 'skill-sync'), onDidChange: host.onDidChangeCurrentTools, readSnapshot: host.readCurrentToolSkills,
      upsert: async skill => { await manager.reconcileManagedToolSkill(skill) }, remove: toolId => manager.removeManagedToolSkill(toolId),
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
    const skillName = (await skillOf(first)).name
    const file = join(root, '.agents', 'skills', skillName, 'SKILL.md')
    expect(library.effectiveCatalog('test-space')).toEqual([
      { name: skillName, description: described('Version guide description'), source: { kind: 'file', path: file } },
    ])
    expect(readFileSync(file, 'utf8')).toContain('Version guide usage')
    await checkTool(first, 'Version guide usage')
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
    await checkTool(second, 'New usage')

    const live = guide('Live description', 'Live usage', 3)
    await second.applyCatalogStatus([{ id, revoked: false, versions: [version], guides: {
      [version]: { integrity: exactEntry().integrity, override: live },
    } }])
    writeCatalog(catalogEntry({ skill: guide('Stale description', 'Stale usage', 4) }))
    const third = await boot()
    await pushSkills(third)
    await checkTool(third, 'Live usage')
    expect(readFileSync(file, 'utf8')).toBe(custom)
    await third.applyCatalogStatus([{ id, revoked: false, versions: [version], guides: {
      [version]: { integrity: exactEntry().integrity, override: null },
    } }])
    writeCatalog(catalogEntry({ skill: guide('Stale again', 'Still stale', 5) }))
    const fourth = await boot()
    await checkTool(fourth, 'Archive usage')
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
  await checkTool(host, 'Signed tool usage')
  expect(Object.keys((await host.readCliToolState())!.tools)).toEqual([id])

  const otherGuide = guide('Wrong domain', 'Should never load', 2)
  const fields = { id, ...exactEntry() }
  writeCatalog(catalogEntry({ versions: [exactEntry({
    signature: signature(signedBytes(fields)),
    guide: { ...otherGuide, signature: signature(signedSkillBytes({ id, ...otherGuide })) },
  })], skill: { ...plain, revision: 2 } }))
  const app = await boot()
  app.initCliTools({ root: join(root, 'fresh-cli'), presetDir, runtimePath: process.execPath })
  await checkTool(app, 'Archive usage', join(root, 'fresh-cli'))

  const valid = guide('Signed version description', 'Signed version usage', 3)
  writeCatalog(catalogEntry({ versions: [exactEntry({ signature: signature(signedBytes(fields)),
    guide: { ...valid, signature: signature(signedGuideBytes({ id, version, ...valid })) },
  })] }))
  await checkTool(await boot(), 'Signed version usage')

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
    await checkNoTool(host)
  },
)

it('does not let a bundled revocation replace a live decision, or clear live revocation with an allowed preset', async () => {
  const noSidecar = await boot()
  await checkTool(noSidecar, 'Archive usage')
  await noSidecar.applyCatalogStatus([{ id, revoked: false, versions: [] }])
  writeCatalog(catalogEntry({ revoked: true, versions: [exactEntry()] }))
  const staleRevoke = await boot()
  await checkTool(staleRevoke, 'Archive usage')
  expect((await staleRevoke.readCliToolState())?.tools[id]?.revoked).toBe(false)

  await staleRevoke.applyCatalogStatus([{ id, revoked: true, versions: [] }])
  writeCatalog(catalogEntry({ versions: [exactEntry()], skill: guide('Should not revive', 'Revive') }))
  const stalePermit = await boot()
  expect((await stalePermit.readCliToolState())?.tools[id]).toMatchObject({ revoked: true, current: version })
  await checkNoTool(stalePermit)
})
