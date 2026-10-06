/**
 * Merging an author's new version into an installed digital human.
 *
 * The scenario the rule exists for: a user moved the daily report from 8:00 to
 * 9:00 and appended a line to the prompt; the author then ships a better prompt,
 * a new weekly trigger, a new description and a new connection.
 */

import { describe, it, expect } from 'vitest'
import { mergeAuthorUpgrade } from '../../../../src/main/apps/manager/spec-upgrade'
import { validateAppSpec } from '../../../../src/main/apps/spec'
import type { AutomationSpec, SubscriptionDef } from '../../../../src/main/apps/spec'

const DAILY_8: SubscriptionDef = { id: 'daily', source: { type: 'schedule', config: { cron: '0 8 * * *' } } }
const DAILY_9: SubscriptionDef = { id: 'daily', source: { type: 'schedule', config: { cron: '0 9 * * *' } } }
const WEEKLY: SubscriptionDef = { id: 'weekly', source: { type: 'schedule', config: { cron: '0 9 * * 1' } } }

function v12(overrides: Partial<AutomationSpec> = {}): AutomationSpec {
  return {
    spec_version: '1',
    name: 'Daily Report',
    version: '1.2.0',
    author: 'author',
    description: 'Summarizes yesterday’s sales.',
    type: 'automation',
    system_prompt: 'Summarize sales.',
    subscriptions: [DAILY_8],
    requires: { mcps: [{ id: 'crm' }] },
    store: { slug: 'daily-report', tags: [], registry_id: 'official', install_source: 'store' },
    ...overrides,
  } as AutomationSpec
}

function v13(overrides: Partial<AutomationSpec> = {}): AutomationSpec {
  return v12({
    version: '1.3.0',
    description: 'Summarizes yesterday’s sales by region.',
    system_prompt: 'Summarize sales and flag anomalies.',
    subscriptions: [DAILY_8, WEEKLY],
    requires: { mcps: [{ id: 'crm' }, { id: 'sheets' }] },
    ...overrides,
  })
}

const edited = v12({
  system_prompt: 'Summarize sales. Only East China.',
  subscriptions: [DAILY_9],
})

describe('mergeAuthorUpgrade', () => {
  it('gives a digital human the user never edited exactly the author’s new version', () => {
    const { spec, kept } = mergeAuthorUpgrade(v12(), v12(), v13())

    expect(spec).toEqual(v13())
    expect(kept).toEqual([])
  })

  it('keeps the user’s prompt and schedule while the untouched fields and the new trigger follow the author', () => {
    const { spec, kept } = mergeAuthorUpgrade(edited, v12(), v13())

    expect(spec.system_prompt).toBe('Summarize sales. Only East China.')
    expect(spec.subscriptions).toEqual([DAILY_9, WEEKLY])
    expect(spec.description).toBe('Summarizes yesterday’s sales by region.')
    expect(spec.requires).toEqual({ mcps: [{ id: 'crm' }, { id: 'sheets' }] })
    expect(spec.version).toBe('1.3.0')
    expect([...kept].sort()).toEqual(['subscriptions', 'system_prompt'])
    expect(() => validateAppSpec(spec)).not.toThrow()
  })

  it('reports an edited field as kept even when the author did not change it', () => {
    const { spec, kept } = mergeAuthorUpgrade(v12({ name: 'My Report' }), v12(), v13())

    expect(spec.name).toBe('My Report')
    expect(kept).toEqual(['name'])
  })

  it('does not report an edit the author has since made too', () => {
    const current = v12({ description: 'Summarizes yesterday’s sales by region.' })
    const { spec, kept } = mergeAuthorUpgrade(current, v12(), v13())

    expect(spec.description).toBe('Summarizes yesterday’s sales by region.')
    expect(kept).toEqual([])
  })

  it('drops a field the author removed when the user never touched it, and keeps it when they did', () => {
    const original = v12({ recommended_model: 'model-a' })

    expect(mergeAuthorUpgrade(original, original, v13()).spec).not.toHaveProperty('recommended_model')

    const { spec, kept } = mergeAuthorUpgrade(v12({ recommended_model: 'model-b' }), original, v13())
    expect(spec.recommended_model).toBe('model-b')
    expect(kept).toEqual(['recommended_model'])
  })

  it('always takes the release fields from the author', () => {
    const current = v12({ author: 'someone else', version: '9.9.9', store: { slug: 'daily-report', tags: ['mine'] } })
    const { spec, kept } = mergeAuthorUpgrade(current, v12(), v13())

    expect(spec.author).toBe('author')
    expect(spec.version).toBe('1.3.0')
    expect(spec.store).toEqual(v13().store)
    expect(kept).toEqual([])
  })

  describe('run triggers, compared one by one', () => {
    it('keeps a trigger the user deleted deleted', () => {
      const { spec, kept } = mergeAuthorUpgrade(v12({ subscriptions: [] }), v12(), v13())

      expect(spec.subscriptions).toEqual([WEEKLY])
      expect(kept).toEqual(['subscriptions'])
    })

    it('removes a trigger the author removed unless the user edited it', () => {
      const original = v12({ subscriptions: [DAILY_8, WEEKLY] })
      const next = v13({ subscriptions: [DAILY_8] })

      expect(mergeAuthorUpgrade(original, original, next).spec.subscriptions).toEqual([DAILY_8])

      const weeklyEdited: SubscriptionDef = { id: 'weekly', source: { type: 'schedule', config: { cron: '0 10 * * 1' } } }
      const { spec, kept } = mergeAuthorUpgrade(v12({ subscriptions: [DAILY_8, weeklyEdited] }), original, next)
      expect(spec.subscriptions).toEqual([DAILY_8, weeklyEdited])
      expect(kept).toEqual(['subscriptions'])
    })

    it('updates an untouched trigger and keeps one the user added', () => {
      const hourly: SubscriptionDef = { source: { type: 'schedule', config: { every: '1h' } } }
      const daily7: SubscriptionDef = { id: 'daily', source: { type: 'schedule', config: { cron: '0 7 * * *' } } }
      const { spec } = mergeAuthorUpgrade(v12({ subscriptions: [DAILY_8, hourly] }), v12(), v13({ subscriptions: [daily7] }))

      expect(spec.subscriptions).toEqual([daily7, hourly])
    })

    it('keeps both when an id-less trigger of the user’s and a new one of the author’s share a position', () => {
      const mine: SubscriptionDef = { source: { type: 'schedule', config: { every: '1h' } } }
      const theirs: SubscriptionDef = { source: { type: 'schedule', config: { cron: '0 6 * * *' } } }
      const { spec } = mergeAuthorUpgrade(
        v12({ subscriptions: [mine] }),
        v12({ subscriptions: [] }),
        v13({ subscriptions: [theirs] }),
      )

      expect(spec.subscriptions).toEqual([theirs, mine])
      expect(() => validateAppSpec(spec)).not.toThrow()
    })

    it('lets a trigger the user named keep its id over a new one of the author’s with the same id', () => {
      const mine: SubscriptionDef = { id: 'weekly', source: { type: 'schedule', config: { cron: '0 18 * * 5' } } }
      const { spec } = mergeAuthorUpgrade(v12({ subscriptions: [DAILY_8, mine] }), v12(), v13())

      expect(spec.subscriptions).toEqual([DAILY_8, mine])
    })
  })

  describe('without the author’s original', () => {
    it('keeps every difference, adds nothing the user might have removed, and still moves the version', () => {
      const { spec, kept } = mergeAuthorUpgrade(edited, null, v13())

      expect(spec.system_prompt).toBe(edited.system_prompt)
      expect(spec.subscriptions).toEqual([DAILY_9])
      expect(spec.description).toBe(edited.description)
      expect(spec.requires).toEqual(edited.requires)
      expect(spec.version).toBe('1.3.0')
      expect([...kept].sort()).toEqual(['description', 'requires', 'subscriptions', 'system_prompt'])
    })

    it('reports nothing when the current spec already matches the new version', () => {
      const { spec, kept } = mergeAuthorUpgrade(v13({ version: '1.2.0' }), null, v13())

      expect(spec).toEqual(v13())
      expect(kept).toEqual([])
    })
  })
})
