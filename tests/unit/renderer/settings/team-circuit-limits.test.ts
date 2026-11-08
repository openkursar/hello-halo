import { describe, expect, it, vi } from 'vitest'
import { saveTeamCircuitLimitChange } from '../../../../src/renderer/components/settings/team-circuit-limits'
import { TEAM_CIRCUIT_DEFAULTS } from '../../../../src/shared/apps/team-types'

describe('saving team circuit limits from settings', () => {
  it('saves only the changed field, merged over the stored overrides', async () => {
    const save = vi.fn(async () => undefined)

    const saved = await saveTeamCircuitLimitChange(
      { maxMessages: 3000 },
      { maxForwardDepth: 50 },
      save,
    )

    expect(save).toHaveBeenCalledWith({
      teamCircuitLimits: { maxMessages: 3000, maxForwardDepth: 50 },
    })
    expect(saved).toEqual({ maxForwardDepth: 50 })
  })

  it('does not save when the value already matches the saved override', async () => {
    const save = vi.fn()

    expect(await saveTeamCircuitLimitChange({ maxForwardDepth: 50 }, { maxForwardDepth: 50 }, save)).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('does not save when the value already matches the default', async () => {
    const save = vi.fn()

    expect(await saveTeamCircuitLimitChange(
      undefined,
      { maxForwardDepth: TEAM_CIRCUIT_DEFAULTS.maxForwardDepth },
      save,
    )).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('compares each field independently against the saved config', async () => {
    const save = vi.fn(async () => undefined)

    await saveTeamCircuitLimitChange(
      { maxMessages: 3000, maxForwardDepth: 50 },
      { maxMessages: 3000, maxForwardDepth: 100 },
      save,
    )

    expect(save).toHaveBeenCalledWith({
      teamCircuitLimits: { maxMessages: 3000, maxForwardDepth: 100 },
    })
  })
})
