/**
 * Unit Tests: services/agent/dsh — credential routing.
 *
 * The runtime posts to `${DEEPSEEK_BASE_URL}/chat/completions`, while Halo
 * stores whatever base URL the user typed for their source. Getting that
 * translation wrong produces an HTTP 404 from the model with nothing in the
 * frame stream to explain it, so the rules are pinned here.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  DSH_FALLBACK_MODEL,
  normalizeChatCompletionsBase,
  resolveDshModel,
} from '../../../../../src/main/services/agent/dsh/routing'

describe('normalizeChatCompletionsBase', () => {
  it('adds /v1 to a bare origin', () => {
    expect(normalizeChatCompletionsBase('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1')
    expect(normalizeChatCompletionsBase('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1')
  })

  it('leaves an explicit API path alone', () => {
    expect(normalizeChatCompletionsBase('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1')
    expect(normalizeChatCompletionsBase('https://gateway.internal/openai/v2')).toBe(
      'https://gateway.internal/openai/v2'
    )
  })

  it('strips a full chat-completions URL back to its prefix', () => {
    expect(normalizeChatCompletionsBase('https://api.deepseek.com/v1/chat/completions')).toBe(
      'https://api.deepseek.com/v1'
    )
  })

  it('drops trailing slashes that would double up on the path', () => {
    expect(normalizeChatCompletionsBase('http://127.0.0.1:8080/v1//')).toBe('http://127.0.0.1:8080/v1')
  })

  it('passes through what it cannot parse rather than guessing', () => {
    expect(normalizeChatCompletionsBase('not a url')).toBe('not a url')
    expect(normalizeChatCompletionsBase(undefined)).toBeUndefined()
  })
})

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

  it('refuses an Anthropic model id the runtime cannot address', () => {
    expect(resolveDshModel(undefined, 'claude-sonnet-4-5')).toEqual({
      model: DSH_FALLBACK_MODEL,
      fellBack: true,
    })
  })

  it('honours the environment override for the fallback', () => {
    process.env.HALO_DSH_DEFAULT_MODEL = 'deepseek-v4-flash'
    expect(resolveDshModel(undefined, undefined)).toEqual({ model: 'deepseek-v4-flash', fellBack: true })
  })
})
