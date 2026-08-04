/**
 * Unit tests for findAppByPublishSlug — the reverse of the publish slug
 * derivation, used to point the publish form at the local app behind a listing.
 *
 * The contract under test is deliberately narrow: an exact, unique answer or
 * none. The renderer renders the result as a hint next to a store listing, so a
 * near-miss must resolve to null rather than to a plausible-looking app.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Only the app manager is stubbed. That the registry needs no stubbing is why
// this query lives outside the publish barrel, which reaches the network.
const listApps = vi.fn()
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => ({ listApps }) }))

import { findAppByPublishSlug } from '../../../src/main/store/publish/find-app'
import type { InstalledApp } from '../../../src/main/apps/manager'
import type { AppSpec } from '../../../src/main/apps/spec/schema'

function app(
  id: string,
  spec: Partial<AppSpec>,
  status = 'idle',
  spaceId: string | null = null,
): InstalledApp {
  return {
    id,
    status,
    spaceId,
    spec: {
      spec_version: '1',
      version: '1.0.0',
      description: 'unit-test',
      type: 'skill',
      ...spec,
    },
  } as unknown as InstalledApp
}

beforeEach(() => {
  listApps.mockReset()
})

describe('store/findAppByPublishSlug', () => {
  it('matches the app whose publish derives exactly this slug', () => {
    listApps.mockReturnValue([
      app('a1', { name: 'weekly-report' }),
      app('a2', { name: 'daily-report' }),
    ])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBe('a1')
  })

  it('romanizes CJK names the same way publish does', () => {
    listApps.mockReturnValue([app('a1', { name: '周报助手', type: 'automation' })])
    expect(findAppByPublishSlug('fly/zhou-bao-zhu-shou', 'automation', 'fly')).toBe('a1')
  })

  it('prefers an explicit store.slug over the name, and re-scopes it to the author', () => {
    listApps.mockReturnValue([
      app('a1', { name: 'renamed locally', store: { slug: 'someone-else/weekly-report' } }),
    ])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBe('a1')
  })

  it('falls back to the spec author when none is supplied', () => {
    listApps.mockReturnValue([app('a1', { name: 'weekly-report', author: 'fly' })])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill')).toBe('a1')
  })

  it('returns null when a local rename moved the app off the listing', () => {
    listApps.mockReturnValue([app('a1', { name: 'weekly-report-v2' })])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBeNull()
  })

  it('returns null when the listing is scoped to another author', () => {
    listApps.mockReturnValue([app('a1', { name: 'weekly-report' })])
    expect(findAppByPublishSlug('someone-else/weekly-report', 'skill', 'fly')).toBeNull()
  })

  it('returns null when several installed apps derive the same slug', () => {
    listApps.mockReturnValue([
      app('a1', { name: 'weekly report' }),
      app('a2', { name: 'Weekly-Report' }),
    ])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBeNull()
  })

  it('still answers when the same release is installed globally and in a space', () => {
    // Installs are unique per spec *and scope*, so this pair is one app the user
    // happens to hold twice. Both publish the same bytes — there is no choice to
    // abstain over, and abstaining here reads as the hint randomly vanishing.
    listApps.mockReturnValue([
      app('a-space', { name: 'weekly-report' }, 'idle', 'space-1'),
      app('a-global', { name: 'weekly-report' }, 'idle', null),
    ])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBe('a-global')
  })

  it('returns null when duplicate installs have drifted apart', () => {
    // Same app, but the two copies would publish different releases: a real
    // choice, so the lookup must abstain.
    listApps.mockReturnValue([
      app('a-space', { name: 'weekly-report', version: '1.0.0' }, 'idle', 'space-1'),
      app('a-global', { name: 'weekly-report', version: '2.0.0' }, 'idle', null),
    ])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBeNull()
  })

  it('ignores uninstalled apps', () => {
    listApps.mockReturnValue([app('a1', { name: 'weekly-report' }, 'uninstalled')])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBeNull()
  })

  it('skips apps with no derivable slug instead of failing the lookup', () => {
    listApps.mockReturnValue([
      app('a1', { name: '——' }),
      app('a2', { name: 'weekly-report' }),
    ])
    expect(findAppByPublishSlug('fly/weekly-report', 'skill', 'fly')).toBe('a2')
  })

  it('returns null for an unscoped slug', () => {
    listApps.mockReturnValue([app('a1', { name: 'weekly-report' })])
    expect(findAppByPublishSlug('weekly-report', 'skill', 'fly')).toBeNull()
  })

  it('narrows candidates by app type when the listing declares one', () => {
    listApps.mockImplementation((filter?: { type?: string }) =>
      [
        app('a1', { name: 'weekly-report', type: 'skill' }),
        app('a2', { name: 'weekly-report', type: 'automation' }),
      ].filter(a => !filter?.type || a.spec.type === filter.type)
    )
    expect(findAppByPublishSlug('fly/weekly-report', 'automation', 'fly')).toBe('a2')
    // Without a type the two collide and the lookup must abstain.
    expect(findAppByPublishSlug('fly/weekly-report', undefined, 'fly')).toBeNull()
  })
})
