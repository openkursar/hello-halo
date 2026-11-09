import { describe, expect, it } from 'vitest'
import type { InstalledApp } from '../../../../src/shared/apps/app-types'
import { buildToolDiscoveryOptions, getMcpContextAppIds, markInstalledMcpContext } from '../../../../src/main/services/agent/tool-discovery'

function app(overrides: Record<string, unknown> = {}, id = 'installed-1', description = 'Customer orders'): InstalledApp {
  return { id, spec: { type: 'mcp', description }, userOverrides: overrides } as InstalledApp
}

describe('Halo tool discovery policy', () => {
  it('tracks exact installed instances from the final pool without parsing server names', () => {
    const global = markInstalledMcpContext({}, app({}, 'global-installation'))
    const local = markInstalledMcpContext({}, app({}, 'space-installation'))
    expect([...getMcpContextAppIds({ same_name: global, alias: global, 'mcp__global_installation': {}, builtin: { type: 'sdk' } })])
      .toEqual(['global-installation'])
    expect([...getMcpContextAppIds({ same_name: local })]).toEqual(['space-installation'])
    expect(getMcpContextAppIds({}).size).toBe(0)
    expect(buildToolDiscoveryOptions({ same_name: local })!.services.same_name).not.toHaveProperty('appId')
  })

  it('keeps installed preferences and identity out of every transport field', () => {
    const transport = { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'fixture-token' } }
    const before = JSON.stringify(transport)
    const server = markInstalledMcpContext(transport, app({ mcpContext: { loading: 'eager', summary: 'Orders and invoices' } }))
    expect(server).toBe(transport)
    expect(JSON.stringify(server)).toBe(before)
    expect(buildToolDiscoveryOptions({ customer: server })).toEqual({ services: {
      customer: { identity: 'app:installed-1', loading: 'eager', summary: 'Orders and invoices' },
    } })
    expect(JSON.stringify(buildToolDiscoveryOptions({ customer: server }))).not.toContain('fixture-token')
  })

  it('defaults installed MCP to deferred and falls back from blank overrides to its description', () => {
    const server = markInstalledMcpContext({}, app({ mcpContext: { summary: '  ' } }))
    expect(buildToolDiscoveryOptions({ customer: server })?.services.customer).toEqual({
      identity: 'app:installed-1', loading: 'deferred', summary: 'Customer orders',
    })
  })

  it('leaves a missing summary for SDK server metadata and bounds Unicode summaries', () => {
    const empty = markInstalledMcpContext({}, app({}, 'empty', ''))
    const long = markInstalledMcpContext({}, app({}, 'large', '😀'.repeat(600)))
    const policies = buildToolDiscoveryOptions({ empty, long })!.services
    expect(policies.empty).not.toHaveProperty('summary')
    expect(Array.from(policies.long.summary!)).toHaveLength(512)
    expect(policies.long.summary).toBe('😀'.repeat(512))
  })

  it('only configures mounted servers and freezes the preferences selected for that preparation', () => {
    const record = app({ mcpContext: { loading: 'eager', summary: 'Original' } })
    const customer = markInstalledMcpContext({}, record)
    record.userOverrides.mcpContext!.summary = 'Later'
    expect(buildToolDiscoveryOptions({ customer })?.services.customer.summary).toBe('Original')
    expect(buildToolDiscoveryOptions({})).toBeUndefined()
  })

  it('separates global and space installations of the same service', () => {
    const global = markInstalledMcpContext({}, app({}, 'global'))
    const local = markInstalledMcpContext({}, app({}, 'local'))
    expect(buildToolDiscoveryOptions({ service: global })?.services.service.identity)
      .not.toBe(buildToolDiscoveryOptions({ service: local })?.services.service.identity)
  })

  it('defers only the two designated built-in SDK servers; unknown services stay eager', () => {
    const policies = buildToolDiscoveryOptions({
      'halo-apps': { type: 'sdk' }, 'halo-email': { type: 'sdk' },
      'ai-browser': { type: 'sdk' }, 'ai-terminal': { type: 'sdk' },
      custom: { type: 'http' }, unknown: { type: 'sdk' },
    })!
    expect(Object.keys(policies.services)).toEqual(['halo-apps', 'halo-email'])
    expect(Object.values(policies.services).every(service => service.loading === 'deferred')).toBe(true)
    expect(buildToolDiscoveryOptions({ 'halo-email': { type: 'http' }, toString: { type: 'sdk' } })).toEqual({ services: {} })
  })

  it('uses installed provenance even when a service name matches a built-in', () => {
    const server = markInstalledMcpContext({ type: 'sdk' }, app({ mcpContext: { loading: 'eager' } }))
    expect(buildToolDiscoveryOptions({ 'halo-apps': server })?.services['halo-apps']).toMatchObject({
      identity: 'app:installed-1', loading: 'eager', summary: 'Customer orders',
    })
  })

  it('supports prototype-named installed services without mutating the catalog prototype', () => {
    const server = markInstalledMcpContext({}, app())
    const policies = buildToolDiscoveryOptions(Object.fromEntries([['__proto__', server]]))!
    expect(Object.keys(policies.services)).toEqual(['__proto__'])
    expect(JSON.parse(JSON.stringify(policies)).services.__proto__.identity).toBe('app:installed-1')
  })
})
