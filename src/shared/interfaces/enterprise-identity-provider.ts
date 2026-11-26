/**
 * Contract between Halo and a build's organization sign-in provider (v2).
 *
 * A build that signs users in with an organization identity ships a module and
 * names it in product.json (`enterpriseIdentity.provider`). The module exports
 * a `get…Provider()` function returning this interface.
 *
 * The provider owns everything about signing in: its page (shown by Halo in an
 * isolated window), any QR code or phone confirmation, silent restore on load,
 * renewal, and the proof or ticket it receives. Halo only shows its state,
 * opens its page, and asks it for a short-lived credential for a named
 * audience, which goes to the bound tool's process and nowhere else.
 */

export const ENTERPRISE_IDENTITY_CONTRACT_VERSION = 2

/** A capability the provider can grant, with its display name in the user's language. */
export interface OrgCapabilityInfo {
  id: string
  label: string
}

export interface OrgCapabilityState {
  status: 'ready' | 'expired'
  /** Epoch ms when it stops working, when known. */
  expiresAt?: number
}

export interface OrgProviderSnapshot {
  /** 'restoring' while the provider is still recovering an earlier sign-in after load. */
  phase: 'restoring' | 'settled'
  /**
   * Opaque id of the signed-in person and session. A different value means a
   * different principal even under the same display name; Halo then withdraws
   * every credential of the previous one. A settled snapshot with any
   * capability must provide a non-empty subject. Stays in the main process.
   */
  subject?: string
  /** Display only; never given to the model. */
  account?: { displayName: string }
  /** Capabilities obtained in this or an earlier sign-in; an absent id was never obtained. */
  capabilities: Record<string, OrgCapabilityState>
}

/** How one sign-in attempt ended. */
export type OrgSignInOutcome = 'succeeded' | 'cancelled' | 'expired' | 'failed'

export interface OrgSignInStart {
  flowId: string
  /** https page, or http on a loopback address, that Halo opens in an isolated window. */
  url: string
}

export interface OrgToolCredential {
  token: string
  /** Epoch ms; Halo asks again before then while the capability lasts. */
  expiresAt: number
}

export interface EnterpriseIdentityProvider {
  readonly contractVersion: typeof ENTERPRISE_IDENTITY_CONTRACT_VERSION
  /** Every capability this provider can grant, so "not obtained" differs from "not offered". */
  capabilityCatalog(): OrgCapabilityInfo[]
  snapshot(): OrgProviderSnapshot
  /** Fires whenever the snapshot may have changed. */
  onDidChange(listener: () => void): { dispose(): void }
  beginSignIn(): Promise<OrgSignInStart>
  /**
   * The outcome of one attempt. May be called any time after `beginSignIn`,
   * also after the attempt ended, and always answers the same outcome.
   */
  awaitSignIn(flowId: string): Promise<OrgSignInOutcome>
  cancelSignIn(flowId: string): Promise<void>
  /** Re-check the session, e.g. after the system wakes; the provider decides whether to go online. */
  verify?(): Promise<void>
  /** Whether `signOut('device')` (remove this device's binding) is supported. */
  readonly supportsDeviceUnbind?: boolean
  /** 'session' ends the sign-in; 'device' also removes this device's binding. */
  signOut(scope: 'session' | 'device'): Promise<void>
  /** A credential for one audience; fails when its capability is not ready. */
  issueCredential(audience: string): Promise<OrgToolCredential>
  /**
   * Variables every user session and the AI terminal receive while a capability
   * is ready, so any program — built in or installed by the user — can find the
   * organization's local access point the way it would on a managed computer.
   * Values must not be secrets: a variable may only point at something that
   * checks the current sign-in itself each time it is used.
   */
  sessionEnvironment?(): Record<string, string>
}
