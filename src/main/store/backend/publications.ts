/**
 * "My publications" — creator-facing reads/mutations against the identity-bound
 * source. Every call carries the store identity token; a source with no identity
 * binding (or a signed-out user) surfaces as NOT_SIGNED_IN so the renderer can
 * prompt a login rather than showing an error.
 *
 * Primary source only, reads included. A build mints one identity token from one
 * declared provider, so there is exactly one store that can attribute a
 * publication to this user. Listing from several sources while unpublishing
 * against one would let the user act on a row the write path cannot address, and
 * would hand the deployment's token to sources that are not its own.
 * See DESIGN.md §3.4.
 */

import { getPrimaryRegistry } from '../registry.service'
import { getAdapter } from '../adapters'
import { getStoreIdentityToken } from './identity'
import { STORE_NOT_SIGNED_IN } from '../../../shared/store/store-types'
import type { MyPublication, RegistrySource } from '../../../shared/store/store-types'
import type { RegistryAdapter, RegistryAuth } from '../adapters/types'

async function requireAuth(): Promise<RegistryAuth> {
  const token = await getStoreIdentityToken()
  if (!token) throw new Error(STORE_NOT_SIGNED_IN)
  return { token }
}

/**
 * The primary source's implementation of `method`, already bound — drivers
 * implement these as methods, so it must not leave the adapter unbound.
 * Null when there is no enabled primary source or it has no such endpoint.
 */
function primaryEndpoint<M extends 'fetchMyPublications' | 'unpublish' | 'relist'>(
  method: M,
): { source: RegistrySource; call: NonNullable<RegistryAdapter[M]> } | null {
  const source = getPrimaryRegistry()
  if (!source) return null
  const adapter = getAdapter(source)
  const call = adapter[method]
  return call ? { source, call: call.bind(adapter) as NonNullable<RegistryAdapter[M]> } : null
}

export async function fetchMyPublications(): Promise<MyPublication[]> {
  const endpoint = primaryEndpoint('fetchMyPublications')
  // Resolving the token before knowing anyone can use it would push a
  // provider-less build into a sign-in prompt it has no way to satisfy.
  if (!endpoint) return []

  const raw = await endpoint.call(endpoint.source, await requireAuth())
  return raw.map(mapPublication)
}

export async function unpublishApp(slug: string): Promise<void> {
  await write('unpublish', slug)
}

export async function relistApp(slug: string): Promise<void> {
  await write('relist', slug)
}

/**
 * A store with no creator-management backend must say so. Silently doing
 * nothing is the one outcome the user cannot distinguish from success.
 */
async function write(method: 'unpublish' | 'relist', slug: string): Promise<void> {
  const endpoint = primaryEndpoint(method)
  if (!endpoint) throw new Error('This store does not support managing your publications')
  await endpoint.call(endpoint.source, slug, await requireAuth())
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
