/**
 * Upgrade Service
 *
 * Periodic + on-demand version-check + dispatch for installed Apps.
 *
 * Design:
 *   - One singleton interval (default 6h) registered from extended bootstrap.
 *   - Each tick calls `registry.checkUpdates()` against the installed app list
 *     and dispatches per-app based on the persisted upgradeStrategy:
 *       - 'auto'    + patch|minor → silent applyUpgrade('patch_minor')
 *       - 'auto'    + major       → emit 'store:upgrade-available' (user confirms)
 *       - 'notify'  + any         → emit 'store:upgrade-available'
 *       - 'manual'  + any         → emit 'store:upgrade-available' (badge only)
 *   - Errors are isolated per-app — one failure must not block other upgrades.
 *
 * Why this module owns the loop (not platform/scheduler):
 *   - The scheduler is for user-defined automation jobs; coupling system
 *     upgrades to it would complicate the user-visible scheduler surface.
 *   - A single `setInterval` registered at bootstrap is sufficient for a
 *     low-frequency (6h) maintenance task with no user-visible scheduling.
 */

import { getAppManager } from '../apps/manager'
import { checkUpdates, applyUpgrade, emitUpgradeAvailable } from './registry.service'
import type { UpdateInfo } from '../../shared/store/store-types'

/** Default check interval: 6 hours. Override via `appStore.upgradeCheckIntervalMs` in HaloConfig. */
export const DEFAULT_UPGRADE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let intervalMs = DEFAULT_UPGRADE_CHECK_INTERVAL_MS
let runningTick = false

/**
 * Start the periodic upgrade-check loop.
 *
 * Idempotent — calling twice replaces the existing timer.
 * Performs an immediate first check 60s after start so users see updates
 * shortly after launch, then settles into the configured interval.
 */
export function startUpgradeScheduler(opts?: { intervalMs?: number }): void {
  stopUpgradeScheduler()
  intervalMs = opts?.intervalMs && opts.intervalMs > 0
    ? opts.intervalMs
    : DEFAULT_UPGRADE_CHECK_INTERVAL_MS

  console.log(
    `[UpgradeService] Starting scheduler (interval=${intervalMs}ms, first run in 60s)`
  )

  // Defer first run so we don't hit the registry during cold-start contention
  setTimeout(() => {
    void checkNow().catch(err => console.error('[UpgradeService] initial check failed:', err))
  }, 60_000)

  timer = setInterval(() => {
    void checkNow().catch(err => console.error('[UpgradeService] periodic check failed:', err))
  }, intervalMs)
}

/** Stop the periodic upgrade-check loop. */
export function stopUpgradeScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    console.log('[UpgradeService] Scheduler stopped')
  }
}

/**
 * Run an upgrade check + dispatch immediately.
 *
 * Safe to call ad-hoc from IPC ("Check now" button). Coalesces concurrent
 * invocations so a fast user click can't double-fire the same tick.
 *
 * @returns Summary of what happened in this tick
 */
export async function checkNow(): Promise<{
  checked: number
  available: number
  autoApplied: number
  notified: number
}> {
  if (runningTick) {
    console.log('[UpgradeService] checkNow: already running, skipping')
    return { checked: 0, available: 0, autoApplied: 0, notified: 0 }
  }
  runningTick = true

  const start = Date.now()
  let autoApplied = 0
  let notified = 0

  try {
    const manager = getAppManager()
    if (!manager) {
      console.log('[UpgradeService] checkNow: App Manager not ready, skipping')
      return { checked: 0, available: 0, autoApplied: 0, notified: 0 }
    }

    // Only check active installed apps (paused/uninstalled/error shouldn't auto-upgrade)
    const installed = manager.listApps().filter(a => a.status === 'active')
    const updates: UpdateInfo[] = await checkUpdates(
      installed.map(a => ({
        id: a.id,
        upgradeStrategy: a.upgradeStrategy,
        spec: { name: a.spec.name, version: a.spec.version, store: a.spec.store },
      }))
    )

    for (const update of updates) {
      try {
        if (update.strategy === 'auto' && (update.severity === 'patch' || update.severity === 'minor')) {
          // Silent path: apply patch/minor, no user surface
          await applyUpgrade(update.appId, 'patch_minor')
          autoApplied++
          console.log(
            `[UpgradeService] Auto-applied ${update.severity} upgrade: ` +
            `${update.appId} ${update.currentVersion} -> ${update.latestVersion}`
          )
        } else {
          // Surface to user: major-on-auto, notify, manual
          emitUpgradeAvailable({
            appId: update.appId,
            currentVersion: update.currentVersion,
            latestVersion: update.latestVersion,
            strategy: update.strategy,
            severity: update.severity,
          })
          notified++
        }
      } catch (err) {
        console.warn(
          `[UpgradeService] Failed to dispatch upgrade for ${update.appId}:`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    console.log(
      `[UpgradeService] checkNow: checked=${installed.length} ` +
      `available=${updates.length} autoApplied=${autoApplied} notified=${notified} ` +
      `(${Date.now() - start}ms)`
    )

    return {
      checked: installed.length,
      available: updates.length,
      autoApplied,
      notified,
    }
  } finally {
    runningTick = false
  }
}
