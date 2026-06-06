/**
 * Security Policy IPC
 *
 * Exposes the renderer-safe slice of the security policy so the UI can gate
 * features (e.g. hide the Tunnel section when `tunnelSafe` is on). The
 * renderer never receives the full policy — only the closed shape returned by
 * `getPublicSecurityPolicy()`. Policy is sourced from product.json at startup
 * and cannot change at runtime, so the renderer hook caches the response.
 *
 * Registered from the typed RPC contract (auto-envelope).
 */

import { getPublicSecurityPolicy } from '../services/security-policy'
import { securityRpc } from '../../shared/rpc/contracts/security.contract'
import { registerRpcHandlers } from './rpc'

export function registerSecurityHandlers(): void {
  registerRpcHandlers(
    securityRpc,
    {
      getSecurityPolicy: () => getPublicSecurityPolicy(),
    },
    'Security',
  )
  console.log('[Settings] Security handlers registered')
}
