import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ installDownloadHandler: vi.fn(), buildAllTools: vi.fn(() => []) }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ createSdkMcpServer: (options: unknown) => options }))
vi.mock('../../../../src/main/services/ai-browser/context', () => ({ browserContext: {} }))
vi.mock('../../../../src/main/services/ai-browser/tools', () => ({ buildAllTools: fixture.buildAllTools }))
vi.mock('../../../../src/main/services/ai-browser/download-handler', () => ({ installDownloadHandler: fixture.installDownloadHandler }))

import { createAIBrowserMcpServer } from '../../../../src/main/services/ai-browser/sdk-mcp-server'
import { AI_BROWSER_DESCRIPTION, AI_BROWSER_INSTRUCTIONS, AI_BROWSER_SYSTEM_PROMPT } from '../../../../src/main/services/ai-browser/guidance'

describe('browser service guidance', () => {
  it('shares capability metadata without opening a page or changing session setup', () => {
    const context = { workDir: '' }
    const server = createAIBrowserMcpServer(context as never, '/fixture')
    expect(server).toMatchObject({ name: 'ai-browser', description: AI_BROWSER_DESCRIPTION, instructions: AI_BROWSER_INSTRUCTIONS })
    expect(context.workDir).toBe('/fixture')
    expect(fixture.installDownloadHandler).toHaveBeenCalledOnce()
    expect(fixture.buildAllTools).toHaveBeenCalledWith(context)
  })

  it('keeps the resident hint short and orders page opening before snapshot and interaction', () => {
    expect(AI_BROWSER_SYSTEM_PROMPT.length).toBeLessThan(450)
    expect(AI_BROWSER_SYSTEM_PROMPT.indexOf('browser_navigate')).toBeLessThan(AI_BROWSER_SYSTEM_PROMPT.indexOf('browser_snapshot'))
    expect(AI_BROWSER_SYSTEM_PROMPT).toContain('select its existing tab')
    expect(AI_BROWSER_SYSTEM_PROMPT).toContain('fresh snapshot before using its UIDs')
    expect(AI_BROWSER_INSTRUCTIONS).toContain('Use only the latest snapshot')
    expect(AI_BROWSER_INSTRUCTIONS).toContain('screenshots for visual layout')
    expect(AI_BROWSER_INSTRUCTIONS).not.toContain('ToolSearch')
  })
})
