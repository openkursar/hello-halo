import { describe, expect, it } from 'vitest'
import { accountSaveFailureReason } from '../../../src/renderer/components/settings/account-save-error'

describe('account save failure diagnostics', () => {
  it('keeps a useful failure reason', () => {
    expect(accountSaveFailureReason(new Error('Permission denied while writing settings'))).toBe('Permission denied while writing settings')
  })

  it('removes the account credentials even when their format is unfamiliar', () => {
    const secret = 'fictional-private-value'
    expect(accountSaveFailureReason(new Error(`Key ${secret} was refused`), [secret])).toBe('Key [redacted] was refused')
  })

  it('removes endpoints, authentication values and account addresses', () => {
    const message = 'Request https://user:pass@example.invalid/api?token=private failed; Authorization: Bearer private-value; access_token=other-value user@example.invalid'
    const reason = accountSaveFailureReason(message)
    for (const secret of ['user:pass', 'token=private', 'private-value', 'other-value', 'user@example.invalid']) expect(reason).not.toContain(secret)
    expect(reason).toContain('failed')
  })

  it('keeps a bounded single log line instead of serializing payloads', () => {
    expect(accountSaveFailureReason({ apiKey: 'private' })).toBe('Unknown failure')
    expect(accountSaveFailureReason(new Error(`Disk failure\n${'no space '.repeat(100)}`))).not.toContain('\n')
    expect(accountSaveFailureReason('failed '.repeat(100))).toHaveLength(500)
  })
})
