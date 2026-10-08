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
    // Pausing stops automatic tasks only; the person still answers in chat.
    case 'paused': return t('Automatic tasks paused')
    case 'waiting_user': return t('Waiting for you')
    case 'needs_login': return t('Needs login')
    case 'error': return t('Encountered an issue')
    case 'uninstalled': return t('Uninstalled')
    default: return status
  }
}

/**
 * One digital human's status: the switcher strip, its hover card and the
 * directory card show exactly this; the detail header shows it for a stop
 * and its effective status otherwise, with open questions as a button of
 * their own. Strongest claim first: a stop reads as its persisted status
 * ("Encountered an issue", "Needs login") whatever the runtime is doing; then
 * open questions with their count; then a run in flight; then automatic tasks
 * being off, which stopping also implies (hence after the stop); then the
 * effective status. `flag` marks what needs the owner: `alert` for a stop
 * after repeated errors, `attention` for anything else waiting on them.
 */
export function describePersonStatus(
  appStatus: AppStatus,
  state: Pick<AutomationAppState, 'status' | 'blocked' | 'pendingDecisionCount' | 'automaticEnabled'> | undefined,
  t: (s: string, options?: Record<string, unknown>) => string
): { effective: EffectiveAutomationStatus; label: string; flag?: 'alert' | 'attention' } {
  if (state?.blocked) {
    const effective: EffectiveAutomationStatus = state.blocked === 'needs_login' ? 'needs_login' : 'error'
    return { effective, label: automationStatusLabel(effective, t), flag: state.blocked === 'auto_disabled' ? 'alert' : 'attention' }
  }
  const effective = deriveAutomationStatus(appStatus, state?.status)
  const pending = state?.pendingDecisionCount ?? 0
  if (pending > 0) return { effective, label: t('{{count}} waiting', { count: pending }), flag: 'attention' }
  if (state?.automaticEnabled === false && effective !== 'running') {
    return { effective: 'paused', label: automationStatusLabel('paused', t) }
  }
  return { effective, label: automationStatusLabel(effective, t) }
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
