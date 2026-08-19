/**
 * apps/manager -- Knowledge Base Seed Backfill
 *
 * One-time backfill for automation Apps that predate the knowledge-base
 * feature: they were installed before `knowledgeSeeded` existed, so
 * `install()` never seeded their KB bindings. Runs as a Tier 3 idle task so
 * it never blocks startup; per-app failures are logged and skipped.
 *
 * Idempotency comes from `ensureKnowledgeSeeded`, which no-ops once the flag
 * is set. Subsequent launches therefore find nothing to do.
 */

import type { AppManagerService } from './types'

/**
 * Backfill KB bindings for every unseeded automation App that still exists.
 *
 * Every live status is covered, not just `active`: a paused, errored or
 * awaiting-login App resumes into a normal run, and restricting the backfill
 * to `active` would leave it without knowledge until some later launch
 * happened to catch it in the right status. Soft-uninstalled Apps are the one
 * exclusion — binding them would leave dangling `appIds` entries on the
 * knowledge base for an App the user removed. Reinstall seeds them instead.
 *
 * @param appManager - The initialized AppManagerService
 */
export function backfillKnowledgeSeeds(appManager: AppManagerService): void {
  const apps = appManager
    .listApps({ type: 'automation' })
    .filter(app => !app.knowledgeSeeded && app.status !== 'uninstalled')

  let seeded = 0
  for (const app of apps) {
    try {
      appManager.ensureKnowledgeSeeded(app.id)
      seeded++
    } catch (err) {
      console.warn(`[AppManager] Knowledge base backfill failed for ${app.id}:`, err)
    }
  }

  if (seeded > 0) {
    console.log(`[AppManager] Backfilled knowledge bases for ${seeded} app(s)`)
  }
}
