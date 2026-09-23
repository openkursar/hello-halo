/**
 * Unit Tests for normalizeClaudeCodeAttribution and the Claude Code identity it
 * relies on.
 */

import { describe, it, expect } from 'vitest'
import { normalizeClaudeCodeAttribution } from '../../../src/main/openai-compat-router/utils'
import {
  CLAUDE_CODE_USER_AGENT,
  CLAUDE_CODE_VERSION,
  buildAttributionLine,
  computeAttributionFingerprint,
  resolveClaudeCodeUserAgent,
} from '../../../src/main/openai-compat-router/utils/claude-code-identity'
import type { AnthropicRequest } from '../../../src/main/openai-compat-router/types'

describe('computeAttributionFingerprint', () => {
  // Expected values produced by the fingerprint function inside the
  // @anthropic-ai/claude-code 2.1.89 bundle, not by this implementation.
  it.each([
    ['hello there, this is a first message', 'cbf'],
    ['Fix the failing build', '0b9'],
    ['', 'de7'],
  ])('matches the CLI for %j', (text, expected) => {
    expect(computeAttributionFingerprint(text, '2.1.89')).toBe(expected)
  })
})

describe('resolveClaudeCodeUserAgent', () => {
  it.each([
    'claude-cli/2.1.89 (external, cli)',
    'claude-cli/9.0.0 (external, cli)',
  ])('reports the pin for %s', (userAgent) => {
    expect(resolveClaudeCodeUserAgent(userAgent)).toBe(CLAUDE_CODE_USER_AGENT)
  })

  it('passes a non-Claude-Code user-agent through', () => {
    expect(resolveClaudeCodeUserAgent('GitHubCopilotChat/0.39.1')).toBe('GitHubCopilotChat/0.39.1')
  })

  it('supplies the pinned user-agent when none is present', () => {
    expect(resolveClaudeCodeUserAgent(undefined)).toBe(CLAUDE_CODE_USER_AGENT)
  })
})

const STALE = 'x-anthropic-billing-header: cc_version=2.1.89.abc; cc_entrypoint=cli; cch=00000;'

function req(
  system: AnthropicRequest['system'],
  firstUserText = 'hello there, this is a first message'
): AnthropicRequest {
  return {
    model: 'test-model',
    max_tokens: 8,
    messages: [{ role: 'user', content: firstUserText }],
    system,
  }
}

function ccVersionOf(text: string): string {
  return /cc_version=([^;]*)/.exec(text)?.[1] ?? ''
}

describe('normalizeClaudeCodeAttribution', () => {
  it('re-stamps the pinned version on an attribution block', () => {
    const { request, modified } = normalizeClaudeCodeAttribution(req([{ type: 'text', text: STALE }]))
    expect(modified).toBe(true)
    const text = (request.system as Array<{ text: string }>)[0].text
    expect(ccVersionOf(text)).toMatch(new RegExp(`^${CLAUDE_CODE_VERSION.replace(/\./g, '\\.')}\\.[0-9a-f]{3}$`))
  })

  it('keeps every other field of the line intact', () => {
    const line = 'x-anthropic-billing-header: cc_version=2.1.89.abc; cc_entrypoint=sdk-cli; cch=00000; cc_workload=w;'
    const { request } = normalizeClaudeCodeAttribution(req([{ type: 'text', text: line }]))
    const text = (request.system as Array<{ text: string }>)[0].text
    expect(text).toContain('cc_entrypoint=sdk-cli;')
    expect(text).toContain('cch=00000;')
    expect(text).toContain('cc_workload=w;')
  })

  it('derives the same cc_version the halo engine would build for that request', () => {
    const firstUserText = 'a different opening message entirely'
    const { request } = normalizeClaudeCodeAttribution(
      req([{ type: 'text', text: STALE }], firstUserText)
    )
    const text = (request.system as Array<{ text: string }>)[0].text
    expect(ccVersionOf(text)).toBe(ccVersionOf(buildAttributionLine(firstUserText)))
  })

  it('preserves cache_control and sibling blocks', () => {
    const { request } = normalizeClaudeCodeAttribution(
      req([
        { type: 'text', text: STALE, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'You are Halo.' },
      ])
    )
    const blocks = request.system as Array<{ text: string; cache_control?: unknown }>
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1].text).toBe('You are Halo.')
  })

  it('re-stamps a string system prompt', () => {
    const { request, modified } = normalizeClaudeCodeAttribution(req(`${STALE}\nYou are Halo.`))
    expect(modified).toBe(true)
    expect(request.system).toContain('\nYou are Halo.')
    expect(ccVersionOf(request.system as string)).toContain(CLAUDE_CODE_VERSION)
  })

  it('leaves the request untouched when no attribution line is present', () => {
    const original = req([{ type: 'text', text: 'You are Halo.' }])
    const { request, modified } = normalizeClaudeCodeAttribution(original)
    expect(modified).toBe(false)
    expect(request).toBe(original)
  })

  it('is a no-op on a line that already carries the pinned version', () => {
    const firstUserText = 'hello there, this is a first message'
    const original = req([{ type: 'text', text: buildAttributionLine(firstUserText) }], firstUserText)
    const { request, modified } = normalizeClaudeCodeAttribution(original)
    expect(modified).toBe(false)
    expect(request).toBe(original)
  })

  it('re-stamps a line that reports a newer version too', () => {
    const { request, modified } = normalizeClaudeCodeAttribution(
      req([{ type: 'text', text: 'x-anthropic-billing-header: cc_version=9.0.0.abc; cc_entrypoint=cli;' }])
    )
    expect(modified).toBe(true)
    const text = (request.system as Array<{ text: string }>)[0].text
    expect(ccVersionOf(text).startsWith(`${CLAUDE_CODE_VERSION}.`)).toBe(true)
  })

  it('handles a missing system prompt', () => {
    const { modified } = normalizeClaudeCodeAttribution(req(undefined))
    expect(modified).toBe(false)
  })

  describe('deferred-tools listing', () => {
    const LISTING = '<available-deferred-tools>\nWebFetch\n</available-deferred-tools>'
    const FIRST = 'hello there, this is a first message'
    const expected = `${CLAUDE_CODE_VERSION}.${computeAttributionFingerprint(FIRST, CLAUDE_CODE_VERSION)}`

    function stampedVersion(messages: AnthropicRequest['messages']): string {
      const { request } = normalizeClaudeCodeAttribution({
        model: 'test-model',
        max_tokens: 8,
        messages,
        system: [{ type: 'text', text: STALE }],
      })
      return ccVersionOf((request.system as Array<{ text: string }>)[0].text)
    }

    it('skips the listing when it is its own leading message', () => {
      expect(stampedVersion([
        { role: 'user', content: LISTING },
        { role: 'user', content: FIRST },
      ])).toBe(expected)
    })

    it('skips the listing when it leads the first message as a block', () => {
      expect(stampedVersion([
        { role: 'user', content: [{ type: 'text', text: LISTING }, { type: 'text', text: FIRST }] },
      ])).toBe(expected)
    })
  })
})
