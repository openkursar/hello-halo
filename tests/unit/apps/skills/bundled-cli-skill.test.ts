import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import { createSkillLibrary, subscribeToolSkillSync } from '../../../../src/main/apps/skills'
import { signedBundleBytes } from '../../../../src/main/services/cli-tools/signature'
import { buildBundle, removeTree, writePackage, type BundleSpec, type Files, type PackageSpec } from '../../services/cli-tools/helpers'

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
function skillFiles(description: string, marker: string, extra: Files = {}): Files {
  return { 'SKILL.md': `---\ndescription: ${description}\n---\n${marker}\n`, ...extra }
}

let root: string
let presetDir: string
let toolRoot: string
let archive: string
let archiveBytes: Buffer
let sourceArchive: string

beforeEach(() => {
  root = realpathSync(globalThis.__HALO_TEST_DIR__)
  globalThis.__HALO_TEST_DIR__ = root
  presetDir = join(root, 'preset')
  toolRoot = join(root, 'cli')
  mkdirSync(presetDir)
  archive = join(presetDir, `${id}-${version}.hcli`)
  renameSync(writePackage(root, packageSpec), archive)
  archiveBytes = readFileSync(archive)
  sourceArchive = join(root, 'source.hcli')
  writeFileSync(sourceArchive, archiveBytes)
})

afterEach(() => { removeTree(root) })

/**
 * Ship the preset archive as a delivery bundle named by the build catalog,
 * in place of the plain package. `listed` and `catalog` shape the catalog
 * entry for the refusal cases.
 */
function shipBundle(revision: number, skill: Files | null, options: Partial<BundleSpec> & {
  revoked?: boolean
  listed?: boolean
  catalog?: (ref: ReturnType<typeof buildBundle>['ref']) => Record<string, unknown>
  fileName?: string
} = {}) {
  const { revoked, listed, catalog, fileName, ...spec } = options
  const shipped = buildBundle({ hcli: sourceArchive, revision, skill, ...spec })
  for (const name of readdirSync(presetDir)) if (name.endsWith('.zip') || name.endsWith('.hcli')) rmSync(join(presetDir, name))
  writeFileSync(join(presetDir, fileName ?? `${id}-${version}-r${revision}.zip`), shipped.bytes)
  const ref = shipped.ref
  const entry = catalog?.(ref) ?? { version: ref.version, bundle: { revision: ref.revision, sha256: ref.sha256, size: ref.size, url: '/unused' } }
  writeFileSync(join(presetDir, 'catalog.json'), JSON.stringify({ schema: 'halo.cli.catalog/2', generatedAt: 'now', tools: [
    { id, source: 'builtin', revoked: revoked === true, latest: version, versions: listed === false ? [] : [entry] },
  ] }))
  return shipped
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
  shipBundle(1, skillFiles('Cold-start guide description', 'Cold-start usage', { 'refs/notes.md': 'Bundled notes' }))
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
    expect(readFileSync(join(root, '.agents', 'skills', name, 'refs', 'notes.md'), 'utf8')).toBe('Bundled notes')
    expect(manager.listManagedToolSkillFolders()).toContain(join(root, '.agents', 'skills', name))
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

async function pushSkills(host: Host, manager: ReturnType<typeof setupSkillLibrary>['manager']) {
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

it('follows a newer bundle revision of the same version and preserves a customized skill file', async () => {
  const { db, manager, library } = setupSkillLibrary()
  shipBundle(1, skillFiles('First description', 'First usage'))
  try {
    const first = await boot()
    await pushSkills(first, manager)
    const skillName = (await skillOf(first)).name
    const file = join(root, '.agents', 'skills', skillName, 'SKILL.md')
    expect(library.effectiveCatalog('test-space')).toEqual([
      { name: skillName, description: described('First description'), source: { kind: 'file', path: file } },
    ])
    await checkTool(first, 'First usage')
    const installed = (await first.readCliToolState())!.tools[id].versions[version]

    shipBundle(2, skillFiles('Second description', 'Second usage'))
    const second = await boot()
    await pushSkills(second, manager)
    expect(readFileSync(file, 'utf8')).toContain('Second usage')
    expect((await second.readCliToolState())!.tools[id].versions[version]).toMatchObject({ dir: installed.dir, bundle: { revision: 2 } })

    const custom = `---\nname: ${skillName}\ndescription: My own description\n---\nMy custom instructions.\n`
    writeFileSync(file, custom)
    shipBundle(3, skillFiles('Third description', 'Third usage'))
    const third = await boot()
    await pushSkills(third, manager)
    expect(readFileSync(file, 'utf8')).toBe(custom)
    expect(library.effectiveCatalog('test-space')[0]?.description).toBe('My own description')
    expect(manager.listManagedToolSkillFolders()).toEqual([])
    await checkTool(third, 'Third usage')
  } finally { db.closeAll() }
})

it('rewrites the whole skill folder when files beside SKILL.md change', async () => {
  const trashed: string[] = []
  const db = createDatabaseManager(join(root, 'database'))
  const appDb = db.getAppDatabase()
  db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)
  const manager = createAppManagerService({
    store: new AppManagerStore(appDb), getSpacePath: () => null, getAppDataPath: () => null,
    getGlobalAppDir: () => join(root, 'halo'), trashItem: async path => { trashed.push(path); rmSync(path, { recursive: true, force: true }) },
  })
  shipBundle(1, skillFiles('Description', 'Usage', { 'refs/a.md': 'first' }))
  try {
    await pushSkills(await boot(), manager)
    const folder = join(root, '.agents', 'skills', (await skillOf(await boot())).name)
    expect(readFileSync(join(folder, 'refs', 'a.md'), 'utf8')).toBe('first')

    shipBundle(2, skillFiles('Description', 'Usage', { 'refs/b.md': 'second' }))
    await pushSkills(await boot(), manager)
    expect(existsSync(join(folder, 'refs', 'a.md'))).toBe(false)
    expect(readFileSync(join(folder, 'refs', 'b.md'), 'utf8')).toBe('second')
    expect(trashed).toHaveLength(1)
    expect(manager.listManagedToolSkillFolders()).toContain(folder)
  } finally { db.closeAll() }
})

it('imports a bundle only with a valid signature when the build trusts keys', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(presetDir, 'trusted-keys.json'), JSON.stringify({ schema: 'halo.cli.trust/1', keys: [{
    keyId: 'ephemeral', alg: 'ed25519', publicKey: publicKey.export({ format: 'jwk' }).x!.replace(/-/g, '+').replace(/_/g, '/') + '=',
  }] }))
  shipBundle(1, skillFiles('Unsigned description', 'Unsigned usage'))
  const unsigned = await boot()
  expect((await unsigned.readCliToolState())?.tools).toEqual({})

  shipBundle(2, skillFiles('Signed description', 'Signed usage'), {
    sign: json => ({ alg: 'ed25519', keyId: 'ephemeral', value: sign(null, signedBundleBytes(json), privateKey).toString('base64') }),
  })
  await checkTool(await boot(), 'Signed usage')
})

it.each(['bundle hash', 'payload integrity', 'tool id', 'unnamed', 'revoked'] as const)(
  'does not publish a preset bundle rejected by its %s', async error => {
    if (error === 'bundle hash') shipBundle(1, null, { catalog: ref => ({ version, bundle: { revision: 1, sha256: 'f'.repeat(64), size: ref.size } }) })
    if (error === 'payload integrity') shipBundle(1, null, { editJson: json => { (json.cli as Record<string, unknown>).integrity = `sha256-${Buffer.alloc(32).toString('base64')}` } })
    if (error === 'tool id') {
      writeFileSync(sourceArchive, readFileSync(writePackage(root, { ...packageSpec, id: 'example.substituted' })))
      shipBundle(1, null, { id })
    }
    if (error === 'unnamed') shipBundle(1, null, { fileName: 'arbitrary.zip' })
    if (error === 'revoked') shipBundle(1, null, { revoked: true })
    const host = await boot()
    expect((await host.readCliToolState())?.tools).toEqual({})
    await checkNoTool(host)
  },
)

it('does not let a bundled revocation replace a live decision, or clear live revocation with an allowed preset', async () => {
  const noSidecar = await boot()
  await checkTool(noSidecar, 'Archive usage')
  await noSidecar.applyCatalogStatus([{ id, revoked: false, versions: {} }])
  shipBundle(1, null, { revoked: true })
  const staleRevoke = await boot()
  await checkTool(staleRevoke, 'Archive usage')
  expect((await staleRevoke.readCliToolState())?.tools[id]?.revoked).toBe(false)

  await staleRevoke.applyCatalogStatus([{ id, revoked: true, versions: {} }])
  shipBundle(2, skillFiles('Should not revive', 'Revive'))
  const stalePermit = await boot()
  expect((await stalePermit.readCliToolState())?.tools[id]).toMatchObject({ revoked: true, current: version })
  await checkNoTool(stalePermit)
})
