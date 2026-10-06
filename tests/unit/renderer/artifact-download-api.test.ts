/**
 * Outside the desktop window, artifact downloads and image previews point at
 * the Halo server itself: the mobile app's page is local to the phone, and a
 * reverse proxy may serve Halo under a path prefix. In the app the download is
 * handed to the system, since its web view cannot save a file from a link.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactApi } from '../../../src/renderer/api/artifact.api'
import { clearServerUrl, setServerUrl } from '../../../src/renderer/api/transport'

const installed = new Set<string>()

function setGlobal(key: string, value: unknown): void {
  installed.add(key)
  ;(globalThis as Record<string, unknown>)[key] = value
}

afterEach(() => {
  for (const key of installed) delete (globalThis as Record<string, unknown>)[key]
  installed.clear()
  clearServerUrl()
})

function installPage(baseURI: string, window: Record<string, unknown>): Array<{ href: string; download: string }> {
  const clicked: Array<{ href: string; download: string }> = []
  setGlobal('window', window)
  setGlobal('localStorage', { getItem: () => 'tok' })
  setGlobal('document', {
    baseURI,
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => {
      const link = { href: '', download: '', click: () => clicked.push({ href: link.href, download: link.download }) }
      return link
    },
  })
  return clicked
}

const FILE = '/Users/me/space/报告 v2.docx'
const QUERY = `path=${encodeURIComponent(FILE)}&token=tok`

describe('artifact downloads outside the desktop window', () => {
  it('keep the reverse-proxy prefix the remote page is served under', () => {
    const clicked = installPage('https://host.example.com/fc-xxx/', {})
    const url = `https://host.example.com/fc-xxx/api/artifacts/download?${QUERY}`

    expect(artifactApi.getArtifactDownloadUrl(FILE)).toBe(url)
    artifactApi.downloadArtifact(FILE)
    expect(clicked).toEqual([{ href: url, download: '报告 v2.docx' }])
  })

  it('point the mobile app at the Halo computer and hand the download to the system', () => {
    const open = vi.fn()
    const clicked = installPage('http://localhost/', { Capacitor: { isNativePlatform: () => true }, open })
    setServerUrl('http://halo-pc.local:3456/')
    const url = `http://halo-pc.local:3456/api/artifacts/download?${QUERY}`

    // The image viewer's source in the app
    expect(artifactApi.getArtifactDownloadUrl(FILE)).toBe(url)
    artifactApi.downloadArtifact(FILE)
    expect(open).toHaveBeenCalledWith(url, '_blank')
    expect(clicked).toEqual([])
  })
})
