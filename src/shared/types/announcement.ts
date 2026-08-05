/**
 * Announcement feed contract.
 *
 * This is the wire format of the JSON document served at
 * `product.json > announcementsUrl`. It is the stable half of the feature:
 * the client surface may change (today a toast, later a message centre) but a
 * published feed must keep working, so treat every field here as public API.
 *
 * Authoring notes for whoever maintains the feed:
 * - `id` must be unique and stable. It is the dedup key — reusing an id for
 *   different content means the new content is never shown.
 * - `expiresAt` is effectively mandatory in practice: without it an entry is
 *   shown to every new install forever. Emptying the feed file retracts
 *   everything.
 */

import type { ToastVariant, ToastBodyFormat, ToastLinkAction } from './notification'

export interface Announcement {
  /** Stable unique id. Dedup key — never reuse across different content. */
  id: string
  title: string
  body?: string
  /** Defaults to 'text'. Raw HTML is never rendered — see RichText. */
  bodyFormat?: ToastBodyFormat
  /** Visual accent. Defaults to 'default'. */
  severity?: ToastVariant
  /** ISO date-time. Entry stays hidden before this instant. */
  startsAt?: string
  /** ISO date-time. Entry stops showing after this instant. */
  expiresAt?: string
  /** Optional call to action. Only http/https URLs are honoured. */
  action?: ToastLinkAction
  /** Inclusive lower bound on the app version that should see this entry. */
  minVersion?: string
  /** Inclusive upper bound on the app version that should see this entry. */
  maxVersion?: string
}

/**
 * Feed document root.
 *
 * A bare array is also accepted by the client so a minimal feed can be a
 * plain JSON list, but new feeds should use this object form — it leaves room
 * for feed-level metadata without another format break.
 */
export interface AnnouncementFeed {
  announcements: Announcement[]
}
