/**
 * A tool result whose images were saved as files: the desktop app shows the
 * image from its file; remote web and mobile show one line naming it and its
 * size. Other outputs, older base64 ones included, render as before.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolResultViewer } from '../../../src/renderer/components/chat/tool-result/ToolResultViewer'
import '../../../src/renderer/i18n'

const saved = JSON.stringify([{ type: 'image_file', path: '/data/space/conv.images/0123456789abcdef.png', media_type: 'image/png', bytes: 1536 }])

function render(output: string, toolInput?: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(ToolResultViewer, { toolName: 'Read', toolInput, output }))
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('tool result images', () => {
  it('shows the saved image from its file on the desktop', () => {
    (globalThis as { window?: unknown }).window = { halo: {} }
    const html = render(saved, { file_path: '/Users/me/shot.png' })
    expect(html).toContain('data-testid="tool-result-images"')
    expect(html).toContain('src="halo-file:///data/space/conv.images/0123456789abcdef.png"')
    expect(html).not.toContain('image_file')
  })

  it('names the image and its size on one line where files cannot be read', () => {
    const html = render(saved, { file_path: '/Users/me/shot.png' })
    expect(html).toContain('shot.png')
    expect(html).toContain('1.5 KB')
    expect(html).not.toContain('<img')
  })

  it('keeps the text of a result that has a caption', () => {
    const html = render(JSON.stringify([{ type: 'text', text: 'Page captured' }, JSON.parse(saved)[0]]))
    expect(html).toContain('Page captured')
  })

  it('keeps text and images in the order the tool returned them', () => {
    (globalThis as { window?: unknown }).window = { halo: {} }
    const image = (hash: string) => ({ type: 'image_file', path: `/data/space/conv.images/${hash}.png`, media_type: 'image/png', bytes: 10 })
    const html = render(JSON.stringify([
      { type: 'text', text: 'Caption A' }, image('aaaaaaaaaaaaaaaa'),
      { type: 'text', text: 'Caption B' }, image('bbbbbbbbbbbbbbbb'),
    ]))
    const order = ['Caption A', 'aaaaaaaaaaaaaaaa', 'Caption B', 'bbbbbbbbbbbbbbbb'].map(marker => html.indexOf(marker))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('reads as text a reference outside the folders Halo saves images in', () => {
    const elsewhere = JSON.stringify([{ type: 'image_file', path: '/Users/me/0123456789abcdef.png', media_type: 'image/png', bytes: 10 }])
    const html = render(elsewhere)
    expect(html).not.toContain('data-testid="tool-result-images"')
  })

  it('renders an older base64 output as it always did', () => {
    const old = JSON.stringify([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }])
    const html = render(old)
    expect(html).not.toContain('data-testid="tool-result-images"')
    expect(html).toContain('aGVsbG8=')
  })
})
