/**
 * Command-palette session telemetry: open/close pairing, pick ranks, and one
 * outcome per message-content search run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackEvent = vi.fn()

vi.mock('../../../src/renderer/api', () => ({ api: { trackEvent } }))
vi.mock('../../../src/renderer/api/transport', () => ({
  isElectron: () => true,
  isCapacitor: () => false,
}))

const { createSearchSession } = await import('../../../src/renderer/components/search/search-session')

function emitted(event: string) {
  return trackEvent.mock.calls.filter(([name]) => name === event).map(([, props]) => props)
}

describe('search session telemetry', () => {
  let now = 0
  const session = () => createSearchSession(() => now)

  beforeEach(() => {
    now = 0
    trackEvent.mockClear()
  })

  it('pairs every open with exactly one close', () => {
    const s = session()
    s.open('shortcut', 'global', '')
    s.open('icon', 'space', '')
    s.close()
    s.close()

    expect(emitted('home.search.open')).toEqual([{ surface: 'shortcut', scope: 'global', shell: 'wide' }])
    expect(emitted('home.search.close')).toEqual([
      { outcome: 'abandoned', hadQuery: false, deepSearched: false, shell: 'wide' },
    ])
  })

  it('closes as picked once anything was activated, and starts each session fresh', () => {
    const s = session()
    s.open('icon', 'space', '')
    s.noteQuery('rep')
    s.pick('quick_hit', 'conv', 4)
    s.close()
    s.open('icon', 'space', 'kept query')
    s.close()

    expect(emitted('home.search.pick')).toEqual([{ kind: 'quick_hit', type: 'conv', rank: '4-10', shell: 'wide' }])
    expect(emitted('home.search.close').map(({ outcome, hadQuery }) => ({ outcome, hadQuery }))).toEqual([
      { outcome: 'picked', hadQuery: true },
      { outcome: 'abandoned', hadQuery: true },
    ])
  })

  it('does not count moving on to a message search as a pick', () => {
    const s = session()
    s.open('icon', 'space', 'rep')
    s.pick('search_messages', 'message', 1)
    s.close()

    expect(emitted('home.search.close').map(({ outcome }) => outcome)).toEqual(['abandoned'])
  })

  it('reports a finished search with its result and latency buckets', () => {
    const s = session()
    s.open('icon', 'global', '')
    const run = s.queryStarted('space', 12)
    now = 700
    s.queryEnded(run, 'done', 0)
    s.queryEnded(run, 'error')
    s.close()

    expect(emitted('home.search.query')).toEqual([{
      scope: 'space',
      outcome: 'done',
      zero: true,
      lenBucket: '0-20',
      resultBucket: '0',
      latencyBucket: '500-1000',
      shell: 'wide',
    }])
    expect(emitted('home.search.close')[0]).toMatchObject({ deepSearched: true, hadQuery: true })
  })

  it('reports a cancelled search once, ignoring its late completion', () => {
    const s = session()
    const run = s.queryStarted('global', 150)
    s.queryCancelled()
    s.queryCancelled()
    s.queryEnded(run, 'done', 30)

    expect(emitted('home.search.query')).toEqual([{
      scope: 'global',
      outcome: 'cancelled',
      zero: undefined,
      lenBucket: '100-500',
      resultBucket: undefined,
      latencyBucket: '0-200',
      shell: 'wide',
    }])
  })
})
