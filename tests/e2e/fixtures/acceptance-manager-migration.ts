import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import { expect } from './acceptance-app'

export const legacyManagerVersion = 2
export const currentManagerVersion = 10
export const managerLegacyColumns = ['id', 'spec_id', 'space_id', 'spec_json', 'status', 'pending_escalation_id', 'user_config_json', 'user_overrides_json', 'permissions_json', 'installed_at', 'last_run_at', 'last_run_outcome', 'error_message', 'uninstalled_at']
const addedColumns = ['upgrade_strategy', 'ignored_versions', 'knowledge_seeded', 'data_path', 'author_spec_json']
const schema = readFileSync(fileURLToPath(new URL('./data/app-manager-v2.sql', import.meta.url)), 'utf8')
type Row = Record<string, unknown>

export function managerSchemaIdentity() {
  return { version: legacyManagerVersion, targetVersion: currentManagerVersion, sha256: createHash('sha256').update(schema).digest('hex') }
}

export function managerProfileDatabase(profile: string) {
  const database = join(profile, '.halo', 'halo.db')
  assert.ok(lstatSync(database).isFile() && !lstatSync(database).isSymbolicLink(), 'Only a real owned profile database can be reconstructed')
  const owned = relative(realpathSync(profile), realpathSync(database))
  assert.ok(owned && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`))
  return database
}

function readState(db: Database.Database, ids: string[]) {
  const placeholders = ids.map(() => '?').join(',')
  const columns = (db.pragma('table_info(installed_apps)') as Array<{ name: string }>).map(column => column.name)
  return {
    version: (db.prepare("SELECT version FROM _migrations WHERE namespace = 'app_manager'").get() as { version: number }).version,
    columns,
    apps: db.prepare(`SELECT ${managerLegacyColumns.join(', ')} FROM installed_apps WHERE id IN (${placeholders}) ORDER BY id`).all(...ids) as Row[],
    extensions: columns.includes('author_spec_json') ? db.prepare(`SELECT id, ${addedColumns.join(', ')} FROM installed_apps WHERE id IN (${placeholders}) ORDER BY id`).all(...ids) as Row[] : [],
    namespaces: db.prepare("SELECT * FROM _migrations WHERE namespace != 'app_manager' ORDER BY namespace").all(),
    runs: db.prepare(`SELECT * FROM automation_runs WHERE app_id IN (${placeholders}) ORDER BY run_id`).all(...ids),
    activity: db.prepare(`SELECT * FROM activity_entries WHERE app_id IN (${placeholders}) ORDER BY id`).all(...ids),
    foreignKeyViolations: db.pragma('foreign_key_check'),
    integrity: db.pragma('integrity_check', { simple: true }),
  }
}

export type ManagerMigrationState = ReturnType<typeof readState>

export function readManagerMigration(database: string, ids: string[]) {
  assert.ok(ids.length > 0)
  const db = new Database(database, { readonly: true, fileMustExist: true })
  try { return readState(db, ids) } finally { db.close() }
}

function otherTables(db: Database.Database) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('installed_apps', '_migrations') ORDER BY name").all() as Array<{ name: string; sql: string }>
  return tables.map(table => {
    const quoted = `"${table.name.replaceAll('"', '""')}"`
    const rows = (db.prepare(`SELECT * FROM ${quoted}`).all() as Row[]).map(row => JSON.stringify(row)).sort()
    return { ...table, count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
  })
}

export function prepareLegacyManager(profile: string, child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, ids: string[]) {
  assert.ok(child.exitCode != null || child.signalCode != null, 'Historical data preparation requires the owned application to have exited')
  const db = new Database(managerProfileDatabase(profile), { fileMustExist: true })
  try {
    const current = readState(db, ids)
    assert.equal(current.version, currentManagerVersion, 'Review the historical fixture before accepting a different manager schema')
    assert.deepEqual(current.columns, [...managerLegacyColumns, ...addedColumns])
    assert.equal(current.apps.length, ids.length)
    assert.ok(current.runs.length > 0 && current.activity.length > 0, 'The real runtime must have history whose survival can be checked')
    const allApps = db.prepare(`SELECT ${managerLegacyColumns.join(', ')} FROM installed_apps ORDER BY id`).all() as Row[]
    assert.ok(allApps.every(row => typeof row.space_id === 'string' && row.space_id.length > 0), 'Historical v2 supports only space-scoped records; configure global fixture apps through the real API first')
    const controls = otherTables(db)
    db.pragma('foreign_keys = OFF')
    db.transaction(() => {
      db.exec('DROP TABLE installed_apps')
      db.exec(schema)
      const insert = db.prepare(`INSERT INTO installed_apps (${managerLegacyColumns.join(', ')}) VALUES (${managerLegacyColumns.map(() => '?').join(', ')})`)
      for (const row of allApps) insert.run(...managerLegacyColumns.map(column => row[column]))
      db.prepare("UPDATE _migrations SET version = ? WHERE namespace = 'app_manager'").run(legacyManagerVersion)
    })()
    db.pragma('foreign_keys = ON')
    assert.deepEqual(db.prepare(`SELECT ${managerLegacyColumns.join(', ')} FROM installed_apps ORDER BY id`).all(), allApps)
    assert.deepEqual(otherTables(db), controls, 'Fixture preparation must leave every other namespace and actor-related record intact')
    const old = readState(db, ids)
    assert.deepEqual(old.namespaces, current.namespaces)
    assert.deepEqual(old.runs, current.runs)
    assert.deepEqual(old.activity, current.activity)
    assert.deepEqual(old.foreignKeyViolations, [])
    assert.equal(old.integrity, 'ok')
    return { old, controls, allAppIds: allApps.map(row => row.id) }
  } finally { db.close() }
}

export function expectedManagerRows(rows: Row[]) {
  return rows.map(row => {
    const overrides = JSON.parse(row.user_overrides_json as string)
    delete overrides.frequency
    return { ...row, user_overrides_json: JSON.stringify(overrides) }
  })
}

export async function readMigrationApp(page: Page, id: string) {
  const response = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGet(appId), id)
  expect(response.success).toBe(true)
  expect(response.data).toMatchObject({ id })
  return response.data as InstalledApp
}

export async function prepareManagerScopes(page: Page, profile: string, controlSpaceId: string) {
  await expect.poll(() => {
    try {
      const stamp = JSON.parse(readFileSync(join(profile, '.halo', 'bundle-seed.json'), 'utf8'))
      return typeof stamp['builtin-skills'] === 'string'
    } catch { return false }
  }, { timeout: 30000, message: 'Finish the real bundled-skill seeding before preparing a historical space-only profile' }).toBe(true)
  const response = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList())
  expect(response.success).toBe(true)
  const globalApps = (response.data as InstalledApp[]).filter(app => app.spaceId === null)
  for (const app of globalApps) {
    expect(['skill', 'mcp']).toContain(app.spec.type)
    expect(app.status).not.toBe('uninstalled')
    const moved = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appMoveSpace(input), { appId: app.id, newSpaceId: controlSpaceId })
    expect(moved.success).toBe(true)
    expect(await readMigrationApp(page, app.id)).toMatchObject({ id: app.id, spaceId: controlSpaceId, spec: app.spec })
  }
  return globalApps.map(app => ({ id: app.id, specId: app.specId, from: null, to: controlSpaceId }))
}
