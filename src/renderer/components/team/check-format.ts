/**
 * How a periodic check reads to a person.
 *
 * Two surfaces show the same check — the member's live panel and its settings
 * screen — and they must say it the same way, so the phrasing lives here rather
 * than in either of them.
 */

import { formatFrequency, formatCronHumanReadable } from '../apps/schedule-utils'
import type { TeamCheckSchedule } from '../../../shared/apps/team-types'

/**
 * A check's rhythm in words, reusing the phrasing a digital human's own
 * scheduled work uses — the two are the same thing at different scopes, and
 * seeing them described two different ways would suggest otherwise.
 */
export function describeRhythm(
  schedule: TeamCheckSchedule,
  t: (s: string, o?: Record<string, unknown>) => string,
  locale: string
): string {
  switch (schedule.kind) {
    case 'every':
      return formatFrequency(schedule.every, t)
    case 'cron':
      return formatCronHumanReadable(schedule.cron, locale)
    case 'once':
      return new Date(schedule.once).toLocaleString()
  }
}
