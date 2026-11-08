/**
 * Identity of the endpoint a model list belongs to: scheme + host + port.
 * Path edits (adding `/v1`) keep the list; a different origin invalidates it.
 */
export function endpointIdentity(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).origin.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}
