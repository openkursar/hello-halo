/**
 * SMTP port rules for the email channel form.
 *
 * The mail library connects to 465 when SSL/TLS is on and to 587 otherwise
 * whenever no port is set, so the form shows that port as the real value
 * instead of a placeholder: what the user sees is what is used.
 */

const SSL_PORT = 465
const STARTTLS_PORT = 587

export function defaultSmtpPort(secure: boolean): number {
  return secure ? SSL_PORT : STARTTLS_PORT
}

/** A usable port, or null for empty, 0, non-integer and out-of-range input. */
export function parseSmtpPort(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d+$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

/** The port the connection uses: the stored one, else the default for the encryption setting. */
export function effectiveSmtpPort(stored: unknown, secure: boolean): number {
  return parseSmtpPort(stored) ?? defaultSmtpPort(secure)
}

/**
 * The port to store after the SSL/TLS switch flips. A port still at the
 * previous setting's default follows the switch; one the user chose stays.
 */
export function smtpPortAfterSecureChange(stored: unknown, wasSecure: boolean): number | undefined {
  const port = parseSmtpPort(stored)
  if (port === null) return undefined
  return port === defaultSmtpPort(wasSecure) ? defaultSmtpPort(!wasSecure) : port
}
