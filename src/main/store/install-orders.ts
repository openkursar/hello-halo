/**
 * Install orders — the store server's own install ledger.
 *
 * Order-first: an order is opened against the registry when the user starts an
 * install. The free store never blocks on the server — a failed request is
 * queued on disk and replayed on the next app start, so the server-side count
 * survives offline installs and outages. Telemetry remains a separate,
 * optional analytics layer; nothing here depends on it.
 */

import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { getHaloDir } from '../foundation/config.service'
import { getOfficialRegistryUrl, findStoreEntry } from './registry.service'
import { fetchWithTimeout } from './adapters/halo.adapter'
import { getMarketplaceIdentityToken } from './marketplace-identity'
import { analytics } from '../services/analytics'

const PENDING_FILE = 'store-install-orders.pending.json'

interface PendingOrder {
  slug: string
  version: string
}

/**
 * Open an install order for a user-initiated install. Never throws and never
 * blocks the install: failures are persisted for replay.
 */
export function openInstallOrder(slug: string): void {
  const version = findStoreEntry(slug)?.entry.version ?? ''
  if (!version) return
  void postOrder({ slug, version }, false).catch(() => enqueue({ slug, version }))
}

/** Replay orders that could not reach the registry. Called once at startup. */
export async function flushPendingInstallOrders(): Promise<void> {
  const pending = readPending()
  if (pending.length === 0) return
  const failed: PendingOrder[] = []
  for (const order of pending) {
    try {
      await postOrder(order, true)
    } catch {
      failed.push(order)
    }
  }
  writePending(failed)
}

async function postOrder(order: PendingOrder, backfill: boolean): Promise<void> {
  const base = getOfficialRegistryUrl()
  if (!base) return
  const installId = analytics.getUserId()
  if (!installId) return

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Identity is optional: a signed-in install is attributed to the account,
  // an anonymous one still counts by device.
  const token = await getMarketplaceIdentityToken().catch(() => null)
  if (token) headers.Authorization = `Bearer ${token}`

  const [author, id] = order.slug.includes('/')
    ? [order.slug.slice(0, order.slug.indexOf('/')), order.slug.slice(order.slug.indexOf('/') + 1)]
    : [order.slug, '']
  const path = id
    ? `${encodeURIComponent(author)}/${encodeURIComponent(id)}`
    : encodeURIComponent(author)
  const res = await fetchWithTimeout(`${base}/apps/${path}/installs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ installId, version: order.version, backfill }),
  })
  // 4xx = permanently rejected (unknown slug, bad payload): retrying cannot
  // succeed, so treat as done. Only transport/5xx failures reach the queue.
  if (res.status >= 500) throw new Error(`install order failed: ${res.status}`)
}

function pendingPath(): string {
  return join(getHaloDir(), PENDING_FILE)
}

function readPending(): PendingOrder[] {
  try {
    if (!existsSync(pendingPath())) return []
    const parsed = JSON.parse(readFileSync(pendingPath(), 'utf-8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (o): o is PendingOrder =>
        typeof (o as PendingOrder)?.slug === 'string' && typeof (o as PendingOrder)?.version === 'string',
    )
  } catch {
    return []
  }
}

function writePending(orders: PendingOrder[]): void {
  try {
    if (orders.length === 0) {
      if (existsSync(pendingPath())) unlinkSync(pendingPath())
      return
    }
    // Cap the replay queue; the ledger is idempotent so older duplicates are
    // harmless, but an unbounded file is not.
    writeFileSync(pendingPath(), JSON.stringify(orders.slice(-200)))
  } catch {
    // Queue persistence is best-effort; a lost queue only costs counts.
  }
}

function enqueue(order: PendingOrder): void {
  const pending = readPending()
  if (!pending.some((o) => o.slug === order.slug && o.version === order.version)) {
    pending.push(order)
  }
  writePending(pending)
}
