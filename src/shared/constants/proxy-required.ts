/**
 * The refusal a request gets when Settings requires a proxy for the account
 * and none can be used. The main process words it in English; the marker lets
 * the renderer recognize it inside whatever an engine wraps around it and show
 * it in the interface language.
 */

export type ProxyRequiredReason =
  /** No proxy is configured, or the system's answer was a direct connection. */
  | 'none'
  /** The destination is on the Settings list of hosts reached directly. */
  | 'bypassed'
  /** A proxy is configured but could not be reached. */
  | 'unreachable'

const MARKER = /\[proxy-required:(none|bypassed|unreachable)\]/

const REASON_TEXT: Record<ProxyRequiredReason, string> = {
  none: 'A proxy is required for this account, but none is configured.',
  bypassed: 'A proxy is required for this account, but this address is on the list that skips the proxy.',
  unreachable: 'A proxy is required for this account, but the configured proxy cannot be reached.',
}

/** English refusal text carrying the marker; `detail` names the proxy that failed, when known. */
export function proxyRequiredMessage(reason: ProxyRequiredReason, detail?: string): string {
  const text = detail ? `${REASON_TEXT[reason]} (${detail})` : REASON_TEXT[reason]
  return `${text} [proxy-required:${reason}]`
}

/** The reason when `text` holds a proxy-required refusal, otherwise null. */
export function parseProxyRequired(text: string): ProxyRequiredReason | null {
  const match = MARKER.exec(text)
  return match ? (match[1] as ProxyRequiredReason) : null
}

/** The proxy named in an `unreachable` refusal (`host:port`), when the text carries one. */
export function parseProxyRequiredDetail(text: string): string | null {
  return /\(([^()\s]+)\) \[proxy-required:/.exec(text)?.[1] ?? null
}
