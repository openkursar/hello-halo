/**
 * Unit Tests: services/agent — MCP Manager
 *
 * Tests the groupToolsByMcpServer helper that parses flat SDK tool names
 * into per-server groups.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock heavy dependencies that mcp-manager.ts imports transitively
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => ({})),
  getTempSpacePath: vi.fn(() => '/tmp')
}))
vi.mock('../../../src/main/openai-compat-router', () => ({
  ensureOpenAICompatRouter: vi.fn(),
  encodeBackendConfig: vi.fn()
}))
vi.mock('../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: vi.fn(),
  getApiCredentials: vi.fn(),
  getEnabledMcpServers: vi.fn(),
  getDbMcpServers: vi.fn(),
  inferOpenAIWireApi: vi.fn(),
  credentialsToBackendConfig: vi.fn()
}))
vi.mock('../../../src/main/services/agent/events', () => ({
  emitAgentBroadcast: vi.fn()
}))
vi.mock('../../../src/main/services/agent/sdk-config', () => ({
  getCleanUserEnv: vi.fn(() => ({}))
}))

import { groupToolsByMcpServer } from '../../../src/main/services/agent/mcp-manager'

describe('groupToolsByMcpServer', () => {
  it('groups MCP tools by server name', () => {
    const tools = [
      'Read', 'Write', 'Edit', // built-in, no prefix
      'mcp__web-search__web_search',
      'mcp__web-search__news_search',
      'mcp__halo-apps__create_automation_app',
      'mcp__halo-apps__list_automation_apps',
    ]
    const grouped = groupToolsByMcpServer(tools)
    expect(grouped).toEqual({
      'web-search': ['web_search', 'news_search'],
      'halo-apps': ['create_automation_app', 'list_automation_apps'],
    })
  })

  it('handles single-tool servers', () => {
    const grouped = groupToolsByMcpServer(['mcp__my-server__do_stuff'])
    expect(grouped).toEqual({
      'my-server': ['do_stuff'],
    })
  })

  it('ignores built-in tools without mcp__ prefix', () => {
    const grouped = groupToolsByMcpServer(['Read', 'Write', 'Bash', 'Glob', 'Grep'])
    expect(grouped).toEqual({})
  })

  it('ignores malformed tool names', () => {
    const grouped = groupToolsByMcpServer([
      'mcp__',            // no server or tool
      'mcp__server',      // no tool separator
      'mcp____bad',       // empty server name (sepIdx is 0)
      'mcp__server__',    // empty tool name
    ])
    expect(grouped).toEqual({})
  })

  it('returns empty record for empty input', () => {
    expect(groupToolsByMcpServer([])).toEqual({})
  })

  it('preserves tool names with underscores', () => {
    const grouped = groupToolsByMcpServer([
      'mcp__ai-browser__browser_navigate_to',
      'mcp__ai-browser__browser_take_screenshot',
    ])
    expect(grouped).toEqual({
      'ai-browser': ['browser_navigate_to', 'browser_take_screenshot'],
    })
  })
})
