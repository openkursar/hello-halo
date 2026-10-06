/**
 * A remote client streams one file into a space and learns where it landed, or
 * why it did not: a file refused as too large comes back as TOO_LARGE even
 * when the refusal is a page from a proxy or tunnel in front of Halo, so the
 * composer can name the limit instead of a bare failure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactApi } from '../../../src/renderer/api/artifact.api'

const installed = new Set<string>()

function setGlobal(key: string, value: unknown): void {
  installed.add(key)
  ;(globalThis as Record<string, unknown>)[key] = value
}

afterEach(() => {
  for (const key of installed) delete (globalThis as Record<string, unknown>)[key]
  installed.clear()
  vi.restoreAllMocks()
})

/** A remote page whose server answers every request with `status` and `body` (a string is a non-JSON page). */
function serve(status: number, body: unknown): Array<{ url: string; init: RequestInit }> {
  const requests: Array<{ url: string; init: RequestInit }> = []
  setGlobal('window', {})
  setGlobal('localStorage', { getItem: () => 'tok' })
  setGlobal('document', { baseURI: 'https://halo.example.com/' })
  setGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return {
      status,
      ok: status < 400,
      json: async () => {
        if (typeof body === 'string') throw new SyntaxError('Unexpected token < in JSON')
        return body
      },
    }
  })
  return requests
}

const FILE = { name: '会议录音.m4a', size: 10 } as File

describe('uploading a file from a remote client', () => {
  it('streams the file itself to the space with the token, and returns where it landed', async () => {
    const landed = { path: '/srv/space/会议录音.m4a', name: '会议录音.m4a', size: 10 }
    const requests = serve(200, { success: true, data: landed })
    expect(await artifactApi.uploadArtifactFile('space 1', FILE)).toEqual({ success: true, data: landed })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(`https://halo.example.com/api/spaces/space%201/artifacts/upload?name=${encodeURIComponent('会议录音.m4a')}`)
    expect(requests[0].init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer tok' } })
    expect(requests[0].init.body).toBe(FILE)
  })

  it('reports a file Halo refuses as too large as TOO_LARGE', async () => {
    serve(413, { success: false, error: 'File too large', code: 'TOO_LARGE' })
    expect(await artifactApi.uploadArtifactFile('s', FILE)).toEqual({ success: false, error: 'File too large', code: 'TOO_LARGE' })
  })

  it('reports a tunnel\'s own 413 page as TOO_LARGE as well', async () => {
    serve(413, '<html><body>413 Request Entity Too Large</body></html>')
    expect(await artifactApi.uploadArtifactFile('s', FILE)).toEqual({ success: false, error: 'Upload failed (413)', code: 'TOO_LARGE' })
  })

  it('passes any other refusal on as it came', async () => {
    serve(409, { success: false, error: 'The working directory of this space is not available', code: 'NO_WORKING_DIR' })
    expect(await artifactApi.uploadArtifactFile('s', FILE)).toEqual({
      success: false,
      error: 'The working directory of this space is not available',
      code: 'NO_WORKING_DIR',
    })
    serve(502, '<html><body>Bad gateway</body></html>')
    expect(await artifactApi.uploadArtifactFile('s', FILE)).toEqual({ success: false, error: 'Upload failed (502)' })
  })
})
