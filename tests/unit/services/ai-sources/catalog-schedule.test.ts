import { describe, it, expect } from 'vitest'
import { CatalogSchedule, CATALOG_FRESH_MS, CATALOG_RETRY_MS } from '../../../../src/main/services/ai-sources/catalog-schedule'

function schedule(): { clock: { now: number }; schedule: CatalogSchedule } {
  const clock = { now: 1_000_000 }
  return { clock, schedule: new CatalogSchedule(() => clock.now) }
}

describe('CatalogSchedule', () => {
  it('treats a source never read in this process as due', () => {
    const { schedule: s } = schedule()
    expect(s.isDue('a')).toBe(true)
  })

  it('keeps a current catalog fresh for the fresh window', () => {
    const { clock, schedule: s } = schedule()
    s.record('a', true)
    clock.now += CATALOG_FRESH_MS - 1
    expect(s.isDue('a')).toBe(false)
    clock.now += 1
    expect(s.isDue('a')).toBe(true)
  })

  it('retries a failed or fallback read sooner than a current one expires', () => {
    const { clock, schedule: s } = schedule()
    s.record('a', false)
    expect(s.isDue('a')).toBe(false)
    clock.now += CATALOG_RETRY_MS
    expect(s.isDue('a')).toBe(true)
    expect(CATALOG_RETRY_MS).toBeLessThan(CATALOG_FRESH_MS)
  })

  it('forgets removed sources so a re-added id starts due', () => {
    const { schedule: s } = schedule()
    s.record('a', true)
    s.record('b', true)
    s.retain(['b'])
    expect(s.isDue('a')).toBe(true)
    expect(s.isDue('b')).toBe(false)
  })
})
