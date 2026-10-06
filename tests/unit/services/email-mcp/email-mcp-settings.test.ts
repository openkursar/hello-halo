/**
 * The email tools keep the settings they were built from for the whole
 * session, so a digital-human conversation whose email settings changed is
 * rebuilt at its next message instead of going on with the old ones.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string) => ({ name }),
  createSdkMcpServer: (options: { name: string }) => ({ type: 'sdk', name: options.name, instance: {} }),
  getActiveEngine: vi.fn(() => 'claude'),
  getEngineCapabilities: vi.fn(() => null),
}))
vi.mock('../../../../src/main/foundation/product-config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServiceDefaults: () => undefined,
}))

import type { EmailChannelConfig } from '../../../../src/shared/types/notification-channels'
import { createEmailMcpServer } from '../../../../src/main/services/email-mcp'
import { computeSessionInputsFingerprint } from '../../../../src/main/services/agent/sdk-config'

const settings = (smtp: Partial<EmailChannelConfig['smtp']> = {}, extra: Partial<EmailChannelConfig> = {}): EmailChannelConfig => ({
  enabled: true,
  smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'me@example.com', password: 'old', ...smtp },
  defaultTo: '',
  ...extra,
})

const sessionInputs = (config: EmailChannelConfig) =>
  computeSessionInputsFingerprint({ systemPrompt: 'p', mcpServers: { 'halo-email': createEmailMcpServer(config) } })

describe('email tools in the session inputs', () => {
  it('make a session built with other email settings out of date', () => {
    expect(sessionInputs(settings({ password: 'new' }))).not.toBe(sessionInputs(settings()))
    expect(sessionInputs(settings({ host: 'mail.example.com' }))).not.toBe(sessionInputs(settings()))
    expect(sessionInputs(settings({}, { caldavUrl: 'https://{host}/dav/' }))).not.toBe(sessionInputs(settings()))
  })

  it('keep a session built with the same settings current', () => {
    expect(sessionInputs(settings())).toBe(sessionInputs(settings()))
  })

  it('hand the engine the server exactly as the SDK built it', () => {
    expect(createEmailMcpServer(settings())).toEqual({ type: 'sdk', name: 'halo-email', instance: {} })
  })
})
