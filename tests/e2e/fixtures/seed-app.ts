/**
 * Digital-Human Seeding Helper
 *
 * automation-run.spec.ts's live scenarios gate on "a digital human happens to
 * be installed" and skip otherwise — in a fresh E2E profile that is always
 * true, so the live path never actually runs. Creating one for real goes
 * through an AI-driven conversation wizard (network + model calls just to
 * produce a fixture), which is too slow/flaky to gate a deterministic test on.
 *
 * This seeds a runnable app directly into the same SQLite file
 * (`{haloDir}/halo.db`) the app itself opens at startup, using the project's
 * own migrations — so the row is schema-identical to what `AppManager` would
 * have written. Must run BEFORE `electronApp` launches: better-sqlite3 holds
 * an exclusive file lock while open, and the app activates every 'active' row
 * it finds on boot (registers the schedule subscription, no separate step
 * needed).
 *
 * The actual write happens in a spawned subprocess (seed-app-worker.ts) run
 * under Electron's own Node binary: better-sqlite3's native build is rebuilt
 * against Electron's Node ABI (see package.json's own `test:unit` script,
 * which runs vitest the same way), not the system Node this Playwright
 * process runs on — importing it here directly throws a NODE_MODULE_VERSION
 * mismatch. The worker is bundled on the fly with esbuild (already a project
 * dependency) so it can import the real TS migrations rather than a
 * hand-duplicated schema.
 */

import path from 'path'
import fs from 'fs'
import { execFileSync } from 'child_process'
import esbuild from 'esbuild'
import electronPath from 'electron'
import { fileURLToPath } from 'url'

// ESM compatibility: __dirname is not available in ES modules (mirrors electron.ts)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface SeededApp {
  appId: string
  name: string
  /** The profile root the app was seeded into — electron-with-app.ts launches this same dir. */
  testConfigDir: string
}

export interface SeedAppOptions {
  name?: string
  /** 'all' so a completed run always fires notifyAppEvent — see notification.service.ts. */
  notificationLevel?: 'none' | 'important' | 'all'
  /**
   * Schedule subscription interval, e.g. '10s' (scheduler floor) or '24h'
   * (default). A short interval lets a test observe a real unattended
   * scheduled fire — see schedule.ts's anchor-grid comment.
   */
  scheduleEvery?: string
}

let bundledWorkerPath: string | null = null

/** Bundles seed-app-worker.ts once per test run and caches the output path. */
function getBundledWorker(): string {
  if (bundledWorkerPath && fs.existsSync(bundledWorkerPath)) return bundledWorkerPath

  // Output must live under the project tree (not os.tmpdir()) so the worker's
  // require('better-sqlite3') resolves via normal node_modules walk-up —
  // esbuild marks it external, so it is resolved at run time, not bundled.
  const outDir = path.join(__dirname, '.e2e-seed-tmp')
  fs.mkdirSync(outDir, { recursive: true })
  const outfile = path.join(outDir, `seed-worker-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'seed-app-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    // Native module — must be require()'d at run time under Electron's Node
    // ABI, not bundled (esbuild cannot bundle a .node binary anyway).
    external: ['better-sqlite3'],
    logLevel: 'silent',
  })

  bundledWorkerPath = outfile
  return outfile
}

/**
 * Seed one active automation app into a fresh test profile's database.
 *
 * @param testConfigDir The E2E profile root (same value passed as HOME to
 *   `electron.launch()` — the worker computes `{testConfigDir}/.halo/halo.db`,
 *   matching `getHaloDir()` under `HALO_DATA_DIR`).
 */
export function seedAutomationApp(testConfigDir: string, options: SeedAppOptions = {}): SeededApp {
  const worker = getBundledWorker()
  const payload = JSON.stringify({ testConfigDir, options })

  const output = execFileSync(electronPath, [worker, payload], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf-8',
  })

  const lastLine = output.trim().split('\n').pop() ?? ''
  return JSON.parse(lastLine) as SeededApp
}
