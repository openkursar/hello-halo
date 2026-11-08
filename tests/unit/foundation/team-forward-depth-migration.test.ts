/**
 * Legacy team forward-depth cleanup — the settings form used to save both
 * circuit limits together, so configs carry the old default 8 without the user
 * having chosen it. Startup removes exactly that value once.
 */

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'

vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

import { initializeApp, getConfigPath, getConfig } from '../../../src/main/foundation/config.service'
import { LEGACY_TEAM_DEFAULT_FORWARD_DEPTH } from '../../../src/shared/constants/agent-limits'

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
}

function writeAgent(agent: Record<string, unknown>): void {
  const config = readConfig()
  config.agent = agent
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
}

/** Simulates a config saved before this cleanup existed. */
function writeLegacyAgent(agent: Record<string, unknown>): void {
  const config = readConfig()
  config.agent = agent
  delete config.teamForwardDepthDefaultCleared
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
}

describe('legacy team forward depth cleanup', () => {
  it('removes exactly the old default and keeps a sibling override', async () => {
    await initializeApp()
    writeLegacyAgent({ teamCircuitLimits: { maxMessages: 3000, maxForwardDepth: LEGACY_TEAM_DEFAULT_FORWARD_DEPTH } })

    await initializeApp()

    expect(readConfig().agent.teamCircuitLimits).toEqual({ maxMessages: 3000 })
    expect(readConfig().teamForwardDepthDefaultCleared).toBe(true)
    expect(getConfig().agent?.teamCircuitLimits?.maxForwardDepth).toBeUndefined()
  })

  it('drops the overrides block when nothing else was stored', async () => {
    await initializeApp()
    writeLegacyAgent({ teamCircuitLimits: { maxForwardDepth: LEGACY_TEAM_DEFAULT_FORWARD_DEPTH } })

    await initializeApp()

    expect(readConfig().agent).not.toHaveProperty('teamCircuitLimits')
  })

  it('leaves a value the user chose', async () => {
    await initializeApp()
    writeLegacyAgent({ teamCircuitLimits: { maxForwardDepth: 50 } })

    await initializeApp()

    expect(readConfig().agent.teamCircuitLimits).toEqual({ maxForwardDepth: 50 })
  })

  it('runs once: the old value set again afterwards sticks', async () => {
    await initializeApp()
    writeLegacyAgent({ teamCircuitLimits: { maxForwardDepth: LEGACY_TEAM_DEFAULT_FORWARD_DEPTH } })
    await initializeApp()

    writeAgent({ ...readConfig().agent, teamCircuitLimits: { maxForwardDepth: LEGACY_TEAM_DEFAULT_FORWARD_DEPTH } })
    await initializeApp()

    expect(readConfig().agent.teamCircuitLimits).toEqual({ maxForwardDepth: LEGACY_TEAM_DEFAULT_FORWARD_DEPTH })
  })

  it('marks the cleanup as done even without an override to clear', async () => {
    await initializeApp()
    writeLegacyAgent({ maxTurns: 87 })

    await initializeApp()

    expect(readConfig().agent).not.toHaveProperty('teamCircuitLimits')
    expect(readConfig().teamForwardDepthDefaultCleared).toBe(true)
  })
})
