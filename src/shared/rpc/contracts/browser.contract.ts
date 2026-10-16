import { rpcMethod } from '../define'

/** Desktop-only cleanup of all shared browser logins, site storage and HTTP cache. */
export const browserRpc = {
  clearBrowserData: rpcMethod<[], void>('browser:clear-data'),
}
