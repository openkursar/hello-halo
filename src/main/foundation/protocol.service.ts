/**
 * Protocol Service - Custom protocol registration for secure local resource access
 *
 * Provides halo-file:// protocol to bypass cross-origin restrictions when loading
 * local files from localhost (dev mode) or app:// (production mode).
 *
 * Usage:
 * - Images: <img src="halo-file:///path/to/image.png">
 * - PDF: BrowserView.loadURL("halo-file:///path/to/doc.pdf")
 * - Other media: Same pattern for video, audio, etc.
 *
 * Security: Only file:// URLs are allowed, no remote URLs pass through.
 */

import { protocol, net } from 'electron'

/**
 * Register custom protocols for secure local resource access
 * Must be called after app.whenReady()
 */
export function registerProtocols(): void {
  // halo-file:// - Proxy to file:// for local resources
  // Chromium blocks file:// from localhost/app origins, this bypasses that
  protocol.handle('halo-file', (request) => {
    // The renderer appends a ?v=<token> cache-buster to force <img> reloads when a
    // file is rewritten in place; strip any query/hash before resolving the real path.
    const raw = request.url.replace('halo-file://', '')
    const filePath = decodeURIComponent(raw.split(/[?#]/)[0])
    return net.fetch(`file://${filePath}`)
  })

  console.log('[Protocol] Registered halo-file:// protocol')
}
