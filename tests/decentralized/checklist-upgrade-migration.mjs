/**
 * Production checklist §4 — upgrade compatibility & regression, items 4.1–4.5.
 *
 * Simulates "upgrade from an older on-disk data dir" by taking a real node's
 * SQLite DB (built with the CURRENT code, so all other namespaces are already
 * current — see CHECKLIST-COVERAGE.md for why a literal older binary isn't
 * used) and surgically downgrading the app_runtime namespace to its pre-v4
 * shape (the exact schema from migrations.ts v1+v3, before v4 dropped the
 * activity_entries.run_id FK). Restarting the CURRENT build against that
 * downgraded DB exercises the real migration path end-to-end.
 *
 * Run: node tests/decentralized/checklist-upgrade-migration.mjs
 */

import { execFileSync } from 'child_process'
import path from 'path'
import {
  clusterStart, clusterStop, apiOk, api, pollUntil, sleep, Reporter, PROJECT_ROOT,
} from './_lib.mjs'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const report = new Reporter()
const CLUSTER_DIR = '.cluster-upgrade'
const DB_PATH = path.resolve(PROJECT_ROOT, CLUSTER_DIR, 'node-1/.halo/halo.db')

const NO_ASK_SUFFIX = ' Never ask the user anything or escalate; make reasonable assumptions and finish.'

function killAllInCluster() {
  clusterStop(CLUSTER_DIR)
}

let node
function startNode(fresh) {
  const manifest = clusterStart({ nodes: 1, basePort: 3660, fresh, clusterDir: CLUSTER_DIR })
  node = manifest.nodes[0]
  return node
}

/** Run SQL against the (stopped) node's DB via the system sqlite3 CLI —
 *  better-sqlite3 in node_modules is compiled for the Electron ABI and cannot
 *  be loaded by plain node, so a plain-SQL shell-out keeps this driver runnable
 *  with `node` like the rest of the suite. */
function sql(statements) {
  return execFileSync('/usr/bin/sqlite3', [DB_PATH, statements], { encoding: 'utf-8' }).trim()
}

/** An activity row whose owning app no longer exists — the pre-FK-era dirt that
 *  once aborted the v4 rebuild (FK=ON inside the migration transaction) and
 *  blocked startup. v4 must drop it, not die on it. */
const ORPHAN_APP_ID = 'ghost-app-uninstalled'

/** Downgrade app_runtime to pre-v4: recreate activity_entries WITH the run_id FK,
 *  and roll the _migrations row back to version 3. Also seeds an orphan row
 *  (sqlite3 CLI runs with foreign_keys=OFF, matching how real orphans were
 *  written). Node must be stopped (file lock). */
function downgradeAppRuntimeToV3() {
  sql(`
    CREATE TABLE activity_entries_old (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session_key TEXT,
      content_json TEXT NOT NULL,
      user_response_json TEXT,
      FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES automation_runs(run_id) ON DELETE CASCADE
    );
    INSERT INTO activity_entries_old
      (id, app_id, run_id, type, ts, session_key, content_json, user_response_json)
      SELECT id, app_id, run_id, type, ts, session_key, content_json, user_response_json
      FROM activity_entries;
    DROP TABLE activity_entries;
    ALTER TABLE activity_entries_old RENAME TO activity_entries;
    CREATE INDEX IF NOT EXISTS idx_entries_app ON activity_entries(app_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_run ON activity_entries(run_id);
    INSERT INTO activity_entries (id, app_id, run_id, type, ts, content_json)
      VALUES ('orphan-entry-1', '${ORPHAN_APP_ID}', 'run-ghost', 'report', ${Date.now()}, '{}');
    UPDATE _migrations SET version = 3 WHERE namespace = 'app_runtime';
  `)
}

function readMigrationVersion(namespace) {
  const out = sql(`SELECT version FROM _migrations WHERE namespace = '${namespace}';`)
  return out ? Number(out) : null
}

/** Direct DB surgery to simulate a >1-year-old finished run, for 4.5's prune-on-startup path. */
function ageOutRun(runId) {
  const oldTs = Date.now() - 400 * 24 * 60 * 60 * 1000
  sql(`
    UPDATE automation_runs SET started_at = ${oldTs}, status = 'ok' WHERE run_id = '${runId}';
    UPDATE activity_entries SET ts = ${oldTs} WHERE run_id = '${runId}';
  `)
}

function countActivity(appId) {
  return Number(sql(`SELECT COUNT(*) FROM activity_entries WHERE app_id = '${appId}';`))
}

function normalAppSpec(name) {
  return {
    spec_version: '1',
    name,
    version: '1.0',
    author: 'Halo',
    description: 'Upgrade-regression smoke test app.',
    type: 'automation',
    icon: '🧪',
    system_prompt:
      'You are a minimal test automation. When triggered on schedule, call report_to_user with ' +
      'type "run_complete" and a one-line summary, then stop. When chatted with, do exactly what ' +
      'is asked in one short turn.',
    subscriptions: [{ source: { type: 'schedule', config: { every: '15s' } } }],
    store: { install_source: 'manual' },
  }
}

try {
  startNode(true)

  let space, appId, runId
  await report.run('setup', async (mark) => {
    space = await apiOk(node, 'POST', '/api/spaces', { name: 'Upgrade Space', icon: '🧪' })
    const install = await apiOk(node, 'POST', '/api/apps/install', { spaceId: space.id, spec: normalAppSpec('UpgradeApp') })
    appId = install.appId
    // Let the schedule fire once to create a real automation_runs + activity_entries row.
    const fired = await pollUntil(async () => {
      const runs = await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=20`)
      return runs.length > 0 ? runs : null
    }, { timeoutMs: 90_000, intervalMs: 3000 })
    // Disable further firing so it doesn't keep triggering during DB surgery.
    await api(node, 'POST', `/api/apps/${appId}/pause`, {})
    mark(fired ? 'PASS' : 'FAIL', `preUpgradeActivityEntries=${fired?.length ?? 0}`)
  })

  // Team created BEFORE the "upgrade", not yet run — for 4.4.
  let oldTeam
  await report.run('setup-team', async (mark) => {
    const teamSpace = await apiOk(node, 'POST', '/api/spaces', { name: 'Old Team Space', icon: '🏢' })
    oldTeam = await apiOk(node, 'POST', '/api/teams', {
      input: { name: 'PreUpgradeTeam', goal: 'Post finding text exactly: POST-UPGRADE-RUN-OK.' + NO_ASK_SUFFIX, owningSpaceId: teamSpace.id, memberSourcing: 'ai', collabMode: 'structured', escalationRouting: 'lead' },
      confirmedProposal: [{ memberName: 'Legacy', role: 'r', responsibility: 'Post finding text exactly: POST-UPGRADE-RUN-OK, then report done.' }],
    })
    mark(oldTeam?.id ? 'PASS' : 'FAIL', `teamId=${oldTeam?.id}`)
  })

  const beforeActivity = await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=20`)
  const beforeVersion = 4 // current build's namespace version before we tamper
  killAllInCluster()
  await sleep(1000)

  await report.run('4.1', async (mark) => {
    const preVersion = readMigrationVersion('app_runtime')
    downgradeAppRuntimeToV3()
    const downgradedVersion = readMigrationVersion('app_runtime')
    startNode(false) // NOT fresh — reuse the downgraded on-disk DB
    const upgraded = await pollUntil(async () => {
      const { status } = await api(node, 'GET', '/api/teams')
      return status === 200 ? true : null
    }, { timeoutMs: 60_000, intervalMs: 1000 })
    const postVersion = readMigrationVersion('app_runtime')
    const afterActivity = upgraded ? await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=20`) : []
    const dataIntact = afterActivity.length === beforeActivity.length &&
      JSON.stringify(afterActivity.map((e) => e.id).sort()) === JSON.stringify(beforeActivity.map((e) => e.id).sort())
    const orphanDropped = countActivity(ORPHAN_APP_ID) === 0
    mark(preVersion === 4 && downgradedVersion === 3 && postVersion === 4 && upgraded && dataIntact && orphanDropped ? 'PASS' : 'FAIL',
      `pre=${preVersion} downgraded=${downgradedVersion} post=${postVersion} bootedOk=${!!upgraded} dataIntact=${dataIntact} orphanDropped=${orphanDropped} (before=${beforeActivity.length} after=${afterActivity.length})`)
  })

  await report.run('4.2', async (mark) => {
    // Re-enable the schedule and confirm a normal (non-team) automation still
    // runs cleanly after the migration (report-tool regression guard).
    await apiOk(node, 'POST', `/api/apps/${appId}/resume`, {})
    const before = await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=50`)
    const fired = await pollUntil(async () => {
      const after = await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=50`)
      return after.length > before.length ? after : null
    }, { timeoutMs: 90_000, intervalMs: 3000 })
    await api(node, 'POST', `/api/apps/${appId}/pause`, {})
    const noFkError = fired ? !JSON.stringify(fired).includes('FOREIGN KEY') : true
    mark(fired && noFkError ? 'PASS' : 'FAIL', `newEntries=${fired ? fired.length - before.length : 0} noFkError=${noFkError}`)
  })

  await report.run('4.3', async (mark) => {
    await apiOk(node, 'POST', `/api/apps/${appId}/chat/send`, {
      message: 'Call report_to_user with type "run_complete" and summary "CHAT-REPORT-POST-UPGRADE", then stop.',
    })
    const gotEntry = await pollUntil(async () => {
      const activity = await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=50`)
      const found = activity.find((e) => JSON.stringify(e.content).includes('CHAT-REPORT-POST-UPGRADE'))
      return found ? { activity, found } : null
    }, { timeoutMs: 90_000, intervalMs: 2000 })
    runId = gotEntry?.found?.runId
    const noFkError = gotEntry ? !JSON.stringify(gotEntry.activity).includes('FOREIGN KEY') : false
    mark(gotEntry && noFkError && runId === 'chat' ? 'PASS' : 'FAIL',
      `entryFound=${!!gotEntry} noFkError=${noFkError} runId=${runId}`)
  })

  await report.run('4.4', async (mark) => {
    await apiOk(node, 'POST', `/api/teams/${oldTeam.id}/run`, {})
    const rested = await pollUntil(async () => {
      const d = await apiOk(node, 'GET', `/api/teams/${oldTeam.id}/detail`)
      return d.team.status === 'idle' ? d : null
    }, { timeoutMs: 180_000, intervalMs: 2000 })
    const epochs = rested ? await apiOk(node, 'GET', `/api/teams/${oldTeam.id}/epochs`) : []
    const historyOk = epochs.length > 0
    mark(rested && historyOk ? 'PASS' : 'FAIL', `rested=${!!rested} epochs=${epochs.length}`)
  })

  await report.run('4.5', async (mark) => {
    // Find the real (non-'chat') run created during setup/4.2 to age out.
    const activity = await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=100`)
    const realRun = activity.find((e) => e.runId && e.runId !== 'chat')
    if (!realRun) { mark('FAIL', 'no real automation run entry found to age out'); return }
    const chatEntriesBefore = activity.filter((e) => e.runId === 'chat').length
    const beforeCount = countActivity(appId)
    killAllInCluster()
    await sleep(1000)
    ageOutRun(realRun.runId)
    // Fresh process → lastPruneAtMs resets to 0 → checkEscalationTimeouts' first
    // immediate call piggybacks pruneOldDataIfNeeded (self-throttled to 24h,
    // but this IS the first call this process has ever made).
    startNode(false)
    const settled = await pollUntil(async () => {
      const { status } = await api(node, 'GET', '/api/apps')
      return status === 200 ? true : null
    }, { timeoutMs: 60_000, intervalMs: 1000 })
    // The prune runs on the escalation-timeout interval's immediate first tick;
    // give it a moment after boot.
    await sleep(8000)
    const afterActivity = await apiOk(node, 'GET', `/api/apps/${appId}/activity?limit=100`)
    const oldRunGone = !afterActivity.some((e) => e.runId === realRun.runId)
    const chatEntriesAfter = afterActivity.filter((e) => e.runId === 'chat').length
    const chatIntact = chatEntriesAfter >= chatEntriesBefore
    mark(settled && oldRunGone && chatIntact ? 'PASS' : 'FAIL',
      `settled=${!!settled} oldRunGone=${oldRunGone} chatBefore=${chatEntriesBefore} chatAfter=${chatEntriesAfter} (before=${beforeCount})`)
  })

  const tally = report.tally()
  log(`\n=== §4 upgrade/migration: ${tally.PASS}/${tally.total} PASS, ${tally.FAIL} FAIL ===`)
  if (tally.FAIL > 0) process.exitCode = 1
} finally {
  killAllInCluster()
}
