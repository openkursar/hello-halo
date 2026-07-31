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
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { getHaloDir } from '../foundation/config.service'
import { getOfficialRegistryUrl, findStoreEntry } from './registry.service'
import { fetchWithTimeout } from './adapters/halo.adapter'
import { getMarketplaceIdentityToken } from './marketplace-identity'

const PENDING_FILE = 'store-install-orders.pending.json'
const INSTALL_ID_FILE = 'store-install-id'

interface PendingOrder {
  slug: string
  version: string
}

/**
 * Ask the store server to authorise an install, and get back the bundle
 * location to download from.
 *
 * The server decides — the client does not derive the download path itself.
 * That keeps accounting on the install's critical path (an unreported install
 * is structurally impossible) and leaves room for entitlement checks later
 * without a protocol change.
 *
 * Returns null when the server has no install endpoint (a static or community
 * registry), in which case the caller falls back to the indexed path.
 */
export async function authorizeInstall(slug: string): Promise<{ path: string } | null> {
  const version = findStoreEntry(slug)?.entry.version ?? ''
  if (!version) return null
  try {
    const granted = await postOrder({ slug, version }, false)
    if (granted?.path) {
      console.log(`[InstallOrders] authorised ${slug}@${version}`)
      return { path: granted.path }
    }
  } catch (err) {
    // The bundle may still be reachable from cache, so an unreachable server
    // does not fail the install; the order is replayed on the next start.
    console.warn(`[InstallOrders] ${slug}@${version} queued for retry:`, (err as Error).message)
    enqueue({ slug, version })
  }
  return null
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

/**
 * Stable per-installation identifier, owned by the store.
 *
 * Deliberately independent of the analytics subsystem: install counting is
 * business data and must keep working when telemetry is disabled, fails to
 * initialise, or is removed entirely.
 */
function installId(): string {
  const path = join(getHaloDir(), INSTALL_ID_FILE)
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf-8').trim()
      if (existing) return existing
    }
  } catch {
    // Fall through and mint a fresh one.
  }
  const fresh = randomUUID()
  try {
    writeFileSync(path, fresh)
  } catch {
    // An unwritable data dir only costs de-duplication across restarts.
  }
  return fresh
}

interface OrderGrant {
  path?: string
}

async function postOrder(order: PendingOrder, backfill: boolean): Promise<OrderGrant | null> {
  const base = getOfficialRegistryUrl()
  if (!base) {
    console.warn('[InstallOrders] no official registry configured; install not recorded')
    return null
  }

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
    body: JSON.stringify({ installId: installId(), version: order.version, backfill }),
  })
  // 4xx = permanently rejected (unknown slug, bad payload): retrying cannot
  // succeed, so treat as done. Only transport/5xx failures reach the queue.
  if (res.status >= 500) throw new Error(`install order failed: ${res.status}`)
  if (!res.ok) {
    // 404 means a registry without the endpoint (static mirror / community
    // build); anything else is a permanent rejection. Both leave the caller to
    // fall back to the indexed path.
    return null
  }
  return (await res.json()) as OrderGrant
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
