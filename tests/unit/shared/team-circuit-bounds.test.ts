import { describe, expect, it } from 'vitest'
import { TEAM_CIRCUIT_DEFAULTS, TEAM_CIRCUIT_LIMIT_BOUNDS } from '../../../src/shared/apps/team-types'

describe('team circuit settings bounds', () => {
  it.each(['maxMessages', 'maxForwardDepth'] as const)(
    'the settings input accepts the default %s',
    (key) => {
      expect(TEAM_CIRCUIT_LIMIT_BOUNDS[key].min).toBeLessThanOrEqual(TEAM_CIRCUIT_DEFAULTS[key])
      expect(TEAM_CIRCUIT_LIMIT_BOUNDS[key].max).toBeGreaterThanOrEqual(TEAM_CIRCUIT_DEFAULTS[key])
    },
  )
})
