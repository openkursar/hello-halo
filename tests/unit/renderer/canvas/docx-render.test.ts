/**
 * Every blob: URL docx-preview creates for a document is revoked when the
 * viewer lets go of it — including when it lets go mid-render.
 */

import { describe, it, expect, vi } from 'vitest'

let resolveParse: (doc: unknown) => void = () => {}
let resolveRender: (nodes: unknown[]) => void = () => {}
let renderCalls = 0

vi.mock('docx-preview', () => ({
  parseAsync: () => new Promise(r => { resolveParse = r }),
  renderDocument: () => {
    renderCalls++
    return new Promise(r => { resolveRender = r })
  },
}))

const { renderDocx } = await import('../../../../src/renderer/components/canvas/viewers/docx-render')

function fakeContainer() {
  const children: unknown[] = []
  return { innerHTML: 'old', children, appendChild: (n: unknown) => { children.push(n) } }
}
const fakeDoc = () => ({ disposeUrls: vi.fn() })
const flush = () => new Promise(r => setTimeout(r, 0))

describe('renderDocx', () => {
  it('fills the container, then revokes the document URLs on dispose', async () => {
    const container = fakeContainer()
    const doc = fakeDoc()
    const render = renderDocx(new Uint8Array(), container as never, {})
    resolveParse(doc)
    await flush()
    resolveRender(['page'])
    await render.done
    expect(container.children).toEqual(['page'])

    render.dispose()
    expect(doc.disposeUrls).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
  })

  it('releases a document that finishes parsing after dispose, without rendering it', async () => {
    renderCalls = 0
    const doc = fakeDoc()
    const render = renderDocx(new Uint8Array(), fakeContainer() as never, {})
    render.dispose()
    resolveParse(doc)
    await render.done
    expect(doc.disposeUrls).toHaveBeenCalledTimes(1)
    expect(renderCalls).toBe(0)
  })

  it('does not attach a render that finishes after dispose', async () => {
    const container = fakeContainer()
    const doc = fakeDoc()
    const render = renderDocx(new Uint8Array(), container as never, {})
    resolveParse(doc)
    await flush()
    render.dispose()
    resolveRender(['late page'])
    await render.done
    expect(container.children).toEqual([])
    expect(doc.disposeUrls).toHaveBeenCalledTimes(1)
  })

  it('still unmounts cleanly when the installed library lacks the URL-tracking patch', async () => {
    const container = fakeContainer()
    const render = renderDocx(new Uint8Array(), container as never, {})
    resolveParse({})
    await flush()
    resolveRender(['page'])
    await render.done
    expect(() => render.dispose()).not.toThrow()
    expect(container.innerHTML).toBe('')

    const early = renderDocx(new Uint8Array(), fakeContainer() as never, {})
    early.dispose()
    resolveParse({})
    await expect(early.done).resolves.toBeUndefined()
  })
})
