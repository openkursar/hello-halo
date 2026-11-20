import type { RpcResponse } from '../../../shared/rpc/define'

/** The value of a successful call; a refusal becomes an Error with the main-side message. */
export function unwrapIdentity<T>(res: RpcResponse<T>): T {
  if (!res.success || res.data === undefined) throw new Error(res.error || 'Request failed')
  return res.data
}
