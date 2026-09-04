/**
 * Email channel seeding — product.json serviceDefaults → config.json.
 *
 * The seed runs once, on first launch, so the settings form opens with real
 * editable values and every consumer (settings test, notification send, email
 * MCP) resolves one identical config.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'

vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

vi.mock('../../../src/main/foundation/product-config', () => ({
  getDataFolderName: vi.fn(() => 'halo'),
  getServiceDefaults: vi.fn(() => undefined),
}))

import { initializeApp, getConfigPath } from '../../../src/main/foundation/config.service'
import { getServiceDefaults } from '../../../src/main/foundation/product-config'

type MockFn = ReturnType<typeof vi.fn>

const EMAIL_DEFAULTS = {
  smtp: { host: 'mail.example.com', port: 465, secure: true },
  caldavUrl: 'https://{host}/dav/users/{email}/default/',
  tlsCiphers: 'AES256-GCM-SHA384',
}

function setServiceDefaults(email: unknown): void {
  ;(getServiceDefaults as unknown as MockFn).mockReturnValue(email ? { email } : undefined)
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
}

describe('email channel seeding', () => {
  beforeEach(() => {
    setServiceDefaults(undefined)
  })

  it('seeds the endpoint as real values, disabled until credentials are filled in', async () => {
    setServiceDefaults(EMAIL_DEFAULTS)

    await initializeApp()

    expect(readConfig().notificationChannels.email).toEqual({
      enabled: false,
      ...EMAIL_DEFAULTS,
    })
  })

  it('writes nothing when the build declares no service defaults', async () => {
    await initializeApp()

    expect(readConfig().notificationChannels).toBeUndefined()
  })

  it('never touches an existing email block, including values the user cleared', async () => {
    await initializeApp()
    const configPath = getConfigPath()
    const userConfig = readConfig()
    userConfig.notificationChannels = {
      email: { enabled: true, smtp: { host: '', port: 0, secure: false, user: 'me@corp.com', password: 'pw' }, defaultTo: 'me@corp.com' },
    }
    fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2))

    setServiceDefaults(EMAIL_DEFAULTS)
    await initializeApp()

    expect(readConfig().notificationChannels.email).toEqual(userConfig.notificationChannels.email)
  })

  it('preserves other channels when seeding', async () => {
    await initializeApp()
    const configPath = getConfigPath()
    const userConfig = readConfig()
    userConfig.notificationChannels = { webhook: { enabled: true, url: 'https://hook.example.com' } }
    fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2))

    setServiceDefaults(EMAIL_DEFAULTS)
    await initializeApp()

    const channels = readConfig().notificationChannels
    expect(channels.webhook).toEqual({ enabled: true, url: 'https://hook.example.com' })
    expect(channels.email.smtp.host).toBe('mail.example.com')
  })
})
