import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'

/**
 * Writes a V8 heap snapshot to disk, in the format DevTools' Memory panel
 * loads.
 *
 * Kept as a file rather than parsed here: a snapshot of this renderer is
 * hundreds of megabytes, and what to look for depends on what the cheaper
 * probes already ruled out. Capturing is minutes; re-capturing means re-running
 * the whole cycle loop, so the snapshot is taken whenever asked for and
 * analyzed separately.
 */
export async function captureHeapSnapshot(page: Page, filePath: string): Promise<number> {
  const session = await page.context().newCDPSession(page)
  const chunks: string[] = []
  session.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => chunks.push(chunk))
  try {
    await session.send('HeapProfiler.enable')
    // `treatGlobalObjectsAsRoots` keeps window-reachable objects rooted, which
    // is what makes a retainer path readable rather than ending at a synthetic
    // root.
    await session.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      treatGlobalObjectsAsRoots: true
    })
  } finally {
    await session.detach().catch(() => {})
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const text = chunks.join('')
  fs.writeFileSync(filePath, text)
  return Buffer.byteLength(text)
}
