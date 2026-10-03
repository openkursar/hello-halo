/**
 * The preview origin is served only for files inside a space, and never for
 * directories that hold the user's home, Halo data or app data; anything else
 * falls back to a sandboxed srcdoc under browser file rules.
 */

import { describe, it, expect, vi } from 'vitest'
import { homedir, tmpdir } from 'os'
import { mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<{ success: boolean; data?: unknown; error?: string }>>()
vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron').catch(() => ({}))
  return {
    ...actual,
    app: { isPackaged: true, getAppPath: () => join(homedir(), 'app'), getPath: (name: string) => (name === 'userData' ? join(homedir(), '.halo') : homedir()) },
    ipcMain: { handle: (channel: string, fn: never) => handlers.set(channel, fn), on: vi.fn() },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    net: { fetch: vi.fn() },
  }
})

const spaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'halo-canvas-space-')))
vi.mock('../../../src/main/services/space.service', () => ({ getAllSpacePaths: () => [spaceDir] }))

const { registerCanvasPreviewHandlers } = await import('../../../src/main/ipc/canvas-preview')
registerCanvasPreviewHandlers()
const open = (path: string) => handlers.get('canvas-preview:open')!({}, path)

describe('canvas-preview:open', () => {
  it('refuses a file directly in the home directory', async () => {
    const res = await open(join(homedir(), 'report.html'))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/preview site/)
  })

  it('refuses the filesystem root', async () => {
    expect((await open('/report.html')).success).toBe(false)
  })

  it('refuses a relative path', async () => {
    expect((await open('report.html')).success).toBe(false)
  })

  it('serves a file inside a space', async () => {
    writeFileSync(join(spaceDir, 'report.html'), '<p>')
    const res = await open(join(spaceDir, 'report.html'))
    expect(res.success).toBe(true)
  })

  it('refuses a file outside every space, such as a download', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'halo-canvas-downloads-')))
    writeFileSync(join(dir, 'report.html'), '<p>')
    const res = await open(join(dir, 'report.html'))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/preview site/)
  })
})
