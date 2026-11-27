import { trimPastedValue } from './pasted-value'
import type { EmailChannelConfig } from './types/notification-channels'

export function normalizeEmailChannelConfig(config: EmailChannelConfig): EmailChannelConfig {
  const trim = (value: string) => typeof value === 'string' ? trimPastedValue(value) : value
  const { smtp } = config
  return {
    ...config,
    ...(smtp && {
      smtp: { ...smtp, host: trim(smtp.host), user: trim(smtp.user) },
    }),
    defaultTo: trim(config.defaultTo),
    caldavUrl: config.caldavUrl === undefined ? undefined : trim(config.caldavUrl),
    tlsCiphers: config.tlsCiphers === undefined ? undefined : trim(config.tlsCiphers),
  }
}
