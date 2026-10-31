import { describe, it, expect } from 'vitest'
import { engineErrorDetail, isEngineSetupError } from '../../../../src/main/services/agent/engine-error'
import { EngineSourceCompatibilityError } from '../../../../src/shared/engine-source'

class EngineUnavailableError extends Error {
  constructor(readonly engineId: string) {
    super(`Engine "${engineId}" is unavailable: The runtime is not installed`)
    this.name = 'EngineUnavailableError'
  }
}

describe('engine setup failures', () => {
  it('marks a missing Claude Code and a Claude Code login account for the chat notice', () => {
    expect(engineErrorDetail(new EngineUnavailableError('anthropic'))).toEqual({ errorType: 'engine_unavailable' })
    expect(engineErrorDetail(new EngineSourceCompatibilityError('halo', 'delegated-requires-cc', 'This account requires Claude Code.'))).toEqual({ errorType: 'engine_unavailable' })
  })

  it('leaves other failures as they are', () => {
    expect(engineErrorDetail(new EngineUnavailableError('dsh'))).toBeUndefined()
    expect(engineErrorDetail(new EngineSourceCompatibilityError('codex', 'codex-unsupported-protocol', 'Codex supports…'))).toBeUndefined()
    expect(engineErrorDetail(new Error('rate limited'))).toBeUndefined()
    expect(engineErrorDetail('Engine "anthropic" is unavailable')).toBeUndefined()
  })

  it('recognizes every unavailable engine for replies outside Halo', () => {
    expect(isEngineSetupError(new EngineUnavailableError('dsh'))).toBe(true)
    expect(isEngineSetupError(new EngineSourceCompatibilityError('codex', 'codex-unsupported-protocol', 'x'))).toBe(false)
  })
})
