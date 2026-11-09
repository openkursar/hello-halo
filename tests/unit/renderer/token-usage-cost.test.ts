/**
 * What a reply's token usage tooltip shows. The ring and the context figures
 * are always true; the dollar figures are left out where the engine cannot
 * price a reply (a conversation on a load-balancing group).
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement, useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string) => text }),
}))

import { UsageDetails } from '../../../src/renderer/components/chat/TokenUsageIndicator'
import { TokenCostContext } from '../../../src/renderer/components/chat/token-cost-context'
import type { TokenUsage } from '../../../src/renderer/types'

const usage = (extra: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalCostUsd: 0.5, contextWindow: 200_000, ...extra,
} as TokenUsage)

const render = (props: { costShown: boolean; usage?: TokenUsage; previousCost?: number }) =>
  renderToStaticMarkup(createElement(UsageDetails, { tokenUsage: props.usage ?? usage(), previousCost: props.previousCost, costShown: props.costShown }))

describe('the token usage tooltip', () => {
  it('shows what the turn cost and the total when the engine could price it', () => {
    const html = render({ costShown: true, previousCost: 0.2 })
    expect(html).toContain('Current / total')
    expect(html).toContain('$0.30/$0.50')
  })

  it('leaves the dollar figures out where they would be wrong, and keeps everything else', () => {
    const html = render({ costShown: false })
    expect(html).not.toContain('Current / total')
    expect(html).not.toContain('$')
    expect(html).toContain('Used / limit')
    expect(html).toContain('12K / 200K')
    expect(html).toContain('Input')
    expect(html).toContain('Output')
  })

  it('shows no cost row for a reply the engine did not price, either way', () => {
    expect(render({ costShown: true, usage: usage({ totalCostUsd: 0 }) })).not.toContain('Current / total')
  })

  it('warns as the context fills, whether or not dollars are shown', () => {
    expect(render({ costShown: false, usage: usage({ inputTokens: 170_000 }) })).toContain('Approaching context limit')
    expect(render({ costShown: false, usage: usage({ inputTokens: 195_000 }) })).toContain('Context will be automatically compressed soon')
  })
})

describe('whether dollar figures can be shown', () => {
  it('defaults to showing them, and is switched off from above', () => {
    const read = (provide: boolean | undefined) => {
      let seen: boolean | undefined
      const Probe = () => { seen = useContext(TokenCostContext); return null }
      renderToStaticMarkup(provide === undefined
        ? createElement(Probe)
        : createElement(TokenCostContext.Provider, { value: provide }, createElement(Probe)))
      return seen
    }
    expect(read(undefined)).toBe(true)
    expect(read(false)).toBe(false)
  })
})
