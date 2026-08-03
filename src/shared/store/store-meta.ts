/**
 * Typed accessors for the store fields carried in the open
 * `RegistryEntry.meta` container. Sources that predate these fields (static
 * mirrors, third-party registries) simply omit them, so every accessor
 * degrades to an empty/absent result rather than throwing.
 */

import type { RegistryEntry } from './store-types'

/** One published version, aggregated server-side and surfaced on the detail page. */
export interface StoreVersionRecord {
  version: string
  publishedAt?: string
  changelog?: string
}

/** Version history (newest first), or empty when the source carries none. */
export function getEntryVersions(entry: RegistryEntry): StoreVersionRecord[] {
  const raw = entry.meta?.versions
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (v): v is StoreVersionRecord =>
      typeof v === 'object' && v !== null && typeof (v as { version?: unknown }).version === 'string',
  )
}

/** Install count, or null when the source carries no telemetry-derived count. */
export function getEntryInstalls(entry: RegistryEntry): number | null {
  const value = entry.meta?.installs
  return typeof value === 'number' && value > 0 ? value : null
}

/** Whether the entry is flagged for the featured slot. */
export function isEntryFeatured(entry: RegistryEntry): boolean {
  return entry.meta?.featured === true
}
