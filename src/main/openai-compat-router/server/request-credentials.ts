/**
 * The account's current credential for each proxied request.
 *
 * An engine session encodes its backend config once, when its process starts,
 * and OAuth tokens rotate long before such a process ends. The AI source layer
 * registers a resolver at startup; each request then carries the account's
 * current credential fields while everything else the session chose (model,
 * wire format, capabilities) stays as encoded. So a token refresh never needs
 * the session rebuilt.
 *
 * Until a resolver is registered, and for configs without a source, the
 * encoded credential is used as is.
 */

import type { BackendConfig } from '../types'

/**
 * The fields that change when an account's credential rotates. The endpoint is
 * not one of them: engines normalize it for their own wire format.
 */
export type RequestCredentials = Pick<BackendConfig, 'key' | 'headers' | 'profileArn'>

/**
 * Current credentials for an account and model; null keeps the encoded ones.
 * Rejects when the account can no longer be used (removed or signed out).
 * Called once per proxied request, so it must answer from memory when it can.
 */
export type RequestCredentialResolver = (sourceId: string, model: string | undefined) => Promise<RequestCredentials | null>

let resolver: RequestCredentialResolver | null = null

/** Registered once at startup by the AI source layer, which this module cannot import. */
export function setRequestCredentialResolver(next: RequestCredentialResolver | null): void {
  resolver = next
}

export async function withCurrentCredentials(
  config: BackendConfig
): Promise<{ config: BackendConfig } | { error: string }> {
  if (!resolver || !config.sourceId || config.delegatedAuth) return { config }
  try {
    const current = await resolver(config.sourceId, config.model)
    return { config: current ? { ...config, ...current } : config }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'This account is unavailable.'
    console.warn(`[Router] Request refused: source=${config.sourceId} credential unavailable (${message})`)
    return { error: message }
  }
}
