/**
 * Install orders — the store's install ledger.
 *
 * Order-first: an order is opened against the source the app came from when a
 * download is about to start. The store never blocks on the server — a
 * retryable failure is queued on disk and replayed on the next app start, so
 * the server-side count survives offline installs and outages. Telemetry
 * remains a separate, optional analytics layer; nothing here depends on it.
 *
 * This module owns ledger POLICY only (which installId, what identifies an
 * intent, what goes in the backfill queue, when to replay). Whether a source
 * has a ledger at all, and whether a given failure is retryable, are protocol
 * questions answered by its adapter. Which source an app came from is a
 * catalog question answered by the caller — this module resolves no sources of
 * its own, which is also what keeps it out of a cycle with registry.service.
 */

import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { getHaloDir } from '../../foundation/config.service'
import { getAdapter } from '../adapters'
import { getStoreIdentityToken } from './identity'
import type { RegistrySource, InstallGrant } from '../../../shared/store/store-types'

const PENDING_FILE = 'store-install-orders.pending.json'
const INTENTS_FILE = 'store-install-intents.json'
const INSTALL_ID_FILE = 'store-install-id'

/** Caps on the two on-disk files; the oldest entries are dropped first. */
const INTENTS_MAX = 200
const PENDING_MAX = 200

/** What an order needs to identify itself, independent of the catalog shape. */
export interface OrderTarget {
  slug: string
  version: string
}

/**
 * Source resolution for the replay queue, injected by the caller.
 *
 * Queue entries written before orders became per-source carry no registryId and
 * replay against the primary source, which is exactly what they did when they
 * were queued. That rule is ledger persistence policy, so it lives here rather
 * than at the call site.
 */
export interface SourceLookup {
  byId(registryId: string): RegistrySource | null
  primary(): RegistrySource | null
}

interface PendingOrder {
  slug: string
  version: string
  /** Absent on entries queued before intents existed; those replay under the
   * server's legacy device+app+version key. */
  orderUuid?: string
  /** Absent on entries queued before orders became per-source. */
  registryId?: string
}

/**
 * Ask the app's own source to authorise the install, and get back the bundle
 * location to download from.
 *
 * The server decides the download path — the client does not derive it. That
 * keeps accounting on the download's critical path (an unreported download is
 * structurally impossible) and leaves room for entitlement checks later without
 * a protocol change.
 *
 * Returns null when the source has no install ledger (a static or community
 * registry, whose adapter simply has no such method — zero requests), in which
 * case the caller falls back to the indexed path.
 */
export async function authorizeInstall(
  source: RegistrySource,
  target: OrderTarget,
): Promise<InstallGrant | null> {
  if (!target.version) return null
  // Checked before an intent is minted so a ledger-less source touches neither
  // the network nor the disk.
  if (!getAdapter(source).openInstallOrder) return null

  const order: PendingOrder = {
    slug: target.slug,
    version: target.version,
    orderUuid: intentUuid(source.id, target),
    registryId: source.id,
  }
  try {
    const grant = await postOrder(source, order)
    if (grant) {
      console.log(`[InstallOrders] authorised ${target.slug}@${target.version} on "${source.id}"`)
      return grant
    }
  } catch (err) {
    // The bundle may still be reachable from cache, so an unreachable server
    // does not fail the install; the order is replayed on the next start.
    console.warn(
      `[InstallOrders] ${target.slug}@${target.version} queued for retry:`,
      (err as Error).message,
    )
    enqueue(order)
  }
  return null
}

/**
 * Mark the intent settled: the bytes arrived, so the next attempt at this app
 * is a new download and must count again.
 *
 * Called on download success rather than on install success on purpose — the
 * unit being counted is transfers. An install that fails after the transfer
 * will transfer again, and that second transfer is a second install.
 */
export function completeInstallIntent(source: RegistrySource, target: OrderTarget): void {
  const key = intentKey(source.id, target)
  const intents = readIntents()
  if (!(key in intents)) return
  delete intents[key]
  writeIntents(intents)
}

/** Replay orders that could not reach their source. Called once at startup. */
export async function flushPendingInstallOrders(sources: SourceLookup): Promise<void> {
  const pending = readPending()
  if (pending.length === 0) return
  const requeued: PendingOrder[] = []
  let orphaned = 0
  for (const order of pending) {
    const source = order.registryId ? sources.byId(order.registryId) : sources.primary()
    if (!source) {
      // The source was removed while the order waited. Nothing can accept it, so
      // it is dropped rather than kept forever — counted here so the ledger's
      // shortfall is explainable.
      orphaned++
      continue
    }
    // A source the user switched off must not be contacted. Unlike removal this
    // is reversible, so the order waits for it to come back.
    if (!source.enabled) {
      requeued.push(order)
      continue
    }
    try {
      await postOrder(source, order)
    } catch {
      requeued.push(order)
    }
  }
  // Drop only what this pass actually handled, against the queue as it stands
  // now. Replaying spans network round trips, and bootstrap starts the upgrade
  // scheduler alongside it, so an order enqueued meanwhile would be erased by
  // writing back a snapshot taken before the first request went out.
  const handled = pending.filter(o => !requeued.includes(o))
  writePending(readPending().filter(o => !handled.some(h => sameOrder(h, o))))
  console.log(
    `[InstallOrders] replayed ${handled.length - orphaned}/${pending.length}` +
      ` (requeued ${requeued.length}, orphaned ${orphaned})`,
  )
}

/**
 * The uuid identifying the current install intent for this app on this source
 * (DESIGN.md §3.5.2). Retries reuse it; a new target version is a new intent,
 * and it voids any other pending intent for the same app, since an app has at
 * most one install in flight per source.
 */
function intentUuid(registryId: string, target: OrderTarget): string {
  const key = intentKey(registryId, target)
  const intents = readIntents()
  const existing = intents[key]
  if (existing) return existing

  const prefix = `${registryId}|${target.slug}@`
  for (const other of Object.keys(intents)) {
    if (other.startsWith(prefix)) delete intents[other]
  }
  const fresh = randomUUID()
  intents[key] = fresh
  writeIntents(intents)
  return fresh
}

function intentKey(registryId: string, target: OrderTarget): string {
  return `${registryId}|${target.slug}@${target.version}`
}

/**
 * Stable per-installation identifier, owned by the store.
 *
 * Deliberately independent of the analytics subsystem: install counting is
 * business data and must keep working when telemetry is disabled, fails to
 * initialise, or is removed entirely.
 */
let cachedInstallId: string | null = null

function installId(): string {
  if (cachedInstallId) return cachedInstallId
  const path = join(getHaloDir(), INSTALL_ID_FILE)
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf-8').trim()
      if (existing) return (cachedInstallId = existing)
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
  return (cachedInstallId = fresh)
}

async function postOrder(source: RegistrySource, order: PendingOrder): Promise<InstallGrant | null> {
  const adapter = getAdapter(source)
  if (!adapter.openInstallOrder) return null

  // Identity is optional: a signed-in install is attributed to the account, an
  // anonymous one still counts by device.
  const token = await getStoreIdentityToken().catch(() => null)

  return adapter.openInstallOrder(
    source,
    {
      slug: order.slug,
      version: order.version,
      installId: installId(),
      orderUuid: order.orderUuid ?? '',
    },
    token ? { token } : undefined,
  )
}

function readJsonFile<T>(name: string, fallback: T, accept: (parsed: unknown) => parsed is T): T {
  try {
    const path = join(getHaloDir(), name)
    if (!existsSync(path)) return fallback
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return accept(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJsonFile(name: string, empty: boolean, value: unknown): void {
  try {
    const path = join(getHaloDir(), name)
    if (empty) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    writeFileSync(path, JSON.stringify(value))
  } catch {
    // Ledger persistence is best-effort; a lost file only costs counts.
  }
}

function readPending(): PendingOrder[] {
  return readJsonFile<PendingOrder[]>(PENDING_FILE, [], (p): p is PendingOrder[] =>
    Array.isArray(p),
  ).filter(
    (o): o is PendingOrder => typeof o?.slug === 'string' && typeof o?.version === 'string',
  )
}

function writePending(orders: PendingOrder[]): void {
  // Cap the replay queue; the ledger is idempotent so older duplicates are
  // harmless, but an unbounded file is not.
  writeJsonFile(PENDING_FILE, orders.length === 0, orders.slice(-PENDING_MAX))
}

function enqueue(order: PendingOrder): void {
  const pending = readPending()
  if (!pending.some(o => sameOrder(o, order))) pending.push(order)
  writePending(pending)
}

function sameOrder(a: PendingOrder, b: PendingOrder): boolean {
  if (a.orderUuid && b.orderUuid) return a.orderUuid === b.orderUuid
  // One of them predates intents. Falling back to the target is what stops a
  // queue carried across the upgrade from replaying the same install twice,
  // once under each key shape.
  return a.slug === b.slug && a.version === b.version && a.registryId === b.registryId
}

function readIntents(): Record<string, string> {
  const raw = readJsonFile<Record<string, unknown>>(
    INTENTS_FILE,
    {},
    (p): p is Record<string, unknown> => typeof p === 'object' && p !== null && !Array.isArray(p),
  )
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

function writeIntents(intents: Record<string, string>): void {
  const keys = Object.keys(intents)
  const capped =
    keys.length <= INTENTS_MAX
      ? intents
      : Object.fromEntries(keys.slice(keys.length - INTENTS_MAX).map(k => [k, intents[k]]))
  writeJsonFile(INTENTS_FILE, keys.length === 0, capped)
}
