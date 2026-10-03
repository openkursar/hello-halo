/**
 * The HTML preview runs in an opaque-origin sandbox, so relative URLs only
 * resolve next to the file because the preview document gets a base element.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildHtmlPreviewDocument, haloFileDirectoryUrl, openIsolatedPreview } from '../../../../src/renderer/components/canvas/viewers/html-preview'
import { countLines } from '../../../../src/renderer/components/canvas/viewers/count-lines'

const BASE = '<base href="halo-file:///Users/me/site/">'

describe('haloFileDirectoryUrl', () => {
  it('points at the containing directory with a trailing slash', () => {
    expect(haloFileDirectoryUrl('/Users/me/site/index.html')).toBe('halo-file:///Users/me/site/')
  })

  it('percent-encodes each segment so quotes and spaces cannot break the attribute', () => {
    expect(haloFileDirectoryUrl('/Users/me/my "site"&co/a.html')).toBe(
      'halo-file:///Users/me/my%20%22site%22%26co/'
    )
  })

  it('turns a Windows path into a forward-slash URL', () => {
    expect(haloFileDirectoryUrl('C:\\Users\\me\\site\\index.html')).toBe('halo-file:///C%3A/Users/me/site/')
  })

  it('has no directory for a bare file name', () => {
    expect(haloFileDirectoryUrl('index.html')).toBeNull()
  })
})

describe('buildHtmlPreviewDocument', () => {
  const path = '/Users/me/site/index.html'

  it('inserts the base first inside head', () => {
    const doc = '<!DOCTYPE html><html><head><link rel="stylesheet" href="a.css"></head><body></body></html>'
    expect(buildHtmlPreviewDocument(doc, path)).toBe(
      `<!DOCTYPE html><html><head>${BASE}<link rel="stylesheet" href="a.css"></head><body></body></html>`
    )
  })

  it('does not mistake <header> for <head>', () => {
    const doc = '<html><body><header>x</header></body></html>'
    expect(buildHtmlPreviewDocument(doc, path)).toBe(`<html>${BASE}<body><header>x</header></body></html>`)
  })

  it('handles a head with attributes', () => {
    expect(buildHtmlPreviewDocument('<HEAD lang="en"><title>t</title>', path)).toBe(
      `<HEAD lang="en">${BASE}<title>t</title>`
    )
  })

  it('keeps the doctype first when there is no html or head element', () => {
    expect(buildHtmlPreviewDocument('<!doctype html>\n<img src="a.png">', path)).toBe(
      `<!doctype html>${BASE}\n<img src="a.png">`
    )
  })

  it('prepends to a bare fragment', () => {
    expect(buildHtmlPreviewDocument('<img src="a.png">', path)).toBe(`${BASE}<img src="a.png">`)
  })

  it("respects the author's own base href", () => {
    const doc = '<html><head><base href="https://cdn.example/"></head></html>'
    expect(buildHtmlPreviewDocument(doc, path)).toBe(doc)
  })

  it('still adds an href when the author base only sets a target', () => {
    const doc = '<html><head><base target="_blank"></head></html>'
    expect(buildHtmlPreviewDocument(doc, path)).toBe(`<html><head>${BASE}<base target="_blank"></head></html>`)
  })

  it('leaves content without a local file untouched', () => {
    expect(buildHtmlPreviewDocument('<p>x</p>', undefined)).toBe('<p>x</p>')
  })
})

describe('countLines', () => {
  it('counts like split', () => {
    for (const s of ['', 'a', 'a\n', 'a\nb', '\n\n\n']) expect(countLines(s)).toBe(s.split('\n').length)
  })
})

describe('openIsolatedPreview', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('returns the origin when the main process grants one', async () => {
    const data = { url: 'halo-preview://h/a.html', host: 'h' }
    expect(await openIsolatedPreview(async () => ({ success: true, data }), '/w/a.html')).toEqual(data)
  })

  it.each([
    ['refuses', async () => ({ success: false, error: 'too broad' })],
    ['rejects', async () => { throw new Error('ipc gone') }],
    ['throws synchronously', () => { throw new Error('no bridge') }],
    ['answers nothing', async () => undefined as never],
  ])('falls back (null) when the request %s', async (_label, open) => {
    const spy = quiet()
    expect(await openIsolatedPreview(open as never, '/w/a.html')).toBeNull()
    spy.mockRestore()
  })
})
