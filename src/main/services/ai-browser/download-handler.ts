/**
 * AI Browser Download Handler
 *
 * Registers a session-level `will-download` handler on `persist:browser` that
 * silently saves downloads for AI-initiated views, while leaving user-initiated
 * downloads unaffected (they continue to show the native "Save As" dialog).
 *
 * Routing: webContentsId -> BrowserContext registry, populated by trackView()
 * and cleaned up by destroy() in context.ts.
 */

import { session } from 'electron'
import { browserViewManager } from '../browser-view.service'
import type { BrowserContext } from './context'
import type { DownloadState } from './types'

// Registry: maps webContents IDs to the BrowserContext that owns them.
// This enables routing downloads to the correct scoped or global context.
const contextsByWebContentsId = new Map<number, BrowserContext>()

/**
 * Register a webContents ID as belonging to a BrowserContext.
 * Called from BrowserContext.trackView() for every AI-created view.
 */
export function registerWebContentsForDownload(wcId: number, ctx: BrowserContext): void {
  contextsByWebContentsId.set(wcId, ctx)
  console.log(`[DownloadHandler] Registered webContents ${wcId} for download routing`)
}

/**
 * Unregister a webContents ID (called on view destroy).
 * Called from BrowserContext.destroy().
 */
export function unregisterWebContentsForDownload(wcId: number): void {
  contextsByWebContentsId.delete(wcId)
}

let installed = false

/**
 * One-time setup: install the `will-download` handler on the `persist:browser` session.
 * Must be called during AI Browser module initialization. Safe to call multiple times.
 */
export function installDownloadHandler(): void {
  if (installed) return
  installed = true

  const sess = session.fromPartition('persist:browser')

  sess.on('will-download', (_event, item, webContents) => {
    // Step 1: Determine if this is an AI download
    const viewId = browserViewManager.findViewIdByWebContentsId(webContents.id)

    // Not from a managed browser page, or not an AI view -> let native dialog show
    if (!viewId || !browserViewManager.isAIView(viewId)) {
      return
    }

    // Step 2: Find the owning BrowserContext
    const ctx = contextsByWebContentsId.get(webContents.id)
    if (!ctx) {
      console.warn(`[DownloadHandler] AI view ${viewId} has no registered context, falling back to native dialog`)
      return
    }

    // Step 3: Register the download and get a safe save path
    const { id, resolvedPath } = ctx.registerDownload(
      item.getURL(),
      item.getFilename(),
      item.getTotalBytes(),
      item.getMimeType()
    )

    // Step 4: Set save path to bypass the native "Save As" dialog
    item.setSavePath(resolvedPath)
    // Log filename and path only — omit full URL to avoid leaking tokens/credentials in query strings
    console.log(`[DownloadHandler] Silent download started: ${item.getFilename()} -> ${resolvedPath} (id: ${id})`)

    // Step 5: Track progress and completion
    item.on('updated', (_e, state) => {
      const dlState: DownloadState = state === 'progressing' ? 'in_progress' : 'failed'
      ctx.updateDownloadProgress(id, item.getReceivedBytes(), dlState)
    })

    item.once('done', (_e, state) => {
      let dlState: DownloadState
      if (state === 'completed') {
        dlState = 'completed'
      } else if (state === 'cancelled') {
        dlState = 'cancelled'
      } else {
        dlState = 'failed'
      }
      ctx.updateDownloadProgress(id, item.getReceivedBytes(), dlState,
        dlState === 'failed' ? `Download ${state}` : undefined)
      console.log(`[DownloadHandler] Download ${dlState}: ${resolvedPath} (${item.getReceivedBytes()} bytes)`)
    })
  })

  console.log('[DownloadHandler] Installed will-download handler on persist:browser session')
}
