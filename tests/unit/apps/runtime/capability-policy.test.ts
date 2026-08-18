/**
 * Unit tests for the capability policy shared by IM guests and teammates.
 *
 * The load-bearing property is zero regression: a team that never opened the
 * screen must behave exactly as it did before the screen existed. The second is
 * that the two scenarios read silence differently — a stranger gets nothing
 * unless granted, an invited teammate loses only what was taken away.
 */

import { describe, it, expect } from 'vitest'
import {
  ALL_BUILTIN_TOOLS,
  DELEGABLE_BUILTIN_TOOLS,
  computeDisallowedBuiltins,
  fullCapabilityPolicy,
} from '../../../../src/shared/apps/capability-policy'
import { filterMcpServersByPolicy, isBorrowedTeamTurn } from '../../../../src/main/apps/runtime/capability-policy'

const ALL_MCP = {
  'web-search': {},
  'halo-memory': {},
  'ocr': {},
  'ai-browser': {},
  'ai-terminal': {},
  'halo-email': {},
  'halo-team': {},
  'halo-report': {},
  'my-mcp': {},
}
const DB_MCP = { 'my-mcp': {} }
/** What app-chat pins for a team turn: the channel the turn rides, not a capability. */
const TEAM_CHANNEL = new Set(['halo-team', 'halo-report'])

describe('built-in tool restriction', () => {
  it('takes nothing away from a teammate until a switch is turned off', () => {
    expect(computeDisallowedBuiltins(undefined, 'permissive')).toEqual([])
    expect(computeDisallowedBuiltins(fullCapabilityPolicy(), 'permissive')).toEqual([])
  })

  it('takes away exactly the tool a teammate switch turned off', () => {
    const policy = fullCapabilityPolicy()
    policy.allowedTools = policy.allowedTools!.filter(t => t !== 'Bash')

    expect(computeDisallowedBuiltins(policy, 'permissive')).toEqual(['Bash'])
  })

  it('never withholds a tool the screen does not offer', () => {
    const offered = new Set(DELEGABLE_BUILTIN_TOOLS.map(t => t.name))
    const withheld = computeDisallowedBuiltins({ allowedTools: [] }, 'permissive')

    expect(withheld.every(t => offered.has(t))).toBe(true)
    expect(withheld).not.toContain('Task')
  })

  it('grants a guest nothing it was not explicitly given', () => {
    expect(computeDisallowedBuiltins(undefined, 'strict').sort()).toEqual([...ALL_BUILTIN_TOOLS].sort())
    expect(computeDisallowedBuiltins({ allowedTools: ['Read'] }, 'strict')).not.toContain('Read')
    expect(computeDisallowedBuiltins({ allowedTools: ['Read'] }, 'strict')).toContain('Bash')
  })
})

describe('MCP server injection', () => {
  it('leaves a teammate every server until something is switched off', () => {
    // The team's own coordination tools are the channel the turn arrives on, so
    // the caller pins them; everything else is a capability the tables classify.
    const out = filterMcpServersByPolicy(ALL_MCP, DB_MCP, undefined, 'permissive', TEAM_CHANNEL)

    expect(Object.keys(out).sort()).toEqual(Object.keys(ALL_MCP).sort())
  })

  it('withholds only the capability a teammate switch turned off', () => {
    const out = filterMcpServersByPolicy(ALL_MCP, DB_MCP, { allowAiBrowser: false }, 'permissive')

    expect(out).not.toHaveProperty('ai-browser')
    expect(out).toHaveProperty('halo-email')
    expect(out).toHaveProperty('my-mcp')
  })

  it('withholds a user-installed server once the list becomes explicit', () => {
    const out = filterMcpServersByPolicy(ALL_MCP, DB_MCP, { allowedUserMcp: [] }, 'permissive')
    expect(out).not.toHaveProperty('my-mcp')
  })

  it('keeps the team’s own coordination tools whatever the policy says', () => {
    const out = filterMcpServersByPolicy(
      ALL_MCP,
      DB_MCP,
      { allowAiBrowser: false, allowEmail: false, allowOcr: false, allowedUserMcp: [] },
      'permissive',
      new Set(['halo-team', 'halo-report'])
    )

    expect(out).toHaveProperty('halo-team')
    expect(out).toHaveProperty('halo-report')
  })

  it('withholds the terminal from a teammate whose owner withheld commands', () => {
    // Two ways to run a command on the owner's machine; withholding one while
    // granting the other is the owner believing a door is shut that is open.
    // The owner takes commands away by unticking the command tool — never by
    // knowing there is a second server behind it.
    const noCommands = fullCapabilityPolicy()
    noCommands.allowedTools = noCommands.allowedTools!.filter(t => t !== 'Bash')
    delete noCommands.allowTerminal

    const out = filterMcpServersByPolicy(ALL_MCP, DB_MCP, noCommands, 'permissive', TEAM_CHANNEL)

    expect(out).not.toHaveProperty('ai-terminal')
    expect(out).toHaveProperty('ai-browser')
  })

  it('keeps the terminal when the owner left commands on', () => {
    const out = filterMcpServersByPolicy(ALL_MCP, DB_MCP, fullCapabilityPolicy(), 'permissive', TEAM_CHANNEL)
    expect(out).toHaveProperty('ai-terminal')
  })

  it('lets an explicit terminal switch overrule the command tool it follows', () => {
    const commandsOnTerminalOff = { ...fullCapabilityPolicy(), allowTerminal: false }
    expect(filterMcpServersByPolicy(ALL_MCP, DB_MCP, commandsOnTerminalOff, 'permissive', TEAM_CHANNEL))
      .not.toHaveProperty('ai-terminal')
  })

  it('never injects a capability the owner was offered no switch for', () => {
    const withNewServer = { ...ALL_MCP, 'some-future-capability': {} }

    expect(filterMcpServersByPolicy(withNewServer, DB_MCP, undefined, 'permissive', TEAM_CHANNEL))
      .not.toHaveProperty('some-future-capability')
    expect(filterMcpServersByPolicy(withNewServer, DB_MCP, {}, 'strict'))
      .not.toHaveProperty('some-future-capability')
  })

  it('gives a guest only the always-safe servers by default', () => {
    const out = filterMcpServersByPolicy(ALL_MCP, DB_MCP, {}, 'strict')

    expect(Object.keys(out).sort()).toEqual(['halo-memory', 'web-search'])
  })

  it('keeps a guest away from OCR until the host allows it', () => {
    expect(filterMcpServersByPolicy(ALL_MCP, DB_MCP, {}, 'strict')).not.toHaveProperty('ocr')
    expect(filterMcpServersByPolicy(ALL_MCP, DB_MCP, { allowOcr: true }, 'strict')).toHaveProperty('ocr')
  })

  it('never lends a guest the terminal on the strength of another switch', () => {
    // A teammate's unset switch inherits from the command tool; a guest's must
    // not. Their policies were saved when no terminal switch existed, so
    // inheriting would grant a capability the owner was never shown — and there
    // is no second prompt behind it: an injected MCP server is simply usable.
    const guestWithCommands = { allowedTools: ['Bash', 'Read'] }

    expect(filterMcpServersByPolicy(ALL_MCP, DB_MCP, guestWithCommands, 'strict'))
      .not.toHaveProperty('ai-terminal')
    // Only an explicit yes opens it.
    expect(filterMcpServersByPolicy(ALL_MCP, DB_MCP, { ...guestWithCommands, allowTerminal: true }, 'strict'))
      .toHaveProperty('ai-terminal')
  })
})

describe('who a delegated policy holds', () => {
  // The limit is about what may happen on the OWNER's machine, so the question
  // is who started the turn — not whether a person or a model typed it.
  it('does not restrict the owner talking to their own digital human', () => {
    // The owner's chat is delivered straight to the session and carries no kind.
    expect(isBorrowedTeamTurn(undefined, false)).toBe(false)
  })

  it('restricts another PERSON reaching it from a different machine', () => {
    expect(isBorrowedTeamTurn('human_message', false)).toBe(true)
  })

  it('restricts a teammate’s digital human', () => {
    expect(isBorrowedTeamTurn('message', false)).toBe(true)
  })

  it('restricts the turns the runtime starts on the team’s behalf', () => {
    expect(isBorrowedTeamTurn('run_start', false)).toBe(true)
    expect(isBorrowedTeamTurn('periodic_check', false)).toBe(true)
  })

  it('leaves an IM-backed turn to the IM hardening decision', () => {
    expect(isBorrowedTeamTurn('human_message', true)).toBe(false)
    expect(isBorrowedTeamTurn('message', true)).toBe(false)
  })
})
