/**
 * The mobile app shows artifact images straight from the Halo computer, which
 * a LAN serves over plain http. Its build lets images (and only images) load
 * over http; the desktop window and the remote web page keep the shared policy.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { allowHttpImages } from '../../../vite.config.mobile'

const page = readFileSync(join(__dirname, '../../../src/renderer/index.html'), 'utf-8')

function directives(html: string): Record<string, string> {
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? ''
  const entries = policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d])
  return Object.fromEntries(entries)
}

describe('mobile page policy', () => {
  it('adds plain-http images to the shared policy and nothing else', () => {
    const transform = allowHttpImages.transformIndexHtml as (html: string) => string
    const shared = directives(page)
    const mobile = directives(transform(page))

    expect(shared['img-src']).toMatch(/^img-src 'self'/)
    expect(shared['img-src']).not.toMatch(/\shttp:/)
    expect(mobile['img-src']).toBe(`${shared['img-src']} http:`)
    expect({ ...mobile, 'img-src': shared['img-src'] }).toEqual(shared)
  })
})
