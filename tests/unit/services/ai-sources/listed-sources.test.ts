import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AISource, AISourcesConfig } from '../../../../src/shared/types'

const config = vi.hoisted(() => ({
  saved: undefined as unknown,
  handlers: new Set<(sources: unknown) => void>(),
}))
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ aiSources: config.saved }),
  onAiSourcesConfigChange: (handler: (sources: unknown) => void) => {
    config.handlers.add(handler)
    return () => { config.handlers.delete(handler) }
  },
}))

import { watchListedSources } from '../../../../src/main/services/ai-sources/listed-sources'

function account(id: string, over: Partial<AISource> = {}): AISource {
  return {
    id, name: id, provider: 'claude', authType: 'oauth', apiUrl: '',
    accessToken: 'token', refreshToken: 'refresh', tokenExpires: 1,
    model: 'sonnet', availableModels: [{ id: 'sonnet', name: 'Sonnet' }],
    createdAt: 't', updatedAt: 't', ...over,
  } as AISource
}

function sources(list: AISource[], currentId: string | null = list[0]?.id ?? null, groups?: AISourcesConfig['groups']): AISourcesConfig {
  return { version: 2, currentId, sources: list, ...(groups ? { groups } : {}) } as AISourcesConfig
}

function save(next: AISourcesConfig): void {
  config.saved = next
  for (const handler of config.handlers) handler(next)
}

describe('watchListedSources', () => {
  beforeEach(() => {
    config.handlers.clear()
    config.saved = sources([account('fly')])
  })

  it('announces an account added elsewhere, with the new selection', () => {
    const onChange = vi.fn()
    watchListedSources(onChange)
    save(sources([account('fly'), account('bell')], 'bell'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].sourceIds.sort()).toEqual(['bell', 'fly'])
  })

  it('stays silent when only credentials and timestamps were renewed', () => {
    const onChange = vi.fn()
    watchListedSources(onChange)
    save(sources([account('fly', { accessToken: 'new', refreshToken: 'new', tokenExpires: 2, updatedAt: 'later' })]))
    save(sources([account('fly', { accessToken: 'newer' })]))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('announces removals, renames, model lists and groups', () => {
    const onChange = vi.fn()
    config.saved = sources([account('fly'), account('bell')], 'fly')
    watchListedSources(onChange)
    save(sources([account('fly')], 'fly'))
    save(sources([account('fly', { name: 'Fly' })], 'fly'))
    save(sources([account('fly', { name: 'Fly', availableModels: [{ id: 'opus', name: 'Opus' }] })], 'fly'))
    save(sources([account('fly', { name: 'Fly', availableModels: [{ id: 'opus', name: 'Opus' }] })], 'fly', [{ id: 'g1' } as never]))
    expect(onChange.mock.calls.map(call => call[0].sourceIds)).toEqual([['bell'], ['fly'], ['fly'], ['g1']])
  })

  it('stops announcing once unsubscribed', () => {
    const onChange = vi.fn()
    const stop = watchListedSources(onChange)
    stop()
    save(sources([account('fly'), account('bell')]))
    expect(onChange).not.toHaveBeenCalled()
  })
})
