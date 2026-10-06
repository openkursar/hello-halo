/**
 * The SMTP port field shows the port the connection really uses, follows the
 * SSL/TLS switch until the user picks a port of their own, and refuses an
 * empty, zero or out-of-range port instead of letting the mail library pick
 * one silently.
 */

import { describe, expect, it } from 'vitest'
import {
  defaultSmtpPort,
  effectiveSmtpPort,
  parseSmtpPort,
  smtpPortAfterSecureChange,
} from '../../../src/renderer/components/settings/smtp-port'

describe('SMTP port', () => {
  it('defaults to 465 with SSL/TLS and 587 without, as the mail library does', () => {
    expect(defaultSmtpPort(true)).toBe(465)
    expect(defaultSmtpPort(false)).toBe(587)
  })

  it('shows the port actually used when none is stored, including a blank saved as 0', () => {
    expect(effectiveSmtpPort(undefined, false)).toBe(587)
    expect(effectiveSmtpPort(0, false)).toBe(587)
    expect(effectiveSmtpPort(0, true)).toBe(465)
    expect(effectiveSmtpPort(2525, true)).toBe(2525)
  })

  it.each(['', '  ', '0', '-25', '65536', '25.5', 'abc', 0, null, undefined])('rejects %j', (value) => {
    expect(parseSmtpPort(value)).toBeNull()
  })

  it.each([['25', 25], [' 465 ', 465], ['65535', 65535], [587, 587]] as const)('accepts %j', (value, port) => {
    expect(parseSmtpPort(value)).toBe(port)
  })

  it('moves a default port along with the SSL/TLS switch', () => {
    expect(smtpPortAfterSecureChange(587, false)).toBe(465)
    expect(smtpPortAfterSecureChange(465, true)).toBe(587)
  })

  it('keeps a port the user chose when the switch flips', () => {
    expect(smtpPortAfterSecureChange(2525, false)).toBe(2525)
    expect(smtpPortAfterSecureChange(465, false)).toBe(465)
  })

  it('stores nothing when no port was stored, so the shown default keeps following the switch', () => {
    expect(smtpPortAfterSecureChange(undefined, false)).toBeUndefined()
    expect(smtpPortAfterSecureChange(0, true)).toBeUndefined()
  })
})
