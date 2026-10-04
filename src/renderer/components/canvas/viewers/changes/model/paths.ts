/**
 * Path helpers for the changes view. Repository paths are relative with
 * forward slashes (as git reports them); roots and file-tool paths are
 * absolute in the host's own form, which on Windows uses backslashes.
 */

/** Last segment of a forward- or back-slashed path. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/** Directory part of a repository-relative path; '' at the root. */
export function dirName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/** Absolute path of a repository-relative `path` under `root`, in the root's separator style. */
export function joinRepoPath(root: string, path: string): string {
  const windows = root.includes('\\') && !root.includes('/')
  const separator = windows ? '\\' : '/'
  const trimmed = root.endsWith(separator) ? root.slice(0, -1) : root
  return `${trimmed}${separator}${windows ? path.replace(/\//g, '\\') : path}`
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * `path` relative to `folder` with forward slashes, or null when it is not
 * inside it. Windows paths compare case-insensitively, as the file system does.
 */
export function relativeTo(folder: string, path: string): string | null {
  const base = normalize(folder)
  const full = normalize(path)
  const caseless = /^[a-zA-Z]:\//.test(base)
  const a = caseless ? base.toLowerCase() : base
  const b = caseless ? full.toLowerCase() : full
  if (b === a) return ''
  if (!b.startsWith(`${a}/`)) return null
  return full.slice(base.length + 1)
}

/**
 * The root among `roots` that holds `path` most closely — a repository nested
 * in the space folder, not the space's own — or null when none holds it.
 */
export function deepestRootOf(roots: readonly string[], path: string): string | null {
  let found: string | null = null
  for (const root of roots) {
    if (relativeTo(root, path) && (found === null || root.length > found.length)) found = root
  }
  return found
}

/** File extension without the dot, lower-cased; '' when there is none. */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}
