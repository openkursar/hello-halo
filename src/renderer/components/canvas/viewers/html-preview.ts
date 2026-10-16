/**
 * Builds the document an HTML tab previews.
 *
 * The preview iframe runs with an opaque origin (no `allow-same-origin`), so a
 * relative URL in the document would otherwise resolve against the app's own
 * URL. Injecting `<base href="halo-file://<dir>/">` makes relative images and
 * links resolve next to the file on disk, as they would when opened directly.
 */

import { toHaloFileUrl } from '../../../../shared/halo-file-url'

/** `halo-file://` URL of the directory holding `filePath`, with a trailing slash. */
export function haloFileDirectoryUrl(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  if (cut < 0) return null
  // A file directly under the filesystem root resolves against "/" itself.
  const dir = cut === 0 ? '/' : normalized.slice(0, cut)
  return toHaloFileUrl(dir.endsWith('/') ? dir : `${dir}/`)
}

const BASE_WITH_HREF = /<base\b[^>]*\bhref\s*=/i
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i
const HTML_OPEN = /<html(?:\s[^>]*)?>/i
const DOCTYPE = /^\s*<!doctype[^>]*>/i

/**
 * `content` with a base element pointing at the file's directory, or unchanged
 * when there is no local file to resolve against or the author set their own base.
 */
export function buildHtmlPreviewDocument(content: string, filePath: string | undefined): string {
  if (!filePath || BASE_WITH_HREF.test(content)) return content
  const baseUrl = haloFileDirectoryUrl(filePath)
  if (!baseUrl) return content
  const baseTag = `<base href="${baseUrl}">`

  for (const anchor of [HEAD_OPEN, HTML_OPEN, DOCTYPE]) {
    const match = anchor.exec(content)
    if (match) {
      const at = match.index + match[0].length
      return content.slice(0, at) + baseTag + content.slice(at)
    }
  }
  return baseTag + content
}

type PreviewOpenResult = { success: boolean; data?: { url: string; host: string }; error?: string }

/**
 * The preview origin for `path`, or null when it cannot be had — refused,
 * rejected or thrown alike — so the caller always has something to show.
 */
export async function openIsolatedPreview(
  open: (path: string) => Promise<PreviewOpenResult>,
  path: string
): Promise<{ url: string; host: string } | null> {
  try {
    const result = await open(path)
    if (result?.success && result.data) return result.data
    console.warn('[HtmlViewer] Preview origin unavailable, using srcdoc:', result?.error)
  } catch (error) {
    console.warn('[HtmlViewer] Preview origin unavailable, using srcdoc:', error)
  }
  return null
}
