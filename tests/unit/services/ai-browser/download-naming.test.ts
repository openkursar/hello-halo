import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  nativeImage: {},
  clipboard: {},
}))
vi.mock('../../../../src/main/services/browser-host/manager', () => ({
  browserHostManager: {},
}))
vi.mock('../../../../src/main/services/browser-view.service', () => ({
  browserViewManager: {
    getAllStates: () => [],
    getState: () => null,
    getWebContents: () => null,
    onViewDestroyed: () => () => {},
  },
}))
vi.mock('../../../../src/main/services/ai-browser/download-handler', () => ({
  registerWebContentsForDownload: vi.fn(),
  unregisterWebContentsForDownload: vi.fn(),
}))
vi.mock('../../../../src/main/services/ai-browser/sdk-mcp-server', () => ({
  createAIBrowserMcpServer: vi.fn(),
}))

const { createScopedBrowserContext } = await import('../../../../src/main/services/ai-browser')

describe('a downloaded file is never saved under an engine instruction file name', () => {
  let workDir = ''

  const savedName = (suggested: string) => {
    const context = createScopedBrowserContext()
    context.workDir = workDir
    const { resolvedPath } = context.registerDownload('https://example.test/f', suggested, 1, 'text/plain')
    const info = context.getDownloads().find(d => d.savePath === resolvedPath)
    // What the model is told is the name the file was actually saved under.
    expect(info?.filename).toBe(basename(resolvedPath))
    return basename(resolvedPath)
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'download-naming-'))
  })

  afterEach(() => rmSync(workDir, { recursive: true, force: true }))

  it('renames a file whose name an engine reads as its own', () => {
    expect(savedName('CLAUDE.md')).toBe('CLAUDE (downloaded).md')
    expect(savedName('agents.MD')).toBe('agents (downloaded).MD')
    expect(savedName('CLAUDE.md.')).toBe('CLAUDE (downloaded).md')
    expect(savedName('AGENTS.override.md')).toBe('AGENTS.override (downloaded).md')
    expect(savedName('CLAUDE.local.md ')).toBe('CLAUDE.local (downloaded).md')
  })

  it('keeps an ordinary name as it was', () => {
    expect(savedName('report.pdf')).toBe('report.pdf')
    expect(savedName('CLAUDE.md.txt')).toBe('CLAUDE.md.txt')
    expect(savedName('my-agents.md')).toBe('my-agents.md')
  })

  it('still avoids overwriting an earlier download of the same name', () => {
    mkdirSync(join(workDir, 'downloads'))
    writeFileSync(join(workDir, 'downloads', 'CLAUDE (downloaded).md'), '')
    expect(savedName('CLAUDE.md')).toBe('CLAUDE (downloaded) (1).md')
  })
})
