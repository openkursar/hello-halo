/**
 * Legacy maxTurns upgrade — configs saved while the default was 50 carry that
 * value without the user having chosen it. Startup raises it once; a value the
 * user sets afterwards is never touched again.
 */

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'

vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

import { initializeApp, getConfigPath, getConfig } from '../../../src/main/foundation/config.service'
import { DEFAULT_MAX_TURNS, LEGACY_DEFAULT_MAX_TURNS } from '../../../src/shared/constants/agent-limits'

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
}

function writeAgent(agent: Record<string, unknown>): void {
  const config = readConfig()
  config.agent = agent
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
}

describe('legacy maxTurns upgrade', () => {
  it('raises the legacy default and keeps the rest of the agent block', async () => {
    await initializeApp()
    writeAgent({ maxTurns: LEGACY_DEFAULT_MAX_TURNS, sdkEngine: 'halo' })

    await initializeApp()

    expect(readConfig().agent).toEqual({
      maxTurns: DEFAULT_MAX_TURNS,
      sdkEngine: 'halo',
      maxTurnsDefaultUpgraded: true,
    })
    expect(getConfig().agent?.maxTurns).toBe(DEFAULT_MAX_TURNS)
  })

  it('leaves a value the user chose', async () => {
    await initializeApp()
    writeAgent({ maxTurns: 200 })

    await initializeApp()

    expect(readConfig().agent.maxTurns).toBe(200)
  })

  it('runs once: the legacy value set again afterwards sticks', async () => {
    await initializeApp()
    writeAgent({ maxTurns: LEGACY_DEFAULT_MAX_TURNS })
    await initializeApp()

    writeAgent({ ...readConfig().agent, maxTurns: LEGACY_DEFAULT_MAX_TURNS })
    await initializeApp()

    expect(readConfig().agent.maxTurns).toBe(LEGACY_DEFAULT_MAX_TURNS)
  })

  it('defaults a fresh install to the shared default', async () => {
    await initializeApp()

    expect(getConfig().agent?.maxTurns).toBe(DEFAULT_MAX_TURNS)
  })
})
