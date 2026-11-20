/**
 * Contract between Halo and a build's enterprise identity provider.
 *
 * A build that signs users in with a company identity ships a module and names
 * it in product.json (`enterpriseIdentity.provider`). The module exports a
 * `get…Provider()` function returning this interface. Halo drives the QR flow
 * and the session lifecycle; the provider alone talks to the company identity
 * service and keeps whatever proof or ticket it receives. Halo only ever asks
 * it for a short-lived credential for a named audience, which it hands to the
 * bound tool's process (never to the model, the prompt or the session).
 */

import type { EnterpriseIdentityMethod } from '../types/enterprise-identity'

export interface EnterpriseLoginStart {
  /** Opaque id of this attempt. */
  flowId: string
  /** Text to encode in the QR code. */
  qrContent: string
  /** Epoch ms when the code stops working. */
  expiresAt: number
  /** Short instruction shown under the code. */
  hint?: string
}

export interface EnterpriseSession {
  accountId: string
  displayName: string
  capabilities: string[]
  /** Epoch ms when the session ends; decided by the identity service. */
  expiresAt: number
}

export type EnterpriseLoginPoll =
  | { status: 'pending' | 'scanned' }
  | { status: 'denied' | 'expired' | 'cancelled'; message?: string }
  | { status: 'confirmed'; session: EnterpriseSession }

export interface EnterpriseToolCredential {
  token: string
  /** Epoch ms; Halo asks again before then while the session lasts. */
  expiresAt: number
}

export interface EnterpriseIdentityProvider {
  methods(): EnterpriseIdentityMethod[]
  beginLogin(methodId: string): Promise<EnterpriseLoginStart>
  /** One short check of an attempt; Halo repeats it at its own pace. */
  pollLogin(flowId: string): Promise<EnterpriseLoginPoll>
  cancelLogin(flowId: string): Promise<void>
  /** A credential for one audience of the confirmed session. */
  issueCredential(audience: string): Promise<EnterpriseToolCredential>
  /** End the session at the identity service and withdraw its credentials. */
  signOut(): Promise<void>
}
