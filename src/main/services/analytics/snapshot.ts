/**
 * Startup Analytics Snapshot
 *
 * At bootstrap time (once per launch), ship two classes of telemetry to
 * the backend so dashboards stay accurate regardless of client uptime:
 *
 *   1. `installed_apps.snapshot` — the current population of non-uninstalled
 *      automation apps. Replaces any previous snapshot on the backend, so
 *      the backend can reconcile drift when the client was offline.
 *   2. `app.run.replay` — any `automation_runs` rows that finished after
 *      the last persisted watermark. Used to catch up on runs that finished
 *      while the backend was unreachable OR while the client was offline.
 *
 * Watermark pair (`lastSnapshotRunId`, `lastSnapshotTs`) lives in
 * config.json under `analytics.*`. Both are exclusive (we ship strictly
 * newer). On success the watermark is advanced to the most recent finished
 * run seen this cycle.
 *
 * Safety:
 *   - No-op when analytics is disabled (telemetry provider empty).
 *   - No-op when no apps are installed (first launch).
 *   - Bounded per-app history (MAX_RUNS_PER_APP) so a pathological history
 *     can't blow up a single snapshot.
 *   - Handler errors are logged, never thrown.
 */

import type { AppManagerService, InstalledApp } from '../../apps/manager'
import type { AppRuntimeService } from '../../apps/runtime/types'
import type { AutomationRun } from '../../apps/runtime/types'
import { analytics } from './analytics.service'
import { AnalyticsEvents } from './types'

/** Upper bound on runs fetched per app during replay. */
const MAX_RUNS_PER_APP = 200

/** Upper bound on total replay events shipped in one startup cycle. */
const MAX_REPLAY_EVENTS = 2000

/**
 * Run the startup snapshot + replay.
 *
 * Called once from bootstrap after apps/runtime is initialized. Safe to
 * call even if analytics is not initialized (the underlying `track()` is
 * a no-op in that case).
 *
 * Visible for testing.
 */
export async function runStartupSnapshot(
  appManager: AppManagerService,
  runtime: AppRuntimeService
): Promise<void> {
  // Bootstrap starts `initializeExtendedServices()` (which calls us) and
  // `initAnalytics()` on the same `setImmediate` tick, so init may not have
  // completed yet when we arrive here. Wait for init to settle (with a cap
  // to prevent hanging forever if analytics init is never called), then
  // skip if the service opted out (dev mode, empty credentials).
  const settled = await analytics.whenSettled(10_000)
  if (!settled) {
    console.warn('[Analytics/Snapshot] analytics.init did not settle within 10s; skipping')
    return
  }
  if (!analytics.initialized) {
    return
  }

  try {
    await emitInstalledSnapshot(appManager)
  } catch (err) {
    console.warn('[Analytics/Snapshot] installed snapshot failed:', err)
  }

  try {
    await emitRunsReplay(appManager, runtime)
  } catch (err) {
    console.warn('[Analytics/Snapshot] runs replay failed:', err)
  }
}

/**
 * Emit a single `installed_apps.snapshot` event summarizing the active
 * app population. Uninstalled apps are excluded.
 */
async function emitInstalledSnapshot(appManager: AppManagerService): Promise<void> {
  const apps = appManager.listApps().filter(a => a.status !== 'uninstalled')

  if (apps.length === 0) {
    // Still emit so the backend knows the install list is empty — otherwise
    // a newly-provisioned client would appear as "data missing".
    void analytics.track(AnalyticsEvents.INSTALLED_APPS_SNAPSHOT, {
      apps: [],
      count: 0,
    })
    return
  }

  // Structural fields only. The whitelist in telemetry.ts further filters
  // these if any caller tries to smuggle extra keys — this is a double
  // safety net.
  const summaries = apps.map(summarizeApp)

  void analytics.track(AnalyticsEvents.INSTALLED_APPS_SNAPSHOT, {
    apps: summaries,
    count: summaries.length,
  })
}

/** Extract the subset of spec fields we are willing to ship. */
function summarizeApp(app: InstalledApp): Record<string, unknown> {
  return {
    appId: app.id,
    specId: app.specId,
    type: app.spec.type,
    version: app.spec.version,
    status: app.status,
    installedAt: app.installedAt,
  }
}

/**
 * Replay finished runs newer than the persisted watermark as
 * `app.run.replay` events, then advance the watermark.
 */
async function emitRunsReplay(
  appManager: AppManagerService,
  runtime: AppRuntimeService
): Promise<void> {
  const { lastSnapshotTs = 0, lastSnapshotRunId } = analytics.getSnapshotState()
  const sinceTs = lastSnapshotTs

  // Walk each app's run history. The store API is per-app, so we pay a
  // small query-fanout cost but avoid schema changes. The per-app cap plus
  // the global cap keep this bounded even for long-running installations.
  const apps = appManager.listApps()

  // Collect eligible runs across all apps, then sort by finishedAt so the
  // watermark advances correctly and events arrive in order.
  const candidates: Array<{ app: InstalledApp; run: AutomationRun }> = []

  for (const app of apps) {
    const runs = runtime.getRunsForApp(app.id, MAX_RUNS_PER_APP)
    for (const run of runs) {
      if (!run.finishedAt) continue
      if (run.finishedAt <= sinceTs) continue
      // Guard against re-shipping the exact watermark run if ts happens to tie.
      if (lastSnapshotRunId && run.runId === lastSnapshotRunId) continue
      // Only replay terminal states — waiting_user / running are not final.
      if (run.status !== 'ok' && run.status !== 'error' && run.status !== 'skipped') {
        continue
      }
      candidates.push({ app, run })
    }
  }

  if (candidates.length === 0) return

  candidates.sort((a, b) => (a.run.finishedAt! - b.run.finishedAt!))

  const limited = candidates.slice(0, MAX_REPLAY_EVENTS)

  for (const { app, run } of limited) {
    void analytics.track(AnalyticsEvents.APP_RUN_REPLAY, {
      appId: app.id,
      specId: app.specId,
      runId: run.runId,
      trigger: run.triggerType,
      status: run.status,
      durationMs: run.durationMs ?? 0,
      tokensUsed: run.tokensUsed,
      errorCode: run.errorMessage ? deriveErrorCode(run.errorMessage) : undefined,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })
  }

  // Advance the watermark to the most recent finished run we shipped.
  const last = limited[limited.length - 1]
  analytics.setSnapshotState({
    runId: last.run.runId,
    ts: last.run.finishedAt,
  })

  console.log(
    `[Analytics/Snapshot] Replayed ${limited.length} run(s); watermark → ${last.run.finishedAt}`
  )
}

/** Same derivation used by apps.subscriber — duplicated to avoid cross-dep. */
function deriveErrorCode(message: string): string | undefined {
  const trimmed = message.trim()
  if (!trimmed) return undefined
  const firstToken = trimmed.split(/[\s:]+/, 1)[0] ?? trimmed
  return firstToken.slice(0, 48)
}
