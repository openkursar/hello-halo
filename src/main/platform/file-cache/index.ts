/**
 * Platform - File Cache
 *
 * Caches of values derived from files on disk, kept valid by the file itself
 * rather than by callers remembering to invalidate.
 *
 * Does NOT know what the files contain or who reads them: callers pass the
 * derivation and the bounds. Node-only (reads file metadata).
 */

export { createStampedLru } from './stamped-lru'
export type { StampedLru, StampedLruOptions } from './stamped-lru'
