/**
 * buildMcpServerRecord assembles the creation-time in-process MCP server set.
 * These pin the assembly invariants (open/close semantics live in
 * toolsets-last-used.test.ts and are not re-tested here):
 *   - the capabilities meta server is present iff at least one toolset is disabled;
 *   - EVERY instance is created fresh per build: an in-process MCP server binds
 *     to exactly one session transport, so an instance reused across session
 *     rebuilds fails to connect and its tools silently vanish;
 *   - halo-apps is gated by config.agent.enableDigitalHumans.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const openSets = vi.hoisted(() => new Map<string, Set<string>>())
const metaCalls = vi.hoisted(() => ({ n: 0 }))

vi.mock('../../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => config.value),
  saveConfig: vi.fn()
}))

vi.mock('../../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: vi.fn(() => ({ tag: 'web-search' }))
}))
vi.mock('../../../../../src/main/services/app-bridge', () => ({
  createHaloAppsMcpServer: vi.fn((spaceId: string) => ({ tag: 'halo-apps', spaceId }))
}))
vi.mock('../../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))

vi.mock('../../../../../src/main/services/agent/toolsets/meta-server', () => ({
  createBrokerMetaServer: vi.fn(() => ({ tag: `meta-${++metaCalls.n}` })),
  CAPABILITIES_SERVER_NAME: 'capabilities'
}))

const ALL = ['ai-browser', 'ai-terminal', 'halo-api-ref']
vi.mock('../../../../../src/main/services/agent/toolsets/registry', () => ({
  getAvailableToolsets: vi.fn(() => ALL.map(id => ({ id }))),
  getToolset: vi.fn((id: string) =>
    ALL.includes(id) ? { id, createServer: vi.fn(() => ({ tag: `toolset-${id}` })) } : undefined
  )
}))

vi.mock('../../../../../src/main/services/agent/toolsets/state', () => ({
  getOpenToolsets: vi.fn((_s: string, c: string) => openSets.get(c) ?? new Set<string>()),
  markOpen: vi.fn(),
  markClosed: vi.fn()
}))

import { buildMcpServerRecord } from '../../../../../src/main/services/agent/toolsets/broker'
import type { ToolsetScope } from '../../../../../src/main/services/agent/toolsets/types'

const scope: ToolsetScope = { spaceId: 'space-1', conversationId: 'conv-1', workDir: '/tmp' }

function setOpen(ids: string[]): void {
  openSets.set('conv-1', new Set(ids))
}

beforeEach(() => {
  config.value = {}
  openSets.clear()
  metaCalls.n = 0
  vi.clearAllMocks()
})

describe('buildMcpServerRecord — capabilities meta server', () => {
  it('includes capabilities when at least one toolset is disabled', () => {
    setOpen(['ai-browser']) // ai-terminal still disabled
    const record = buildMcpServerRecord(scope)
    expect(record.capabilities).toBeDefined()
  })

  it('omits capabilities once every toolset is open', () => {
    setOpen(ALL)
    const record = buildMcpServerRecord(scope)
    expect(record.capabilities).toBeUndefined()
  })

  it('recreates the capabilities server on every build', () => {
    setOpen([]) // both disabled → capabilities present
    const first = buildMcpServerRecord(scope).capabilities
    const second = buildMcpServerRecord(scope).capabilities
    expect(first).not.toBe(second)
  })
})

describe('buildMcpServerRecord — fresh instances per build', () => {
  // Regression pin: a per-conversation instance cache once made a rebuilt session
  // receive instances still bound to the torn-down session's transport, whose
  // connect failure is swallowed by the SDK (tools silently unavailable).
  it('creates new always-on / toolset instances on every build', () => {
    setOpen(['ai-browser'])
    const a = buildMcpServerRecord(scope)
    const b = buildMcpServerRecord(scope)
    expect(b['web-search']).not.toBe(a['web-search'])
    expect(b['ai-browser']).not.toBe(a['ai-browser'])
  })

  it('gives different conversations their own instances', () => {
    setOpen([])
    openSets.set('conv-2', new Set())
    const a = buildMcpServerRecord(scope)
    const b = buildMcpServerRecord({ ...scope, conversationId: 'conv-2' })
    expect(b['web-search']).not.toBe(a['web-search'])
  })
})

describe('buildMcpServerRecord — halo-api-ref is on demand', () => {
  it('is absent from the always-on set', () => {
    // It was always-on once, while the credential and the prompt paragraph
    // were decided elsewhere — so sessions were told to use a tool they could
    // not authenticate. It is a registry toolset now; nothing here may add it.
    setOpen([])
    expect(buildMcpServerRecord(scope)['halo-api-ref']).toBeUndefined()
  })

  it('is present once the toolset is open', () => {
    setOpen(['halo-api-ref'])
    expect(buildMcpServerRecord(scope)['halo-api-ref']).toEqual({ tag: 'toolset-halo-api-ref' })
  })
})

describe('buildMcpServerRecord — halo-apps gating', () => {
  it('includes halo-apps by default (enableDigitalHumans undefined)', () => {
    setOpen([])
    const record = buildMcpServerRecord(scope)
    expect(record['halo-apps']).toEqual({ tag: 'halo-apps', spaceId: 'space-1' })
  })

  it('includes halo-apps when enableDigitalHumans is explicitly true', () => {
    config.value = { agent: { enableDigitalHumans: true } }
    setOpen([])
    expect(buildMcpServerRecord(scope)['halo-apps']).toBeDefined()
  })

  it('omits halo-apps when enableDigitalHumans is false', () => {
    config.value = { agent: { enableDigitalHumans: false } }
    setOpen([])
    expect(buildMcpServerRecord(scope)['halo-apps']).toBeUndefined()
    // web-search is unconditional.
    expect(buildMcpServerRecord(scope)['web-search']).toBeDefined()
  })
})
