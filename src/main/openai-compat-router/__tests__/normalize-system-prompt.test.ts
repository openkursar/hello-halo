/**
 * Unit Tests for normalizeSystemPrompt
 */

import { describe, it, expect } from 'vitest'
import { normalizeSystemPrompt } from '../utils'
import type { AnthropicRequest } from '../types'

const PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

function req(system: AnthropicRequest['system']): AnthropicRequest {
  return { model: 'test-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], system }
}

describe('normalizeSystemPrompt', () => {
  it('strips the prefix from a string system prompt', () => {
    const { request, modified } = normalizeSystemPrompt(req(`${PREFIX}You are Halo.`))
    expect(modified).toBe(true)
    expect(request.system).toBe('You are Halo.')
  })

  it('trims leading whitespace left after the prefix', () => {
    const { request } = normalizeSystemPrompt(req(`${PREFIX}\n\nYou are Halo.`))
    expect(request.system).toBe('You are Halo.')
  })

  it('strips the prefix from the first text block of an array system prompt', () => {
    const { request, modified } = normalizeSystemPrompt(
      req([
        { type: 'text', text: `${PREFIX}You are Halo.`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'second block' },
      ])
    )
    expect(modified).toBe(true)
    expect(request.system).toEqual([
      { type: 'text', text: 'You are Halo.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'second block' },
    ])
  })

  it('drops the first block when it held only that line', () => {
    const { request, modified } = normalizeSystemPrompt(
      req([
        { type: 'text', text: PREFIX },
        { type: 'text', text: 'You are Halo.' },
      ])
    )
    expect(modified).toBe(true)
    expect(request.system).toEqual([{ type: 'text', text: 'You are Halo.' }])
  })

  it('removes the identity block when it is not the first block', () => {
    const { request, modified } = normalizeSystemPrompt(
      req([
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli;' },
        { type: 'text', text: PREFIX },
        { type: 'text', text: 'You are Halo.' },
      ])
    )
    expect(modified).toBe(true)
    expect(request.system).toEqual([
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli;' },
      { type: 'text', text: 'You are Halo.' },
    ])
  })

  it('leaves the request untouched when the prefix is absent', () => {
    const original = req('You are Halo.')
    const { request, modified } = normalizeSystemPrompt(original)
    expect(modified).toBe(false)
    expect(request).toBe(original)
  })

  it('does not strip when the prefix is not at the start', () => {
    const { modified } = normalizeSystemPrompt(req(`You are Halo.\n${PREFIX}`))
    expect(modified).toBe(false)
  })

  it('handles missing system', () => {
    const { modified } = normalizeSystemPrompt(req(undefined))
    expect(modified).toBe(false)
  })
})
