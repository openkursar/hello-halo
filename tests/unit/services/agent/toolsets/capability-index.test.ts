import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ open: new Set<string>(), terminalAvailable: true }))
vi.mock('../../../../../src/main/services/agent/toolsets/state', () => ({ getOpenToolsets: () => state.open }))
vi.mock('../../../../../src/main/services/ai-browser', () => ({
  AI_BROWSER_SYSTEM_PROMPT: 'Browser service guide.', createAIBrowserMcpServer: vi.fn(), getInteractiveBrowserContext: vi.fn(),
}))
vi.mock('../../../../../src/main/services/ai-terminal', () => ({
  AI_TERMINAL_SYSTEM_PROMPT: 'Terminal service guide.', createTerminalMcpServer: vi.fn(), getGlobalTerminalContext: vi.fn(),
  isTerminalAvailable: () => state.terminalAvailable,
}))
vi.mock('../../../../../src/main/services/ocr', () => ({ createOcrMcpServer: vi.fn() }))
vi.mock('../../../../../src/main/services/api-ref', () => ({
  HALO_API_TOOLSET_ID: 'halo-api-ref', HALO_API_USAGE_GUIDE: 'Core Halo API guide.', createApiRefMcpServer: vi.fn(),
}))

import { buildToolsetSection } from '../../../../../src/main/services/agent/toolsets/capability-index'
import { getToolset, registerToolset } from '../../../../../src/main/services/agent/toolsets/registry'

registerToolset({ id: 'halo-team', displayName: 'Team Collaboration', summary: 'Team work',
  usageGuide: 'Team service guide.', contextManaged: true, isAvailable: () => true, createServer: vi.fn() })

beforeEach(() => { state.open = new Set(); state.terminalAvailable = true })

describe('captured toolset guide mode', () => {
  it('uses the real registry classification and provides fixed guidance against obsolete context switches', () => {
    for (const id of ['ai-browser', 'ai-terminal', 'ocr', 'halo-team', 'halo-api-ref']) expect(getToolset(id)?.contextManaged).toBe(true)
    expect(getToolset('halo-api-ref')?.contextManaged).toBe(true)
    const guide = buildToolsetSection('space', 'conversation', 'automatic')
    expect(guide).toContain('supplied automatically')
    expect(guide).toContain('Do not ask the user to enable capability switches')
    expect(guide).toContain('even if an older Halo guide describes them')
    expect(guide).toContain('Use the tools exposed in this session')
    expect(guide).toContain('Explicit tool restrictions, connection settings and caller-specific execution policies')
    expect(guide).toContain('Operate Halo is a core capability')
    expect(guide).toContain('Browser service guide.')
    expect(guide).toContain('Terminal service guide.')
    expect(guide).toContain('ocr_image')
    expect(guide).toContain('Team service guide.')
    expect(guide).toContain('Core Halo API guide.')
  })

  it('keeps the mode instruction stable, single and independent of old context selections', () => {
    const initial = buildToolsetSection('space', 'conversation', 'automatic')
    expect(initial.match(/# Capability availability in this conversation/g)).toHaveLength(1)
    state.open = new Set(['ai-browser', 'ai-terminal', 'ocr', 'halo-team', 'halo-api-ref'])
    expect(buildToolsetSection('space', 'conversation', 'automatic')).toBe(initial)
    expect(buildToolsetSection('space', 'another', 'automatic')).toBe(initial)
  })

  it('respects platform availability while keeping Halo API resident', () => {
    state.terminalAvailable = false
    state.open = new Set(['halo-api-ref'])
    const guide = buildToolsetSection('space', 'conversation', 'automatic')
    expect(guide).not.toContain('Terminal service guide.')
    expect(guide).toContain('Core Halo API guide.')
    expect(guide).toContain('Supported browser, terminal, OCR and collaboration capabilities')
  })

  it('supplies the same core guidance to legacy and other engines', () => {
    const current = buildToolsetSection('space', 'conversation', 'automatic')
    expect(buildToolsetSection('space', 'conversation', 'manual')).toBe(current)
    state.open = new Set(['halo-api-ref', 'ai-browser'])
    expect(buildToolsetSection('space', 'conversation')).toBe(current)
  })
})
