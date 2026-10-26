import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: () => false,
}))

import { getConfig, getConfigPath, saveConfig } from '../../../src/main/foundation/config.service'

beforeEach(() => { mkdirSync(dirname(getConfigPath()), { recursive: true }) })

describe('default engine migration', () => {
  it('uses Halo for a new installation without creating external runtime preferences', () => {
    rmSync(getConfigPath(), { force: true })
    expect(getConfig().agent?.sdkEngine).toBe('halo')
    expect(getConfig().agent?.ccRuntime).toBeUndefined()
  })

  it('uses Halo when the old user never chose an engine, preserving other preferences', () => {
    const previous = { agent: { maxTurns: 87 }, appearance: { theme: 'light' }, customData: { value: 5 } }
    writeFileSync(getConfigPath(), JSON.stringify(previous))
    expect(getConfig().agent).toMatchObject({ maxTurns: 87, sdkEngine: 'halo' })
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toEqual(previous)
    saveConfig({ appearance: { theme: 'dark' } })
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
      agent: { maxTurns: 87, sdkEngine: 'halo' }, customData: { value: 5 },
    })
  })

  it.each(['anthropic', 'halo', 'codex', 'dsh'])('preserves an explicit %s selection', sdkEngine => {
    writeFileSync(getConfigPath(), JSON.stringify({ agent: { sdkEngine } }))
    expect(getConfig().agent?.sdkEngine).toBe(sdkEngine)
  })

  it('preserves an external runtime selection while another agent setting is saved', () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      agent: { sdkEngine: 'anthropic', ccRuntime: { selectedPath: '/test/claude' } },
    }))
    saveConfig({ agent: { maxTurns: 50 } })
    expect(getConfig().agent?.ccRuntime?.selectedPath).toBe('/test/claude')
  })
})
