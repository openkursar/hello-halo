/**
 * Download Tools (1 tool)
 *
 * File download support for AI automation.
 * Provides both direct URL downloads and waiting for implicit downloads
 * triggered by previous actions (e.g. clicking a download button).
 */

import { z } from 'zod'
import { tool } from '../../agent/resolved-sdk'
import type { BrowserContext } from '../context'
import { isUrlAllowedByPolicy } from '../../browser-policy.service'
import { textResult, withTimeout } from './helpers'

/** Default timeout for download operations (ms) */
const DOWNLOAD_TIMEOUT = 30_000

/** Protocols allowed for direct URL downloads */
const ALLOWED_PROTOCOLS = ['http:', 'https:']

export function buildDownloadTools(ctx: BrowserContext) {

const browser_download = tool(
  'browser_download',
  `Download a file from a URL or wait for a download triggered by a previous action.

Direct download:  { url: "https://example.com/report.pdf" }
  Downloads the file directly. Only HTTP and HTTPS URLs are allowed.

Wait for download:  {} (no parameters)
  Waits for a download already in progress or about to start (e.g., triggered by a previous browser_click on a download button). Call this immediately after the action that initiates the download.

Returns the local file path, file size, MIME type, and download status on completion. Increase timeout for large files.`,
  {
    url: z.string().optional().describe(
      'URL to download directly. If omitted, waits for a download triggered by a previous action.'
    ),
    timeout: z.number().int().optional().describe(
      'Maximum wait time in milliseconds for the download to complete. Default: 120000 (2 minutes).'
    ),
  },
  async (args) => {
    const viewId = ctx.getActiveViewId()
    if (!viewId) {
      return textResult('No active browser page. Use browser_navigate first.', true)
    }

    const timeout = (args.timeout && args.timeout > 0) ? args.timeout : DOWNLOAD_TIMEOUT

    try {
      if (args.url) {
        // Validate protocol: only allow http/https to prevent file:// and other protocol abuse
        try {
          const parsed = new URL(args.url)
          if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
            return textResult(`Download blocked: protocol "${parsed.protocol}" is not allowed. Only HTTP(S) URLs are supported.`, true)
          }
        } catch {
          return textResult(`Download blocked: invalid URL "${args.url}".`, true)
        }

        // Validate against browser policy (allowlist/blocklist)
        if (!isUrlAllowedByPolicy(args.url)) {
          return textResult(`Download blocked by browser policy: ${args.url}`, true)
        }

        // Direct download mode: use webContents.downloadURL to trigger will-download
        const wc = ctx.getWebContents()
        if (!wc) {
          return textResult('No active web contents.', true)
        }
        wc.downloadURL(args.url)
      }

      // Wait for the download to complete (either direct or from a prior click)
      const info = await withTimeout(
        ctx.waitForDownload(timeout),
        timeout + 5000, // Outer timeout slightly longer to let inner timeout fire first
        'browser_download'
      )

      const lines = [
        `Download ${info.state}:`,
        `  File: ${info.filename}`,
        `  Path: ${info.savePath}`,
        `  Size: ${formatBytes(info.receivedBytes)}`,
        `  MIME: ${info.mimeType}`,
      ]
      if (info.endTime && info.startTime) {
        lines.push(`  Duration: ${info.endTime - info.startTime}ms`)
      }
      if (info.error) {
        lines.push(`  Error: ${info.error}`)
      }

      return textResult(lines.join('\n'), info.state !== 'completed')
    } catch (error) {
      return textResult(`Download failed: ${(error as Error).message}`, true)
    }
  }
)

return [browser_download]

} // end buildDownloadTools

/**
 * Format byte count into human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 0) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
