/**
 * The toolset broker persists a global "last-used" selection so a new
 * conversation inherits the previous window's enabled toolsets (the toolset
 * analog of the global model selection). These tests pin the two invariants:
 *  - only a USER toggle updates the global last-used (an AI request never opens
 *    a toolset, and a restore must not rewrite the seed);
 *  - the persisted value is the conversation's full open-set after the change.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { saveConfig, openSet } = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  openSet: new Set<string>()
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => ({})),
  saveConfig
}))

vi.mock('../../../../src/main/services/agent/events', () => ({
  emitAgentEvent: vi.fn()
}))

// Heavy always-on server factories are only touched by buildMcpServerRecord,
// not the open/close path — stub them so the module imports cleanly.
vi.mock('../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: vi.fn(() => ({}))
}))
vi.mock('../../../../src/main/services/app-bridge', () => ({
  createHaloAppsMcpServer: vi.fn(() => ({}))
}))
vi.mock('../../../../src/main/services/agent/toolsets/meta-server', () => ({
  createBrokerMetaServer: vi.fn(() => ({})),
  CAPABILITIES_SERVER_NAME: 'capabilities'
}))

vi.mock('../../../../src/main/services/agent/toolsets/registry', () => ({
  getToolset: vi.fn((id: string) => (id === 'ai-browser' || id === 'ai-terminal' ? { id } : undefined)),
  getAvailableToolsets: vi.fn(() => [{ id: 'ai-browser' }, { id: 'ai-terminal' }])
}))

// In-memory open-set (hoisted) standing in for the persisted per-conversation state.
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({
  getOpenToolsets: vi.fn(() => openSet),
  markOpen: vi.fn((_s: string, _c: string, id: string) => (openSet.has(id) ? false : (openSet.add(id), true))),
  markClosed: vi.fn((_s: string, _c: string, id: string) => (openSet.has(id) ? (openSet.delete(id), true) : false)),
  getServerCache: vi.fn(() => new Map())
}))

import { openToolset, closeToolset } from '../../../../src/main/services/agent/toolsets/broker'
import type { ToolsetScope } from '../../../../src/main/services/agent/toolsets/types'

const scope: ToolsetScope = { spaceId: 'space-1', conversationId: 'conv-1', workDir: '/tmp' }

beforeEach(() => {
  openSet.clear()
  saveConfig.mockClear()
})

describe('toolset broker — global last-used selection', () => {
  it('persists the full open-set as lastToolsets on a user open', () => {
    openToolset(scope, 'ai-browser', 'user')
    expect(saveConfig).toHaveBeenCalledWith({ lastToolsets: ['ai-browser'] })

    openToolset(scope, 'ai-terminal', 'user')
    expect(saveConfig).toHaveBeenLastCalledWith({ lastToolsets: ['ai-browser', 'ai-terminal'] })
  })

  it('persists the shrunk open-set on a user close', () => {
    openToolset(scope, 'ai-browser', 'user')
    openToolset(scope, 'ai-terminal', 'user')
    saveConfig.mockClear()

    closeToolset(scope, 'ai-terminal', 'user')
    expect(saveConfig).toHaveBeenCalledWith({ lastToolsets: ['ai-browser'] })
  })

  it('does not rewrite the last-used seed for non-user openers', () => {
    openToolset(scope, 'ai-browser', 'ai')
    openToolset(scope, 'ai-terminal', 'restore')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('does not persist when the toggle is a no-op (already in the target state)', () => {
    openToolset(scope, 'ai-browser', 'user')
    saveConfig.mockClear()

    // Already open — markOpen returns false, so no rebuild and no persist.
    openToolset(scope, 'ai-browser', 'user')
    // Never opened — markClosed returns false.
    closeToolset(scope, 'ai-terminal', 'user')
    expect(saveConfig).not.toHaveBeenCalled()
  })
})
