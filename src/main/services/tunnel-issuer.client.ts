/**
 * Tunnel Issuer Client — obtains a permanent named-tunnel grant for this
 * device from the issuer service (see cloud/tunnel-issuer).
 *
 * The issuer is only contacted when no valid local grant exists (first
 * enable, credential loss, address change) — normal tunnel starts
 * are fully offline. Issuance is idempotent server-side: the same device
 * identity always yields the same hostname.
 */

import type { DeviceIdentity } from '../foundation/device-identity'
import { loadProductConfig } from '../foundation/product-config'

export interface NamedTunnelGrant {
  hostname: string
  tunnelId: string
  accountTag: string
  tunnelSecret: string
  issuerUrl: string
  issuedAt: number
}

/**
 * Error from the issuer HTTP exchange. `code` is stable for IPC/UI mapping:
 *   - ISSUER_UNREACHABLE  — network failure / timeout
 *   - ISSUER_RATE_LIMITED — 429, the per-IP daily quota was hit (product
 *     limit, not a fault — the UI must present it as such)
 *   - ISSUER_REJECTED     — 403, device secret mismatch
 *   - ISSUER_ERROR        — unexpected issuer response
 */
export class TunnelIssueError extends Error {
  constructor(
    readonly code: 'ISSUER_UNREACHABLE' | 'ISSUER_RATE_LIMITED' | 'ISSUER_REJECTED' | 'ISSUER_ERROR',
    message: string,
  ) {
    super(message)
    this.name = 'TunnelIssueError'
  }
}

const DEFAULT_ISSUER_URL = 'https://issuer.haloxe.com'
const ISSUE_TIMEOUT_MS = 20000

export function getIssuerUrl(): string {
  return loadProductConfig().tunnelIssuerUrl || DEFAULT_ISSUER_URL
}

/**
 * Request (or re-request) this device's permanent tunnel grant.
 */
export async function issueNamedTunnel(identity: DeviceIdentity): Promise<NamedTunnelGrant> {
  const issuerUrl = getIssuerUrl()
  console.log(`[TunnelIssuer] Requesting grant from ${issuerUrl} for device ${identity.deviceId}`)

  let response: Response
  try {
    response = await fetch(`${issuerUrl}/v1/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: identity.deviceId,
        deviceSecret: identity.deviceSecret,
      }),
      signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
    })
  } catch (err) {
    const msg = (err as Error).message
    console.error('[TunnelIssuer] Issuer unreachable:', msg)
    throw new TunnelIssueError('ISSUER_UNREACHABLE', `Tunnel issuer unreachable: ${msg}`)
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null

  if (response.status === 429) {
    console.warn('[TunnelIssuer] Rate limited by issuer (daily per-IP quota)')
    throw new TunnelIssueError('ISSUER_RATE_LIMITED', 'Tunnel issuer daily quota reached for this network')
  }

  if (response.status === 403) {
    const reason = (body?.error as string) || '403'
    console.error(`[TunnelIssuer] Issuer rejected request: ${reason}`)
    throw new TunnelIssueError('ISSUER_REJECTED', `Tunnel issuer rejected the request: ${reason}`)
  }

  if (
    !response.ok ||
    !body ||
    typeof body.hostname !== 'string' ||
    typeof body.tunnelId !== 'string' ||
    typeof body.accountTag !== 'string' ||
    typeof body.tunnelSecret !== 'string'
  ) {
    console.error(`[TunnelIssuer] Unexpected issuer response (status ${response.status})`)
    throw new TunnelIssueError('ISSUER_ERROR', `Unexpected issuer response (status ${response.status})`)
  }

  console.log(`[TunnelIssuer] Grant received: ${body.hostname} (reissued: ${body.reissued === true})`)
  return {
    hostname: body.hostname,
    tunnelId: body.tunnelId,
    accountTag: body.accountTag,
    tunnelSecret: body.tunnelSecret,
    issuerUrl,
    issuedAt: Date.now(),
  }
}

/**
 * Release this device's hostname and tunnel at the issuer. The next
 * issue after a successful revoke yields a brand-new hostname — this is
 * the "change my address" primitive.
 */
export async function revokeNamedTunnel(identity: DeviceIdentity): Promise<void> {
  const issuerUrl = getIssuerUrl()
  console.log(`[TunnelIssuer] Revoking grant at ${issuerUrl} for device ${identity.deviceId}`)

  let response: Response
  try {
    response = await fetch(`${issuerUrl}/v1/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: identity.deviceId,
        deviceSecret: identity.deviceSecret,
      }),
      signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
    })
  } catch (err) {
    const msg = (err as Error).message
    console.error('[TunnelIssuer] Issuer unreachable during revoke:', msg)
    throw new TunnelIssueError('ISSUER_UNREACHABLE', `Tunnel issuer unreachable: ${msg}`)
  }

  if (response.status === 429) {
    throw new TunnelIssueError('ISSUER_RATE_LIMITED', 'Tunnel issuer daily quota reached for this network')
  }
  if (response.status === 403) {
    throw new TunnelIssueError('ISSUER_REJECTED', 'Tunnel issuer rejected the revoke request')
  }
  if (!response.ok) {
    throw new TunnelIssueError('ISSUER_ERROR', `Unexpected issuer response (status ${response.status})`)
  }

  console.log('[TunnelIssuer] Grant revoked')
}
