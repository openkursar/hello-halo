export const MAX_BYTES = 10 * 1024 * 1024
export const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }

/** A page or request the site sent off its own hosts, which in practice is its sign-in page. */
export function redirectedAway(target?: string): never {
  let host = ''
  try { host = target ? new URL(target).host : '' } catch { /* Reported without a host. */ }
  return fail('HOST_REDIRECTED', `The site redirected this request${host ? ` to ${host}` : ''}, usually to its sign-in page. Sign in to the site in the Halo browser, then retry.`)
}
