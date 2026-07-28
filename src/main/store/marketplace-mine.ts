/**
 * "My publications" — creator-facing reads/mutations against an identity-bound
 * store server. Every call carries the marketplace identity token; a server
 * that has no identity binding (or a signed-out user) surfaces as NOT_SIGNED_IN
 * so the renderer can prompt a login rather than showing an error.
 */

import { getOfficialRegistryUrl } from './registry.service'
import { fetchWithTimeout } from './adapters/halo.adapter'
import { getMarketplaceIdentityToken } from './marketplace-identity'
import { MARKETPLACE_NOT_SIGNED_IN } from '../../shared/store/store-types'
import type { MyPublication } from '../../shared/store/store-types'

async function requireToken(): Promise<string> {
  const token = await getMarketplaceIdentityToken()
  if (!token) throw new Error(MARKETPLACE_NOT_SIGNED_IN)
  return token
}

export async function fetchMyPublications(): Promise<MyPublication[]> {
  const base = getOfficialRegistryUrl()
  if (!base) return []
  const token = await requireToken()
  const res = await fetchWithTimeout(`${base}/my/publications`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (res.status === 401) throw new Error(MARKETPLACE_NOT_SIGNED_IN)
  if (!res.ok) throw new Error(`my-publications failed: ${res.status}`)
  const body = (await res.json()) as { publications?: unknown[] }
  return (body.publications ?? []).map(mapPublication)
}

export async function unpublishApp(slug: string): Promise<void> {
  const base = getOfficialRegistryUrl()
  if (!base) throw new Error('No store server configured')
  const token = await requireToken()
  const [author, id] = splitScopedSlug(slug)
  const url = `${base}/my/publications/${encodeURIComponent(author)}/${encodeURIComponent(id)}/unpublish`
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) throw new Error(MARKETPLACE_NOT_SIGNED_IN)
  if (res.status === 403) throw new Error('You can only unpublish your own apps')
  if (!res.ok) throw new Error(`unpublish failed: ${res.status}`)
}

export async function relistApp(slug: string): Promise<void> {
  const base = getOfficialRegistryUrl()
  if (!base) throw new Error('No store server configured')
  const token = await requireToken()
  const [author, id] = splitScopedSlug(slug)
  const url = `${base}/my/publications/${encodeURIComponent(author)}/${encodeURIComponent(id)}/relist`
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) throw new Error(MARKETPLACE_NOT_SIGNED_IN)
  if (res.status === 403) throw new Error('You can only relist your own apps')
  if (!res.ok) throw new Error(`relist failed: ${res.status}`)
}

function mapPublication(raw: unknown): MyPublication {
  const p = (raw ?? {}) as Record<string, unknown>
  const status = p.status === 'hidden' || p.status === 'rejected' ? p.status : 'listed'
  const takedownBy = p.takedown_by === 'self' || p.takedown_by === 'admin' ? p.takedown_by : undefined
  return {
    slug: String(p.slug ?? ''),
    name: typeof p.name === 'string' ? p.name : undefined,
    type: typeof p.type === 'string' ? p.type : undefined,
    version: String(p.version ?? ''),
    status,
    takedownBy,
    rejectReason: typeof p.reject_reason === 'string' ? p.reject_reason : undefined,
    submittedAt: typeof p.submitted_at === 'string' ? p.submitted_at : undefined,
    channel: typeof p.channel === 'string' ? p.channel : undefined,
    installs: typeof p.installs === 'number' ? p.installs : undefined,
  }
}

function splitScopedSlug(slug: string): [string, string] {
  const i = slug.indexOf('/')
  return i < 0 ? [slug, ''] : [slug.slice(0, i), slug.slice(i + 1)]
}
