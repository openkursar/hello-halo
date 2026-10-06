/**
 * Outside the desktop window a download first asks the Halo server for a
 * ticket, then hands over a link that carries only that ticket: the access
 * token never reaches the browser's download list or the phone's browser. The
 * link points at the server itself, since the mobile app's page is local to the
 * phone and a reverse proxy may serve Halo under a path prefix. A refused
 * ticket opens nothing, so no error page can replace the app.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactApi } from '../../../src/renderer/api/artifact.api'
import { clearServerUrl, setServerUrl } from '../../../src/renderer/api/transport'

const TICKET = 'Tk_-'.repeat(10) + 'abc'
const FILE = '/Users/me/space/报告 v2.docx'
const installed = new Set<string>()

function setGlobal(key: string, value: unknown): void {
  installed.add(key)
  ;(globalThis as Record<string, unknown>)[key] = value
}

afterEach(() => {
  for (const key of installed) delete (globalThis as Record<string, unknown>)[key]
  installed.clear()
  clearServerUrl()
  vi.restoreAllMocks()
})

interface Page {
  clicked: Array<{ href: string; download: string }>
  requests: Array<{ url: string; method?: string; authorization?: string; body?: unknown }>
}

function installPage(baseURI: string, window: Record<string, unknown>, reply: { status: number; body: unknown }): Page {
  const page: Page = { clicked: [], requests: [] }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setGlobal('window', window)
  setGlobal('localStorage', { getItem: () => 'tok' })
  setGlobal('fetch', async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    page.requests.push({ url, method: init.method, authorization: init.headers?.Authorization, body: init.body && JSON.parse(init.body) })
    return { status: reply.status, ok: reply.status < 400, json: async () => reply.body }
  })
  setGlobal('document', {
    baseURI,
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => {
      const link = { href: '', download: '', click: () => page.clicked.push({ href: link.href, download: link.download }) }
      return link
    },
  })
  return page
}

const issued = { status: 200, body: { success: true, data: { ticket: TICKET } } }

describe('artifact downloads outside the desktop window', () => {
  it('download from the remote page through a ticket link under its path prefix', async () => {
    const page = installPage('https://host.example.com/fc-xxx/', {}, issued)

    expect(await artifactApi.downloadArtifact(FILE)).toEqual({ success: true })
    expect(page.requests).toEqual([{
      url: 'https://host.example.com/fc-xxx/api/artifacts/download-ticket',
      method: 'POST',
      authorization: 'Bearer tok',
      body: { path: FILE },
    }])
    expect(page.clicked).toEqual([{ href: `https://host.example.com/fc-xxx/api/artifacts/file/${TICKET}`, download: '报告 v2.docx' }])
  })

  it('hand the mobile app\'s download to the system as a ticket link on the Halo computer', async () => {
    const open = vi.fn()
    const page = installPage('http://localhost/', { Capacitor: { isNativePlatform: () => true }, open }, issued)
    setServerUrl('http://halo-pc.local:3456/')

    expect(await artifactApi.downloadArtifact(FILE)).toEqual({ success: true })
    expect(page.requests[0].url).toBe('http://halo-pc.local:3456/api/artifacts/download-ticket')
    expect(open).toHaveBeenCalledWith(`http://halo-pc.local:3456/api/artifacts/file/${TICKET}`, '_blank')
    expect(open.mock.calls[0][0]).not.toMatch(/token/)
    expect(page.clicked).toEqual([])
  })

  it('open nothing when the server refuses the ticket', async () => {
    const open = vi.fn()
    const page = installPage('http://localhost/', { Capacitor: { isNativePlatform: () => true }, open }, {
      status: 404,
      body: { success: false, error: 'File not found' },
    })
    setServerUrl('http://halo-pc.local:3456/')

    expect(await artifactApi.downloadArtifact(FILE)).toEqual({ success: false, error: 'File not found' })
    expect(open).not.toHaveBeenCalled()
    expect(page.clicked).toEqual([])
  })

  it('keep the image viewer\'s in-page source on the Halo computer', () => {
    installPage('http://localhost/', { Capacitor: { isNativePlatform: () => true } }, issued)
    setServerUrl('http://halo-pc.local:3456/')
    expect(artifactApi.getArtifactDownloadUrl(FILE)).toBe(
      `http://halo-pc.local:3456/api/artifacts/download?path=${encodeURIComponent(FILE)}&token=tok`,
    )
  })
})
