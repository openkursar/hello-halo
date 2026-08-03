/**
 * DHP v2 Adapter
 *
 * The full Digital Human Protocol v2: the same bundle directory layout the
 * static Halo source serves, plus the backend endpoints a DHP v2 server adds
 * on top of it —
 *
 *   GET  {url}/capabilities                                  handshake
 *   POST {url}/apps/{slug}/installs                          install ledger
 *   GET  {url}/collections                                   curated bundles
 *   GET  {url}/my/publications                               creator's own listings
 *   POST {url}/my/publications/{author}/{id}/unpublish
 *   POST {url}/my/publications/{author}/{id}/relist
 *   GET  {url}/category-taxonomy.json                        ops-managed chips
 *   GET  {url}/discover-layout.json                          ops-managed page
 *
 * The catalog half is byte-identical to the static protocol, so it is delegated
 * to HaloAdapter rather than duplicated.
 *
 * This is the only file in the store module that reads HTTP status codes: every
 * "does this endpoint exist / is this failure retryable" decision is a protocol
 * concern and lives here, so the composition layer above sees only values,
 * `null`, and thrown faults.
 */

import { HaloAdapter, fetchWithTimeout } from './halo.adapter'
import { STORE_NOT_SIGNED_IN } from '../../../shared/store/store-types'
import type {
  RegistrySource,
  RegistryEntry,
  ServerFeatures,
  StoreIdentityMode,
  InstallOrder,
  InstallGrant,
} from '../../../shared/store/store-types'
import type { AppSpec, SkillSpec } from '../../apps/spec/schema'
import type {
  RegistryAdapter,
  RegistryAuth,
  PageDocumentResult,
  FetchIndexResult,
  IndexValidators,
} from './types'

const JSON_HEADERS = { Accept: 'application/json', 'User-Agent': 'Halo-Store/1.0' } as const

/**
 * Handshake cadence matches the store sync cadence: entering the store
 * usually hits the cache, so capability detection adds no first-screen wait.
 */
const HANDSHAKE_TTL_MS = 60 * 60 * 1000

/**
 * A transient backend fault (5xx/429/network) must not lock the read-only
 * baseline in for a full hour — the last-known value is kept and retried soon.
 */
const HANDSHAKE_RETRY_MS = 5 * 60 * 1000

interface HandshakeEntry {
  features: ServerFeatures | null
  expiresAt: number
}

/**
 * A rate-limited or faulting server will serve the same request later; a 4xx
 * refusal will not. The handshake and the ledger must classify this the same
 * way, or the same outage is transient on one path and permanent on the other.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** Anything a newer server invents is downgraded rather than passed upward. */
function readIdentityBinding(raw: unknown): StoreIdentityMode {
  return raw === 'account' || raw === 'shared' ? raw : 'none'
}

export class DhpV2Adapter implements RegistryAdapter {
  readonly strategy = 'mirror' as const

  /**
   * Keyed by source URL: a federation may hold several DHP v2 sources, so a
   * module-level single slot would let one source's handshake answer for
   * another's.
   */
  private handshakes = new Map<string, HandshakeEntry>()

  private readonly catalog = new HaloAdapter()

  // ── Catalog ──────────────────────────────────────────────────────────────

  // Validators must be forwarded, not dropped: this driver delegates its catalog
  // to Halo, so swallowing them would silently turn every revalidation into a
  // full index download for the one source type an enterprise build ships.
  fetchIndex(source: RegistrySource, validators?: IndexValidators): Promise<FetchIndexResult> {
    return this.catalog.fetchIndex(source, validators)
  }

  // No onProgress parameter: a DHP bundle's spec is a single fetch, so the
  // delegate has no progress to report.
  fetchSpec(source: RegistrySource, entry: RegistryEntry): Promise<AppSpec> {
    return this.catalog.fetchSpec(source, entry)
  }

  fetchDocument(source: RegistrySource, entry: RegistryEntry): Promise<string | null> {
    return this.catalog.fetchDocument(source, entry)
  }

  fetchBundledSkills(
    source: RegistrySource,
    entry: RegistryEntry,
    skills: Array<{ id: string; files?: string[] }>,
  ): Promise<Map<string, SkillSpec>> {
    return this.catalog.fetchBundledSkills(source, entry, skills)
  }

  // ── Handshake ────────────────────────────────────────────────────────────

  /**
   * Probe `GET /capabilities`, TTL-cached per source. Failure handling
   * distinguishes a genuinely absent endpoint from a transient fault:
   *   - 404/501 → the deployment has no admin block; cache the read-only
   *     baseline for the full TTL, re-probing sooner would be wasteful.
   *   - anything else → keep the last-known features (stale but not broken) and
   *     retry after the short TTL.
   */
  async serverFeatures(source: RegistrySource): Promise<ServerFeatures | null> {
    const key = baseUrl(source)
    const now = Date.now()
    const cached = this.handshakes.get(key)
    if (cached && cached.expiresAt > now) return cached.features

    try {
      const res = await fetchWithTimeout(`${key}/capabilities`, { headers: { ...JSON_HEADERS } })
      if (!res.ok) {
        if (res.status === 404 || res.status === 501) {
          this.handshakes.set(key, { features: null, expiresAt: now + HANDSHAKE_TTL_MS })
          return null
        }
        return this.keepStaleHandshake(key, cached, now, `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { features?: Record<string, unknown> }
      const f = body.features ?? {}
      const features: ServerFeatures = {
        installs: f.installs === true,
        featured: f.featured === true,
        collections: f.collections === true,
        reviewWorkflow: f.reviewWorkflow === true,
        identityBinding: readIdentityBinding(f.identityBinding),
      }
      this.handshakes.set(key, { features, expiresAt: now + HANDSHAKE_TTL_MS })
      return features
    } catch (error) {
      return this.keepStaleHandshake(key, cached, now, (error as Error).message)
    }
  }

  private keepStaleHandshake(
    key: string,
    cached: HandshakeEntry | undefined,
    now: number,
    reason: string,
  ): ServerFeatures | null {
    console.warn(`[DhpV2Adapter] /capabilities probe failed for ${key} (${reason}); keeping last-known`)
    const stale = cached?.features ?? null
    this.handshakes.set(key, { features: stale, expiresAt: now + HANDSHAKE_RETRY_MS })
    return stale
  }

  // ── Install ledger ───────────────────────────────────────────────────────

  /**
   * 4xx is a permanent refusal (unknown slug, bad payload, or a deployment whose
   * ledger is not wired) → null, so the caller falls back to the indexed path.
   * 5xx / 429 / transport faults are retryable → thrown, so the caller backfills.
   */
  async openInstallOrder(
    source: RegistrySource,
    order: InstallOrder,
    auth?: RegistryAuth,
  ): Promise<InstallGrant | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth?.token) headers.Authorization = `Bearer ${auth.token}`

    const url = `${baseUrl(source)}/apps/${encodeSlugPath(order.slug)}/installs`
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        installId: order.installId,
        version: order.version,
        orderUuid: order.orderUuid,
      }),
    })
    if (isRetryableStatus(res.status)) throw new Error(`install order failed: ${res.status}`)
    if (!res.ok) return null
    const grant = (await res.json()) as { path?: unknown }
    return typeof grant.path === 'string' && grant.path ? { path: grant.path } : null
  }

  // ── Collections ──────────────────────────────────────────────────────────

  async fetchCollections(source: RegistrySource): Promise<unknown[]> {
    const res = await fetchWithTimeout(`${baseUrl(source)}/collections`, { headers: { ...JSON_HEADERS } })
    if (res.status === 404 || res.status === 501) return []
    if (!res.ok) throw new Error(`collections failed: ${res.status}`)
    const body = (await res.json()) as { collections?: unknown[] }
    return body.collections ?? []
  }

  // ── Creator publications ─────────────────────────────────────────────────

  async fetchMyPublications(source: RegistrySource, auth: RegistryAuth): Promise<unknown[]> {
    const res = await fetchWithTimeout(`${baseUrl(source)}/my/publications`, {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${auth.token}` },
    })
    if (res.status === 401) throw new Error(STORE_NOT_SIGNED_IN)
    if (!res.ok) throw new Error(`my-publications failed: ${res.status}`)
    const body = (await res.json()) as { publications?: unknown[] }
    return body.publications ?? []
  }

  unpublish(source: RegistrySource, slug: string, auth: RegistryAuth): Promise<void> {
    return this.postPublicationAction(source, slug, 'unpublish', auth)
  }

  relist(source: RegistrySource, slug: string, auth: RegistryAuth): Promise<void> {
    return this.postPublicationAction(source, slug, 'relist', auth)
  }

  private async postPublicationAction(
    source: RegistrySource,
    slug: string,
    action: 'unpublish' | 'relist',
    auth: RegistryAuth,
  ): Promise<void> {
    const [author, id] = splitScopedSlug(slug)
    // The route addresses author and id separately, so a flat slug has nothing
    // to put in the second segment and would post to an empty path element.
    if (!id) throw new Error(`Cannot ${action} "${slug}": publications are addressed as "author/app-id"`)
    const url =
      `${baseUrl(source)}/my/publications/` +
      `${encodeURIComponent(author)}/${encodeURIComponent(id)}/${action}`
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (res.status === 401) throw new Error(STORE_NOT_SIGNED_IN)
    if (res.status === 403) throw new Error(`You can only ${action} your own apps`)
    if (!res.ok) throw new Error(`${action} failed: ${res.status}`)
  }

  // ── Page-level documents ─────────────────────────────────────────────────

  fetchPageTaxonomy(source: RegistrySource, validator?: string): Promise<PageDocumentResult> {
    return this.fetchPageDocument(source, '/category-taxonomy.json', validator)
  }

  fetchPageLayout(source: RegistrySource, validator?: string): Promise<PageDocumentResult> {
    return this.fetchPageDocument(source, '/discover-layout.json', validator)
  }

  /**
   * Any non-2xx other than absence is a fault the caller must be able to tell
   * apart from absence, so it is thrown rather than flattened.
   */
  private async fetchPageDocument(
    source: RegistrySource,
    path: string,
    validator?: string,
  ): Promise<PageDocumentResult> {
    const res = await fetchWithTimeout(`${baseUrl(source)}${path}`, {
      headers: { ...JSON_HEADERS, ...(validator ? { 'If-None-Match': validator } : {}) },
    })
    if (res.status === 404 || res.status === 501) return { status: 'absent' }
    if (res.status === 304) return { status: 'unchanged' }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return {
      status: 'ok',
      document: (await res.json()) as unknown,
      validator: res.headers.get('ETag') ?? undefined,
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function baseUrl(source: RegistrySource): string {
  return source.url.replace(/\/+$/, '')
}

function splitScopedSlug(slug: string): [string, string] {
  const i = slug.indexOf('/')
  return i < 0 ? [slug, ''] : [slug.slice(0, i), slug.slice(i + 1)]
}

function encodeSlugPath(slug: string): string {
  const [author, id] = splitScopedSlug(slug)
  return id ? `${encodeURIComponent(author)}/${encodeURIComponent(id)}` : encodeURIComponent(author)
}
