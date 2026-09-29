/**
 * buildBaseToolset — the servers every user-facing session starts from.
 * Pins the exclusion mechanism entries rely on and the one global switch
 * (digital humans) that gates a member of the base.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const config = vi.hoisted(() => ({ value: {} as Record<string, any> }))
const bridge = vi.hoisted(() => ({
  createHaloAppsMcpServer: vi.fn((..._args: unknown[]): unknown => ({ tag: 'halo-apps' })),
}))

vi.mock('../../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => config.value),
}))
vi.mock('../../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: vi.fn(() => ({ tag: 'web-search' })),
}))
vi.mock('../../../../../src/main/services/app-bridge', () => bridge)
vi.mock('../../../../../src/main/services/official-docs-mcp', () => ({
  createOfficialDocsSession: vi.fn(() => ({ server: { tag: 'halo-docs' }, guideConsulted: () => false })),
}))

import { buildBaseToolset, BASE_SERVER_IDS } from '../../../../../src/main/services/agent/toolsets/base'

beforeEach(() => {
  config.value = {}
  vi.clearAllMocks()
})

describe('buildBaseToolset', () => {
  it('holds exactly the declared base servers by default', () => {
    const record = buildBaseToolset({ spaceId: 'space-1' })
    expect(Object.keys(record).sort()).toEqual([...BASE_SERVER_IDS].sort())
  })

  it('leaves out what the entry excludes, and nothing else', () => {
    const record = buildBaseToolset({ spaceId: 'space-1', exclude: ['halo-apps'] })
    expect(Object.keys(record).sort()).toEqual(['halo-docs', 'web-search'])
    expect(bridge.createHaloAppsMcpServer).not.toHaveBeenCalled()
  })

  it('keeps the documentation when digital humans are switched off', () => {
    config.value = { agent: { enableDigitalHumans: false } }
    const record = buildBaseToolset({ spaceId: 'space-1' })
    expect(Object.keys(record).sort()).toEqual(['halo-docs', 'web-search'])
  })

  it('omits halo-apps while the Apps layer is not wired in', () => {
    bridge.createHaloAppsMcpServer.mockReturnValueOnce(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const record = buildBaseToolset({ spaceId: 'space-1' })
    expect(record['halo-apps']).toBeUndefined()
    expect(record['halo-docs']).toBeDefined()
    // A silently missing server would read as "digital humans switched off".
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('halo-apps not mounted'))
    warn.mockRestore()
  })

  it('scopes halo-apps to the space and passes the caller\'s person-context choice through', () => {
    buildBaseToolset({ spaceId: 'space-9', omitPersonContext: true })
    expect(bridge.createHaloAppsMcpServer).toHaveBeenCalledWith('space-9', expect.any(Function), { omitPersonContext: true })
  })

  it('builds fresh instances on every call', () => {
    const first = buildBaseToolset({ spaceId: 'space-1' })
    const second = buildBaseToolset({ spaceId: 'space-1' })
    expect(second['web-search']).not.toBe(first['web-search'])
    expect(second['halo-docs']).not.toBe(first['halo-docs'])
  })
})
