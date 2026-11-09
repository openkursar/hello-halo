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
vi.mock('../../../../../src/main/services/official-docs-mcp', () => ({
  createOfficialDocsSession: vi.fn(() => ({ server: { tag: 'halo-docs' }, guideConsulted: () => false }))
}))
vi.mock('../../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))

vi.mock('../../../../../src/main/services/agent/toolsets/meta-server', () => ({
  createBrokerMetaServer: vi.fn(() => ({ tag: `meta-${++metaCalls.n}` })),
  CAPABILITIES_SERVER_NAME: 'capabilities'
}))

const ALL = ['ai-browser', 'ai-terminal', 'ocr', 'halo-team', 'halo-api-ref']
const contextManaged = (id: string) => id !== 'optional-fixture'
vi.mock('../../../../../src/main/services/agent/toolsets/registry', () => ({
  getAvailableToolsets: vi.fn(() => [...ALL, ...(config.value.optional ? ['optional-fixture'] : [])].map(id => ({ id, contextManaged: contextManaged(id) }))),
  getToolset: vi.fn((id: string) =>
    [...ALL, 'optional-fixture'].includes(id) ? { id, contextManaged: contextManaged(id), createServer: vi.fn(() => ({ tag: `toolset-${id}` })) } : undefined
  )
}))

vi.mock('../../../../../src/main/services/agent/toolsets/state', () => ({
  getOpenToolsets: vi.fn((_s: string, c: string) => openSets.get(c) ?? new Set<string>()),
  markOpen: vi.fn((_space: string, conversation: string, id: string) => {
    const open = openSets.get(conversation) ?? new Set<string>()
    const changed = !open.has(id)
    open.add(id)
    openSets.set(conversation, open)
    return changed
  }),
  markClosed: vi.fn()
}))

import { buildMcpServerRecord, listToolsetStatuses, requestToolset } from '../../../../../src/main/services/agent/toolsets/broker'
import { TEAM_MCP_SERVER_NAME } from '../../../../../src/shared/apps/team-types'
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
    config.value = { optional: true }
    setOpen(['ai-browser'])
    const record = buildMcpServerRecord(scope)
    expect(record.capabilities).toBeDefined()
  })

  it('omits capabilities once every toolset is open', () => {
    setOpen(ALL)
    const record = buildMcpServerRecord(scope)
    expect(record.capabilities).toBeUndefined()
  })

  it('recreates the capabilities server on every build', () => {
    config.value = { optional: true }
    setOpen([])
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

describe('buildMcpServerRecord — core Halo API', () => {
  it('is available without a stored selection', () => {
    setOpen([])
    expect(buildMcpServerRecord(scope)['halo-api-ref']).toBeDefined()
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

describe('buildMcpServerRecord — Halo Team capability', () => {
  it('supplies collaboration without a context-loading switch', () => {
    setOpen([])
    expect(buildMcpServerRecord(scope)[TEAM_MCP_SERVER_NAME]).toBeDefined()
  })
})


describe('automatic Halo context capabilities', () => {
  const automatic = { ...scope, toolContextMode: 'automatic' as const }

  it('mounts core capabilities including Halo API independently of old switches', () => {
    setOpen([])
    const record = buildMcpServerRecord(automatic)
    expect(record['ai-browser']).toBeDefined()
    expect(record['ai-terminal']).toBeDefined()
    expect(record.ocr).toBeDefined()
    expect(record['halo-team']).toBeDefined()
    expect(record['halo-api-ref']).toBeDefined()
    const statuses = listToolsetStatuses(scope.spaceId, scope.conversationId, 'automatic')
    expect(statuses.filter(item => item.configurable !== false).map(item => item.id)).toEqual([])
    expect(statuses.find(item => item.id === 'ai-terminal')).toMatchObject({ open: true, configurable: false })
    expect(listToolsetStatuses(scope.spaceId, scope.conversationId, 'pending').find(item => item.id === 'ai-terminal'))
      .toMatchObject({ open: true, configurable: false })
    expect(listToolsetStatuses(scope.spaceId, scope.conversationId, 'manual').find(item => item.id === 'ai-terminal'))
      .toMatchObject({ open: true, configurable: false })
  })

  it('does not advertise a request tool for permanently available capabilities', () => {
    setOpen(['halo-api-ref'])
    const record = buildMcpServerRecord(automatic)
    expect(record['halo-api-ref']).toBeDefined()
    expect(record.capabilities).toBeUndefined()
  })

  it('does not ask a person to enable a capability already managed by the SDK', () => {
    setOpen([])
    expect(requestToolset(automatic, 'ai-terminal')).toMatchObject({ ok: true, alreadyOpen: true })
  })

  it('uses stable registry order independently of saved selections', () => {
    setOpen(['halo-api-ref', 'ai-terminal', 'ai-browser'])
    expect(Object.keys(buildMcpServerRecord(scope)).filter(id => ALL.includes(id)))
      .toEqual(ALL)
  })
})


it('prepares an image-required legacy capability in the same creation without scheduling another rebuild', () => {
  setOpen([])
  const record = buildMcpServerRecord({ ...scope, toolContextMode: 'manual', requiredToolsets: ['ocr'] })
  expect(record.ocr).toBeDefined()
  expect(openSets.get('conv-1')?.has('ocr')).toBe(true)
})

it('does not persist an automatic capability as an old manual selection', () => {
  setOpen([])
  buildMcpServerRecord({ ...scope, toolContextMode: 'automatic', requiredToolsets: ['ocr'] })
  expect(openSets.get('conv-1')?.size).toBe(0)
})

it('lets the AI activate an optional capability without asking a person', () => {
  config.value = { optional: true }
  setOpen([])
  expect(requestToolset(scope, 'optional-fixture').ok).toBe(true)
  expect(openSets.get('conv-1')?.has('optional-fixture')).toBe(true)
})
