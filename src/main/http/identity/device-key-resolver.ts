/**
 * Device-key resolver: proves "the presenter holds the private key for an
 * identity". This is currently the only resolver; SSO / internet credentials
 * are future resolvers that plug into the same registry.
 */

import { createPublicKey, verify } from 'crypto'

import type { AuthProof, Identity, IdentityResolver } from './types'
import { deriveIdentityId } from './device-key'

const LOG_TAG = '[Identity]'

/**
 * Proof shape carried by the 'device-key' method. The presenter sends their
 * public key plus a signature over a challenge; the resolver checks that the
 * key derives to the claimed id and that the signature verifies.
 */
interface DeviceKeyProof extends AuthProof {
  method: 'device-key'
  identityId: string
  /** SPKI PEM of the presenter's public key. */
  publicKey: string
  displayName?: string
  /** Challenge bytes, base64. */
  challenge: string
  /** Ed25519 signature over the challenge, base64. */
  signature: string
}

function isDeviceKeyProof(proof: AuthProof): proof is DeviceKeyProof {
  return (
    proof.method === 'device-key' &&
    typeof (proof as DeviceKeyProof).identityId === 'string' &&
    typeof (proof as DeviceKeyProof).publicKey === 'string' &&
    typeof (proof as DeviceKeyProof).challenge === 'string' &&
    typeof (proof as DeviceKeyProof).signature === 'string'
  )
}

export class DeviceKeyResolver implements IdentityResolver {
  readonly method = 'device-key'

  resolve(proof: AuthProof): Identity | null {
    if (!isDeviceKeyProof(proof)) {
      return null
    }

    // The public key must derive to the claimed identity id — single source of
    // truth via deriveIdentityId, so the formula is never duplicated.
    let derivedId: string
    try {
      derivedId = deriveIdentityId(proof.publicKey)
    } catch (error) {
      console.warn(`${LOG_TAG} device-key proof has an unreadable public key`, (error as Error).message)
      return null
    }
    if (derivedId !== proof.identityId) {
      console.warn(`${LOG_TAG} device-key proof rejected: public key does not match identity id`)
      return null
    }

    let signatureValid = false
    try {
      const publicKey = createPublicKey(proof.publicKey)
      signatureValid = verify(
        null,
        Buffer.from(proof.challenge, 'base64'),
        publicKey,
        Buffer.from(proof.signature, 'base64')
      )
    } catch (error) {
      console.warn(`${LOG_TAG} device-key signature verification failed`, (error as Error).message)
      return null
    }
    if (!signatureValid) {
      console.warn(`${LOG_TAG} device-key proof rejected: invalid signature`)
      return null
    }

    return {
      id: proof.identityId,
      displayName: proof.displayName ?? proof.identityId,
    }
  }
}
