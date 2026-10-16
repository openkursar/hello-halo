/**
 * Codec between local filesystem paths and `halo-file://` URLs, shared by
 * every producer (conversation images, canvas image/markdown viewers, HTML
 * preview base) and decoded back by `foundation/protocol.service.ts`.
 *
 * A raw Windows path pasted after `halo-file://` (`halo-file://C:\dir\a.png`)
 * makes the drive letter a URL host — backslash is a forbidden host code
 * point, so the URL is invalid and Chromium drops the load before the
 * protocol handler runs, leaving a silent blank image. Every path therefore
 * goes in as an empty-host URL with forward slashes and per-segment
 * percent-encoding.
 *
 * Pure string codec — no Node/Electron imports (shared-module constraint).
 */

export const HALO_FILE_SCHEME = 'halo-file://'

/** Filesystem path (either separator style) as a `halo-file://` URL. */
export function toHaloFileUrl(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').map(encodeURIComponent)
  const joined = segments.join('/')
  // A relative-looking input would otherwise become a URL host; the leading
  // slash keeps the host empty. Absolute inputs already begin with one.
  return `${HALO_FILE_SCHEME}/${joined.replace(/^\//, '')}`
}

/**
 * Filesystem path addressed by a `halo-file://` URL, with forward slashes.
 * A `?v=<token>` cache-buster appended by the renderer is ignored.
 */
export function haloFileUrlToPath(url: string): string {
  const raw = url.startsWith(HALO_FILE_SCHEME) ? url.slice(HALO_FILE_SCHEME.length) : url
  return decodeURIComponent(raw.split(/[?#]/)[0])
}
