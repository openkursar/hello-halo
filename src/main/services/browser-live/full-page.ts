import { nativeImage, type NativeImage, type WebContents } from 'electron'
import { readPageMetrics, runPageScript } from './page-script'

const PAGE_WIDTH = 1024
const PAGE_QUALITY = 60
/** In CSS pixels. A page that long is better reached by dragging the scrollbar. */
const MAX_PAGE_HEIGHT = 12_000

export interface FullPageImage {
  image: string
  width: number
  height: number
  /** Captured document height, in CSS pixels. */
  covered: number
  total: number
}

/** Resolves with where the page landed once that position has been painted. */
function scrollScript(top: number): string {
  return `new Promise(done => { scrollTo({ top: ${top}, behavior: 'instant' }); requestAnimationFrame(() => requestAnimationFrame(() => done(scrollY))) })`
}

/**
 * One image of the document from its top, stitched from screens captured while
 * scrolling down it, after which the page is put back where it was. A bar
 * fixed to the screen appears once per screen; content still loading when its
 * screen is captured is missing.
 */
export async function captureFullPage(contents: WebContents, capture: () => Promise<NativeImage | null>): Promise<FullPageImage> {
  const metrics = await readPageMetrics(contents)
  if (!metrics) throw new Error('Page did not report its size')
  const total = Math.max(1, Math.round(metrics.total))
  const covered = Math.min(total, MAX_PAGE_HEIGHT)
  const slices: Buffer[] = []
  let width = 0
  let rowsPerCss = 0
  let wanted = 0
  let emitted = 0
  try {
    while (!wanted || emitted < wanted) {
      const top = await runPageScript(contents, scrollScript(rowsPerCss ? Math.floor(emitted / rowsPerCss) : 0))
      if (typeof top !== 'number' || !Number.isFinite(top)) throw new Error('Page did not scroll')
      const shot = await capture()
      if (!shot) throw new Error('Page produced no frame')
      const image = shot.getSize().width > PAGE_WIDTH ? shot.resize({ width: PAGE_WIDTH }) : shot
      const size = image.getSize()
      if (!rowsPerCss) {
        width = size.width
        rowsPerCss = size.height / metrics.height
        wanted = Math.max(1, Math.round(covered * rowsPerCss))
      } else if (size.width !== width) {
        throw new Error('Page changed size while being captured')
      }
      // The last screen stops short of where it was asked to go, so its slice starts lower down.
      const start = Math.floor(top * rowsPerCss)
      const from = emitted - start
      const until = Math.min(size.height, wanted - start)
      if (from < 0) throw new Error('Page scrolled past where it was asked to go')
      // The document got shorter while being captured.
      if (until <= from) break
      slices.push(image.toBitmap().subarray(from * width * 4, until * width * 4))
      emitted = start + until
    }
  } finally {
    await runPageScript(contents, `scrollTo({ top: ${metrics.top}, behavior: 'instant' })`)
  }

  if (!emitted) throw new Error('Page yielded nothing to stitch')
  const stitched = nativeImage.createFromBitmap(Buffer.concat(slices), { width, height: emitted })
  return {
    image: `data:image/jpeg;base64,${stitched.toJPEG(PAGE_QUALITY).toString('base64')}`,
    width,
    height: emitted,
    covered: Math.min(covered, Math.round(emitted / rowsPerCss)),
    total,
  }
}
