/**
 * A schedule limited to mainland China working days survives validation, so
 * the option the user or the model set is not silently dropped.
 */

import { describe, expect, it } from 'vitest'
import { validateAppSpec, AppSpecValidationError } from '../../../../src/main/apps/spec'

function specWith(config: Record<string, unknown>) {
  return {
    name: 'Daily report',
    version: '1.0',
    author: 'tester',
    description: 'Writes the daily report',
    type: 'automation',
    system_prompt: 'Write the daily report.',
    subscriptions: [{ source: { type: 'schedule', config } }],
  }
}

describe('workday_calendar on a schedule', () => {
  it('is kept', () => {
    const spec = validateAppSpec(specWith({ cron: '0 9 * * *', workday_calendar: true }))
    if (spec.type !== 'automation') throw new Error('expected an automation spec')

    expect(spec.subscriptions?.[0].source.config).toEqual({ cron: '0 9 * * *', workday_calendar: true })
  })

  it('rejects anything but true or false', () => {
    expect(() => validateAppSpec(specWith({ cron: '0 9 * * *', workday_calendar: 'yes' }))).toThrow(AppSpecValidationError)
  })
})
