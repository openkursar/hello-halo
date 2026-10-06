/**
 * A config file that exists but cannot be read is reported, and saving it is
 * reported as not saved.
 *
 * The write-back guard already kept such a file intact. What was missing is
 * that nobody was told: Halo looked freshly installed, and settings entered
 * again seemed to save while nothing reached the disk.
 */

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'

vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))
vi.mock('../../../src/main/services/api-validator.service', () => ({
  validateApiConnection: vi.fn(),
  fetchModelsFromApi: vi.fn(),
}))

import {
  getConfigPath,
  getConfigReadFailure,
  isConfigUnreadable,
  saveConfig,
} from '../../../src/main/foundation/config.service'
import { getConfig as loadSettings, setConfig } from '../../../src/main/controllers/config.controller'

const CORRUPT = '{"aiSources": {"version": 2, "sources": [ — cut off mid-write'

function writeRaw(text: string): void {
  fs.writeFileSync(getConfigPath(), text)
}

describe('unreadable config file', () => {
  it('is not reported before a config file exists (first run)', () => {
    if (fs.existsSync(getConfigPath())) fs.rmSync(getConfigPath())

    expect(getConfigReadFailure()).toBeNull()
    expect(isConfigUnreadable()).toBe(false)
  })

  it('is reported with its location, and a save leaves it untouched and says so', () => {
    writeRaw(CORRUPT)

    expect(getConfigReadFailure()).toEqual({ path: getConfigPath() })

    saveConfig({ appearance: { theme: 'dark' } })
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe(CORRUPT)
    expect(isConfigUnreadable()).toBe(true)

    const result = setConfig({ appearance: { theme: 'dark' } })
    expect(result).toMatchObject({ success: false, code: 'CONFIG_UNREADABLE' })
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe(CORRUPT)
  })

  it('clears once the file reads again, and saving works again', () => {
    writeRaw(CORRUPT)
    expect(getConfigReadFailure()).not.toBeNull()

    writeRaw(JSON.stringify({ appearance: { theme: 'light' } }))

    expect(getConfigReadFailure()).toBeNull()
    expect(setConfig({ appearance: { theme: 'dark' } }).success).toBe(true)
    expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')).appearance.theme).toBe('dark')
  })
})

describe('settings loaded while the file could not be read', () => {
  const instance = (id: string) => ({ id, type: 'wecom-bot', enabled: true, appId: `app-${id}` })
  const onDisk = { imChannels: { instances: [instance('a'), instance('b')] } }

  function diskInstanceIds(): string[] {
    const saved = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
    return saved.imChannels.instances.map((i: { id: string }) => i.id)
  }

  it('cannot be saved back once the file reads again, so the channels on disk survive', () => {
    writeRaw(JSON.stringify(onDisk))
    const beforeFailure = loadSettings().configEpoch

    // A transient failure at load time: the app gets the defaults, with no channels.
    writeRaw(CORRUPT)
    const duringFailure = loadSettings()
    expect(duringFailure.configEpoch).toBe(-1)
    expect((duringFailure.data as { imChannels?: unknown }).imChannels).toBeUndefined()

    // The file reads again, and the user adds a bot on top of what the app shows.
    writeRaw(JSON.stringify(onDisk))
    const stale = setConfig({ imChannels: { instances: [instance('new')] } }, duringFailure.configEpoch)

    expect(stale).toMatchObject({ success: false, code: 'CONFIG_RELOAD_REQUIRED' })
    expect(diskInstanceIds()).toEqual(['a', 'b'])

    // Settings loaded before the failure are refused too: changes refused
    // during it may have been applied to them on screen.
    expect(setConfig({ imChannels: { instances: [instance('new')] } }, beforeFailure))
      .toMatchObject({ code: 'CONFIG_RELOAD_REQUIRED' })
    expect(diskInstanceIds()).toEqual(['a', 'b'])
  })

  it('can be saved again after the app reloads them', () => {
    writeRaw(CORRUPT)
    loadSettings()
    writeRaw(JSON.stringify(onDisk))

    const reloaded = loadSettings()
    const instances = (reloaded.data as typeof onDisk).imChannels.instances
    const result = setConfig({ imChannels: { instances: [...instances, instance('new')] } }, reloaded.configEpoch)

    expect(result.success).toBe(true)
    expect(diskInstanceIds()).toEqual(['a', 'b', 'new'])
  })
})
