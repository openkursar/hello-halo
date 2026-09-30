/**
 * Unit Tests: services/agent/dsh — model selection.
 *
 * The runtime pins one model for the life of a child process, so a wrong id
 * here is not a recoverable turn: every prompt in that session answers on a
 * model the user did not choose.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  DSH_FALLBACK_MODEL,
  resolveDshModel,
} from '../../../../../src/main/services/agent/dsh/routing'

describe('resolveDshModel', () => {
  afterEach(() => {
    delete process.env.HALO_DSH_DEFAULT_MODEL
  })

  it('prefers the credential model over the SDK option', () => {
    expect(resolveDshModel('option-model', 'deepseek-v4')).toEqual({ model: 'deepseek-v4', fellBack: false })
  })

  it('falls back to the SDK option when credentials name no model', () => {
    expect(resolveDshModel('option-model', undefined)).toEqual({ model: 'option-model', fellBack: false })
  })

  it('sends a claude-named model as-is, since the endpoint decides the dialect', () => {
    // An OpenAI-compatible gateway serving claude ids is an ordinary Halo
    // source; rewriting the id would answer on a model nobody selected.
    expect(resolveDshModel(undefined, 'claude-sonnet-4-5')).toEqual({
      model: 'claude-sonnet-4-5',
      fellBack: false,
    })
  })

  it('falls back only when no source named a model at all', () => {
    expect(resolveDshModel(undefined, undefined)).toEqual({
      model: DSH_FALLBACK_MODEL,
      fellBack: true,
    })
  })

  it('honours the environment override for the fallback', () => {
    process.env.HALO_DSH_DEFAULT_MODEL = 'deepseek-v4-flash'
    expect(resolveDshModel(undefined, undefined)).toEqual({ model: 'deepseek-v4-flash', fellBack: true })
  })
})
