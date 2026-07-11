/**
 * Shared WS-test helper: build a device-key auth proof for the local identity.
 *
 * D10 requires a federation-node WS session to prove its portable identity via a
 * device-key challenge–response (see http/websocket.ts). Real-socket tests inject
 * this as the joiner manager's makeAuthProof so the handshake completes. Host and
 * joiner share ONE in-process identity module, so the proof resolves to
 * getLocalIdentity().id — the same value production binds.
 */

import {
  getLocalIdentity,
  getLocalPublicKeyPem,
  signWithLocalKey,
} from '../../../../../src/main/http/identity/index'

/** A signed device-key proof over the host-issued base64 nonce. */
export function localAuthProof(nonce: string): Record<string, unknown> {
  const identity = getLocalIdentity()
  return {
    method: 'device-key',
    identityId: identity.id,
    publicKey: getLocalPublicKeyPem(),
    displayName: identity.displayName,
    challenge: nonce,
    signature: signWithLocalKey(Buffer.from(nonce, 'base64')).toString('base64'),
  }
}
