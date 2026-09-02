/**
 * Seeding worker — runs under Electron's own Node runtime.
 *
 * better-sqlite3's native binary is rebuilt against Electron's Node ABI, not
 * the system Node Playwright's test process runs on, so this logic cannot run
 * in-process (see seed-app.ts). It runs here instead, bundled and spawned via
 * `electron --require-run-as-node` by seed-app.ts, sharing the project's real
 * migrations rather than a hand-duplicated schema.
 *
 * Contract: argv[2] is a JSON-encoded { testConfigDir, options }; the seeded
 * { appId, name, testConfigDir } is printed to stdout as the last line.
 */

import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import { MIGRATION_NAMESPACE as MANAGER_NS, migrations as managerMigrations } from '../../../src/main/apps/manager/migrations'
import { MIGRATION_NAMESPACE as RUNTIME_NS, migrations as runtimeMigrations } from '../../../src/main/apps/runtime/migrations'
import type { SeedAppOptions, SeededApp } from './seed-app'

function main(): void {
  const raw = process.argv[2]
  if (!raw) throw new Error('seed-app-worker: missing argv[2] payload')
  const { testConfigDir, options } = JSON.parse(raw) as { testConfigDir: string; options: SeedAppOptions }

  const haloDir = path.join(testConfigDir, '.halo')
  fs.mkdirSync(haloDir, { recursive: true })
  const dbPath = path.join(haloDir, 'halo.db')

  const dbManager = createDatabaseManager(dbPath)
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MANAGER_NS, managerMigrations)
  dbManager.runMigrations(db, RUNTIME_NS, runtimeMigrations)

  const appId = randomUUID()
  const name = options.name ?? 'E2E Digital Human'
  const spec = {
    spec_version: '1',
    name,
    version: '1.0.0',
    author: 'e2e',
    description: 'Seeded for E2E automation-run coverage.',
    type: 'automation',
    system_prompt: 'You are a terse test assistant. Call report_to_user with a short summary as soon as you have replied, then stop.',
    subscriptions: [
      // anchorMs is set to "now" when the scheduler job is created (app
      // activation, at boot) — a short interval here lets a test observe a
      // real, unattended scheduled fire instead of only a manual trigger.
      { id: 'daily-check', source: { type: 'schedule', config: { every: options.scheduleEvery ?? '24h' } } },
    ],
    requires: {},
    config_schema: [],
    permissions: [],
  }

  db.prepare(`
    INSERT INTO installed_apps
      (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
    VALUES (?, ?, ?, ?, 'active', '{}', ?, '{"granted":[],"denied":[]}', ?)
  `).run(
    appId,
    'e2e-test-app',
    'halo-temp', // built-in temp space id, always present — see space.service.ts
    JSON.stringify(spec),
    JSON.stringify({ notificationLevel: options.notificationLevel ?? 'important' }),
    Date.now(),
  )

  db.close()

  const result: SeededApp = { appId, name, testConfigDir }
  // Last stdout line only — worker logs (if any) must not land after this.
  process.stdout.write(JSON.stringify(result) + '\n')
}

main()
