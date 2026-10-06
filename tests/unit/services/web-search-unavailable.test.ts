/**
 * When no engine the automatic search uses can be reached, web_search tells
 * the model that web search is unavailable for this request instead of
 * suggesting another engine, so the model tells the user rather than cycling
 * through engines. Every other failure keeps its engine's guidance.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/services/browser-view.service', () => ({ browserViewManager: {} }))

import { WebSearchContext } from '../../../src/main/services/web-search/search-context'
import type { SearchBlockReason } from '../../../src/main/services/web-search/types'

type Outcome = { ok: false; reason: SearchBlockReason } | Error

/** Answers each engine's attempt with the outcome given for it. */
function searchWith(outcomes: Record<string, Outcome>) {
  const attempted: string[] = []
  vi.spyOn(WebSearchContext.prototype as never, 'executeSearch').mockImplementation((async (engine: { name: string }) => {
    attempted.push(engine.name)
    const outcome = outcomes[engine.name]
    if (outcome instanceof Error) throw outcome
    return outcome
  }) as never)
  return { context: new WebSearchContext(), attempted }
}

const unreachable = { ok: false, reason: 'unreachable' } as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web search with no reachable engine', () => {
  it('tells the model web search is unavailable once every automatic engine is out of reach', async () => {
    const { context, attempted } = searchWith({ bing: unreachable, baidu: new Error('net::ERR_CONNECTION_RESET') })

    const response = await context.search('latest release notes')

    expect(attempted.sort()).toEqual(['baidu', 'bing'])
    expect(response.results).toEqual([])
    expect(response.blocked?.reason).toBe('unreachable')
    expect(response.blocked?.guidance).toContain('Web search is unavailable right now')
    expect(response.blocked?.guidance).toContain('Do not call web_search again for this request')
    expect(response.blocked?.guidance).not.toMatch(/different engine/i)
  })

  it('keeps the engine guidance when an engine answered, even without results', async () => {
    const { context } = searchWith({ bing: { ok: false, reason: 'captcha' }, baidu: unreachable })

    const response = await context.search('latest release notes')

    expect(response.blocked?.guidance).not.toContain('Web search is unavailable')
  })

  it('keeps suggesting another engine when the engine the model asked for is out of reach', async () => {
    const { context } = searchWith({ bing: unreachable })

    const response = await context.search('latest release notes', { engine: 'bing' })

    expect(response.blocked?.guidance).toMatch(/different engine/)
  })

  it('keeps the Google guidance for a Google request', async () => {
    const { context } = searchWith({ google: unreachable })

    const response = await context.search('latest release notes', { engine: 'google' })

    expect(response.blocked?.guidance).toContain('retrying web_search with engine "bing" or "baidu"')
  })

  it('keeps the no-results guidance', async () => {
    const { context } = searchWith({ bing: { ok: false, reason: 'no_results' }, baidu: { ok: false, reason: 'no_results' } })

    const response = await context.search('latest release notes')

    expect(response.blocked?.reason).toBe('no_results')
    expect(response.blocked?.guidance).toMatch(/^No results found/)
  })
})
