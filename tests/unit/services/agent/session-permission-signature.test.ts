/**
 * Unit test: services/agent/permission-handler — computePermissionSignature.
 *
 * A V2 session is keyed by conversationId, and an IM group chat is one
 * conversation shared by every sender. The permission surface is fixed when the
 * subprocess starts, so if it is not part of the reuse key a guest runs on
 * whatever session the previous sender created — in a group with the owner in
 * it, that is an unrestricted session. Every case below is a way two senders
 * can differ that must not collapse into one signature.
 */

import { describe, expect, it } from 'vitest'
import { computePermissionSignature } from '../../../../src/main/services/agent/permission-handler'

/** What app-chat.ts builds for the owner: skip permissions, nothing denied. */
function ownerOptions(): Record<string, any> {
  return {
    permissionMode: 'bypassPermissions',
    extraArgs: { 'dangerously-skip-permissions': true },
    mcpServers: { 'halo-apps': {}, 'web-search': {} },
  }
}

/** What app-chat.ts builds for a guest: inverted whitelist, no skip flag. */
function guestOptions(allowed: string[], mcpServers: Record<string, unknown> = {}): Record<string, any> {
  const builtins = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Task', 'WebFetch', 'Write']
  return {
    permissionMode: 'default',
    extraArgs: {},
    allowedTools: [],
    disallowedTools: builtins.filter((t) => !allowed.includes(t)),
    mcpServers,
  }
}

describe('computePermissionSignature', () => {
  it('separates the owner from a guest', () => {
    expect(computePermissionSignature(guestOptions([]))).not.toBe(
      computePermissionSignature(ownerOptions())
    )
  })

  it('separates two guests with different tool grants', () => {
    expect(computePermissionSignature(guestOptions(['Read']))).not.toBe(
      computePermissionSignature(guestOptions(['Read', 'Bash']))
    )
  })

  it('separates guests by injected MCP servers', () => {
    // MCP control is injection-based: a server the guest cannot use is simply
    // absent, so the server set is part of what the subprocess is granted.
    expect(computePermissionSignature(guestOptions(['Read'], { email: {} }))).not.toBe(
      computePermissionSignature(guestOptions(['Read'], {}))
    )
  })

  it('separates the skip-permissions flag from its absence', () => {
    const withoutSkip = { ...ownerOptions(), extraArgs: {} }

    expect(computePermissionSignature(withoutSkip)).not.toBe(
      computePermissionSignature(ownerOptions())
    )
  })

  it('ignores ordering and object identity', () => {
    // The signature drives session teardown. Reordering a list the caller built
    // by filtering must not look like a permission change and kill a live session.
    const a = { permissionMode: 'default', disallowedTools: ['Write', 'Bash'], mcpServers: { b: {}, a: {} } }
    const b = { permissionMode: 'default', disallowedTools: ['Bash', 'Write'], mcpServers: { a: {}, b: {} } }

    expect(computePermissionSignature(a)).toBe(computePermissionSignature(b))
  })

  it('is stable for the same sender across messages', () => {
    expect(computePermissionSignature(guestOptions(['Read']))).toBe(
      computePermissionSignature(guestOptions(['Read']))
    )
  })

  it('handles options that declare no permission fields', () => {
    // Native chat passes none of these; it must produce one stable value rather
    // than throwing or varying per call.
    expect(computePermissionSignature({})).toBe(computePermissionSignature({}))
  })
})
