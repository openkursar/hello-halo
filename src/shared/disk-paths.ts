/**
 * Disk-root detection, shared by every subsystem that walks or watches a
 * user-chosen directory (artifact tree cache, knowledge-base watched folders).
 *
 * Recursive walks over a disk root produce file counts in the millions and
 * can freeze the owning process, so callers reject these paths outright.
 *
 * Pure path predicate — no Node/Electron imports (shared-module constraint).
 */

export function isDiskRoot(path: string): boolean {
  if (/^[A-Z]:\\?$/i.test(path)) return true
  if (path === '/') return true
  if (/^\/Volumes\/[^/]+\/?$/.test(path)) return true
  if (/^\/mnt\/[^/]+\/?$/.test(path)) return true
  if (/^\/media\/[^/]+\/?$/.test(path)) return true
  return false
}
