/**
 * halo-file:// serves local files as subresources only: a document loaded
 * through it is sandboxed and scriptless, so it cannot read other local files.
 */

import { describe, it, expect } from 'vitest'
import { haloFileUrlToPath, withInertDocumentPolicy } from '../../../src/main/foundation/protocol.service'

describe('halo-file responses', () => {
  it('carry a sandbox policy while keeping status, headers and body', async () => {
    const original = new Response('body', { status: 200, headers: { 'Content-Type': 'text/html' } })
    const res = withInertDocumentPolicy(original)
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(res.headers.get('Content-Type')).toBe('text/html')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('body')
  })
})

describe('haloFileUrlToPath', () => {
  it('decodes the path and drops the cache-buster', () => {
    expect(haloFileUrlToPath('halo-file:///Users/me/a%20b.png?v=3#x')).toBe('/Users/me/a b.png')
  })

  it('round-trips the directory URL the HTML preview uses as its base', () => {
    expect(haloFileUrlToPath('halo-file:///C%3A/Users/me/site/img.png')).toBe('/C:/Users/me/site/img.png')
  })
})
