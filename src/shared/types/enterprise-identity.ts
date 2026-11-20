/**
 * Enterprise identity — what the renderer sees of the company sign-in a build
 * may provide (see services/enterprise-identity/DESIGN.md). Never carries a
 * proof, ticket or credential.
 */

export type EnterpriseIdentityStatus =
  /** The build has no enterprise identity, or its provider could not be loaded. */
  | 'unavailable'
  | 'signed-out'
  /** A sign-in is in progress and no earlier session is active. */
  | 'pending'
  | 'ready'
  /** The session ran out; the account is shown until the user signs in again. */
  | 'expired'

export interface EnterpriseIdentityMethod {
  id: string
  /** Display name chosen by the build (already in the user's language). */
  label: string
  kind: 'qr'
  /** What a session from this method may use, e.g. "intranet". */
  capabilities: string[]
}

export interface EnterpriseIdentityAccount {
  id: string
  displayName: string
}

/** A tool the build lets use this identity, and whether it has a credential now. */
export interface EnterpriseIdentityBoundTool {
  toolId: string
  capability: string
  active: boolean
}

export interface EnterpriseIdentityFlowView {
  flowId: string
  methodId: string
  /** Text encoded in the QR code. */
  qrContent: string
  /** 'scanned' once the phone has read the code and the user still has to confirm there. */
  phase: 'waiting' | 'scanned'
  /** Epoch ms when the code stops working. */
  expiresAt: number
  hint?: string
}

export interface EnterpriseIdentityState {
  status: EnterpriseIdentityStatus
  methods: EnterpriseIdentityMethod[]
  account?: EnterpriseIdentityAccount
  /** Method of the current or last session. */
  methodId?: string
  capabilities: string[]
  /** Epoch ms when the session ends. */
  expiresAt?: number
  boundTools: EnterpriseIdentityBoundTool[]
  flow?: EnterpriseIdentityFlowView
  /** A bound tool could not get its credential for this session. */
  lastError?: 'credential-failed'
}

export type EnterpriseLoginOutcome =
  /** Still waiting after the bounded wait; poll again. */
  | 'pending'
  /** The phone read the code; poll again for the confirmation. */
  | 'scanned'
  | 'ready'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'failed'

export interface EnterpriseLoginPollResult {
  outcome: EnterpriseLoginOutcome
  state: EnterpriseIdentityState
  message?: string
}
