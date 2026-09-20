/**
 * Automation App Effective Status
 *
 * An automation app has two status sources: the persisted `InstalledApp.status`
 * and the live `AutomationAppState.status` pushed over `app:status_changed`.
 * The runtime state is more precise (distinguishes running/queued/idle) but is
 * only available once the app has been activated — so callers fall back to the
 * persisted status, treating 'active' as 'idle' since idle is what 'active'
 * means before any runtime state has arrived.
 */

import type { AppStatus, AutomationAppState, RunStatus } from '../../shared/apps/app-types'

export type EffectiveAutomationStatus = AppStatus | AutomationAppState['status']

export function deriveAutomationStatus(
  status: AppStatus,
  runtimeStatus?: AutomationAppState['status']
): EffectiveAutomationStatus {
  return runtimeStatus ?? (status === 'active' ? 'idle' : status)
}

/**
 * User-facing status label. `idle` ("值班中") and `paused` ("已暂停") are
 * deliberately distinct — the prior single "Standing by" wording collapsed
 * "scheduled and waiting for its next trigger" into "user turned this off",
 * which is a semantic error, not a wording preference.
 */
export function automationStatusLabel(status: EffectiveAutomationStatus, t: (s: string) => string): string {
  switch (status) {
    case 'running': return t('Working')
    case 'queued': return t('Queued')
    case 'idle': return t('Standing by')
    case 'paused': return t('Paused')
    case 'waiting_user': return t('Waiting for you')
    case 'needs_login': return t('Needs login')
    case 'error': return t('Encountered an issue')
    case 'uninstalled': return t('Uninstalled')
    default: return status
  }
}

/** Text color token for the status label, paired with {@link automationStatusLabel}. */
export function automationStatusTextClass(status: EffectiveAutomationStatus): string {
  switch (status) {
    case 'running': return 'text-primary'
    case 'waiting_user': return 'text-halo-warning'
    case 'needs_login': return 'text-halo-warning'
    case 'error': return 'text-halo-error'
    case 'paused': return 'text-subtle-foreground'
    default: return 'text-muted-foreground'
  }
}

/** Dot color for one run outcome, used by the Overview strip and the card wall. */
export function runStatusDotClass(status: RunStatus): string {
  switch (status) {
    case 'ok': return 'bg-green-500'
    case 'error': return 'bg-red-500'
    case 'skipped': return 'bg-muted-foreground/30 border border-muted-foreground/40'
    case 'running': return 'bg-green-500 animate-pulse'
    case 'waiting_user': return 'bg-orange-400'
    default: return 'bg-muted-foreground/30'
  }
}
