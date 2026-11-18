export function accountSaveFailureReason(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown failure'
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]')
  }
  return message
    .replace(/https?:\/\/[^\s<>"']+/gi, '[endpoint]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|cookie|password)["']?\s*[:=]\s*)["']?[^\s,;}"']+/gi, '$1[redacted]')
    .replace(/\bsk-[a-z\d_-]+/gi, '[redacted]')
    .replace(/\b[a-z\d_+/=-]{32,}\b/gi, '[redacted]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+/g, '[account]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500) || 'Unknown failure'
}
