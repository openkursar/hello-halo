/**
 * computeSessionInputsFingerprint: detects a changed tool set or system prompt
 * so a live app-chat / automation session is rebuilt on the next send instead of
 * silently reusing a subprocess wired with the old capabilities.
 *
 * Regression context: MCP servers and the system prompt are frozen at session
 * creation and are NOT part of the credentials/knowledge fingerprints. Toggling a
 * digital human's AI Browser permission changes both the injected MCP set and the
 * prompt, but the reuse check ignored them — so the change only "took effect" if a
 * fire-and-forget restart happened to win a race (the flaky behavior users saw).
 */

import { describe, expect, it } from 'vitest'
import { computeSessionInputsFingerprint } from '../../../../src/main/services/agent/sdk-config'

describe('computeSessionInputsFingerprint', () => {
  it('is stable for identical inputs', () => {
    const opts = { systemPrompt: 'You are Ada.', mcpServers: { 'web-search': {}, 'halo-memory': {} } }
    expect(computeSessionInputsFingerprint(opts)).toBe(computeSessionInputsFingerprint({ ...opts }))
  })

  it('is order-independent for the MCP server set', () => {
    const a = { systemPrompt: 'p', mcpServers: { 'ai-browser': {}, 'web-search': {} } }
    const b = { systemPrompt: 'p', mcpServers: { 'web-search': {}, 'ai-browser': {} } }
    expect(computeSessionInputsFingerprint(a)).toBe(computeSessionInputsFingerprint(b))
  })

  it('changes when a capability tool is added (browser enabled)', () => {
    const off = { systemPrompt: 'p', mcpServers: { 'web-search': {}, 'halo-memory': {} } }
    const on = { systemPrompt: 'p', mcpServers: { 'web-search': {}, 'halo-memory': {}, 'ai-browser': {} } }
    expect(computeSessionInputsFingerprint(off)).not.toBe(computeSessionInputsFingerprint(on))
  })

  it('changes when the system prompt changes (prompt/config edit)', () => {
    const before = { systemPrompt: 'You are Ada.', mcpServers: { 'web-search': {} } }
    const after = { systemPrompt: 'You are Ada. Disabled: Email.', mcpServers: { 'web-search': {} } }
    expect(computeSessionInputsFingerprint(before)).not.toBe(computeSessionInputsFingerprint(after))
  })

  it('ignores in-process server object identity (only names matter)', () => {
    const a = { systemPrompt: 'p', mcpServers: { 'ai-browser': { instance: {} } } }
    const b = { systemPrompt: 'p', mcpServers: { 'ai-browser': { instance: {}, other: 1 } } }
    expect(computeSessionInputsFingerprint(a)).toBe(computeSessionInputsFingerprint(b))
  })

  it('handles missing mcpServers / systemPrompt without throwing', () => {
    expect(() => computeSessionInputsFingerprint({})).not.toThrow()
    expect(computeSessionInputsFingerprint({})).toBe(computeSessionInputsFingerprint({ mcpServers: {} }))
  })

  it('changes when permissionMode differs (owner bypass vs guest default)', () => {
    const owner = { systemPrompt: 'p', mcpServers: { 'web-search': {} }, permissionMode: 'bypassPermissions' }
    const guest = { systemPrompt: 'p', mcpServers: { 'web-search': {} }, permissionMode: 'default' }
    expect(computeSessionInputsFingerprint(owner)).not.toBe(computeSessionInputsFingerprint(guest))
  })

  it('changes when the guest disallowedTools blacklist differs', () => {
    const a = { systemPrompt: 'p', mcpServers: { 'web-search': {} }, permissionMode: 'default', disallowedTools: ['Bash', 'Write'] }
    const b = { systemPrompt: 'p', mcpServers: { 'web-search': {} }, permissionMode: 'default', disallowedTools: ['Bash'] }
    expect(computeSessionInputsFingerprint(a)).not.toBe(computeSessionInputsFingerprint(b))
  })

  it('is order-independent for the disallowedTools set', () => {
    const a = { systemPrompt: 'p', disallowedTools: ['Bash', 'Write', 'Read'] }
    const b = { systemPrompt: 'p', disallowedTools: ['Read', 'Bash', 'Write'] }
    expect(computeSessionInputsFingerprint(a)).toBe(computeSessionInputsFingerprint(b))
  })

  it('changes when the dangerously-skip-permissions extra arg is dropped (guest)', () => {
    const owner = { systemPrompt: 'p', extraArgs: { 'dangerously-skip-permissions': true } }
    const guest = { systemPrompt: 'p', extraArgs: {} }
    expect(computeSessionInputsFingerprint(owner)).not.toBe(computeSessionInputsFingerprint(guest))
  })
})
