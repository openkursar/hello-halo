import type { Options } from '@hello-halo/agent-sdk'
import { buildRequestIdentity, type IdentityParams } from '../request-identity-factory'

/** The native runtime supplies only the identity callback's requested user text. */
export function setup(options: Options, identity?: IdentityParams): Options {
  return identity ? { ...options, requestIdentity: buildRequestIdentity(identity) } : options
}
