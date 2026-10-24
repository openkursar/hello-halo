import type { Options } from '@hello-halo/agent-sdk'
import { buildRequestIdentity, type IdentityParams } from '../request-identity-factory'

/** Runs in the SDK worker; identity computation never sends history back to Halo. */
export function setup(options: Options, identity?: IdentityParams): Options {
  return identity ? { ...options, requestIdentity: buildRequestIdentity(identity) } : options
}
