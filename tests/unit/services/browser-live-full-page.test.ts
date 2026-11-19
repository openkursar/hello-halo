import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  nativeImage: {
    createFromBitmap: vi.fn((buffer: Buffer, size: { width: number; height: number }) => ({
      buffer,
      size,
      toJPEG: () => Buffer.from('stitched'),
    })),
  },
}))
vi.mock('electron', () => ({ nativeImage: electron.nativeImage }))

import { captureFullPage } from '../../../src/main/services/browser-live/full-page'

/** A screen whose every byte is its index, so the stitched rows say which screen they came from. */
function screen(index: number, width: number, height: number): Electron.NativeImage {
  const image = (w: number, h: number): Electron.NativeImage => ({
    getSize: () => ({ width: w, height: h }),
    resize: ({ width: target }: { width: number }) => image(target, Math.round((h * target) / w)),
    toBitmap: () => Buffer.alloc(w * h * 4, index),
  } as unknown as Electron.NativeImage)
  return image(width, height)
}

function page(metrics: unknown, document = { viewport: 800, total: 2000 }) {
  const scripts: string[] = []
  let shown = 0
  const contents = {
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, [{ code }]: Array<{ code: string }>) => {
      scripts.push(code)
      if (code.startsWith('[innerWidth')) return metrics
      const top = Number(/top: (\d+)/.exec(code)?.[1])
      if (code.startsWith('new Promise')) return Math.min(top, document.total - document.viewport)
      return undefined
    }),
  }
  // Retina: twice the CSS width.
  const capture = vi.fn(async (): Promise<Electron.NativeImage | null> => screen(shown++, 2560, document.viewport * 2))
  return { contents: contents as never, scripts, capture }
}

describe('whole-page capture', () => {
  it('stitches the screens down the document and puts the page back', async () => {
    const { contents, scripts, capture } = page([1280, 800, 300, 2000])

    const result = await captureFullPage(contents, capture)

    // 1024 / 1280 = 0.8 image rows per CSS px; the last screen stops at 1200 and supplies its lower half.
    expect(scripts.filter(s => s.startsWith('new Promise')).map(s => /top: (\d+)/.exec(s)?.[1])).toEqual(['0', '800', '1600'])
    const [buffer, size] = electron.nativeImage.createFromBitmap.mock.calls[0]
    expect(size).toEqual({ width: 1024, height: 1600 })
    const row = 1024 * 4
    expect([buffer[0], buffer[640 * row], buffer[1280 * row], buffer.length]).toEqual([0, 1, 2, 1600 * row])
    expect(scripts.at(-1)).toBe("scrollTo({ top: 300, behavior: 'instant' })")
    expect(result).toEqual({ image: `data:image/jpeg;base64,${Buffer.from('stitched').toString('base64')}`, width: 1024, height: 1600, covered: 2000, total: 2000 })
  })

  it('stops at the height cap', async () => {
    const { contents, capture } = page([1280, 800, 0, 20_000], { viewport: 800, total: 20_000 })
    const result = await captureFullPage(contents, capture)
    expect(result).toMatchObject({ height: 9600, covered: 12_000, total: 20_000 })
    expect(capture).toHaveBeenCalledTimes(15)
  })

  it('gives up on a page that does not answer, and still puts it back', async () => {
    const { contents, scripts, capture } = page([1280, 800, 300, 2000])
    capture.mockResolvedValueOnce(null)
    await expect(captureFullPage(contents, capture)).rejects.toThrow('no frame')
    expect(scripts.at(-1)).toBe("scrollTo({ top: 300, behavior: 'instant' })")

    await expect(captureFullPage(page(null).contents, capture)).rejects.toThrow('did not report its size')
  })
})
