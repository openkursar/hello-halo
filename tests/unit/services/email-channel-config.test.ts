import { describe, expect, it } from 'vitest'
import { normalizeEmailChannelConfig } from '../../../src/shared/email-channel-config'
import type { EmailChannelConfig } from '../../../src/shared/types/notification-channels'

describe('email channel config', () => {
  it('normalizes legacy connection settings without changing the saved credential or inner characters', () => {
    const config: EmailChannelConfig = {
      enabled: true,
      smtp: {
        host: '\u200bsmtp.example.test\u2060', port: 465, secure: true,
        user: '\u00a0owner@example.test ', password: ' w\u200b ord ',
      },
      defaultTo: ' recipient@example.test\u3000',
      caldavUrl: ' https://{host}/dav/{email}/some%20folder/ ',
      tlsCiphers: '\tDEFAULT:!aNULL ',
    }
    const normalized = normalizeEmailChannelConfig(config)
    expect(normalized.smtp).toEqual({ ...config.smtp, host: 'smtp.example.test', user: 'owner@example.test' })
    expect(normalized.defaultTo).toBe('recipient@example.test')
    expect(normalized.caldavUrl).toBe('https://{host}/dav/{email}/some%20folder/')
    expect(normalized.tlsCiphers).toBe('DEFAULT:!aNULL')
    expect(config.smtp.host).toBe('\u200bsmtp.example.test\u2060')
  })

  it('preserves the difference between an unset field and an explicit blank', () => {
    const config: EmailChannelConfig = {
      enabled: true,
      smtp: { host: 'smtp.example.test', port: 465, secure: true, user: '', password: '' },
      defaultTo: '',
      tlsCiphers: '\u200b ',
    }
    const normalized = normalizeEmailChannelConfig(config)
    expect(normalized.caldavUrl).toBeUndefined()
    expect(normalized.tlsCiphers).toBe('')
  })
})
