/**
 * Which subscriptions keep to mainland China working days: one rule, read by
 * the runtime (to fetch the holiday calendar) and by the settings switch alike.
 */

import { describe, expect, it } from 'vitest'
import { usesWorkdayCalendar, type SubscriptionDef } from '../../../src/shared/apps/spec-types'

describe('usesWorkdayCalendar', () => {
  it('is a schedule limited to working days, and nothing else', () => {
    const schedule = (config: Record<string, unknown>): SubscriptionDef => ({ source: { type: 'schedule', config } } as SubscriptionDef)

    expect(usesWorkdayCalendar(schedule({ cron: '0 9 * * *', workday_calendar: true }))).toBe(true)
    expect(usesWorkdayCalendar(schedule({ cron: '0 9 * * *' }))).toBe(false)
    expect(usesWorkdayCalendar(schedule({ every: '1h', workday_calendar: false }))).toBe(false)
    expect(usesWorkdayCalendar({ source: { type: 'file', config: { pattern: '*.md' } } } as SubscriptionDef)).toBe(false)
  })
})
