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
  ALWAYS_AVAILABLE_BUILTIN_TOOLS,
  DEFAULT_GUEST_ALLOWED_TOOLS,
  SKILL_TOOL,
  allowsBuiltinAtCallTime,
  allowsSkill,
  canonicalBuiltinTool,
  capabilityPolicyFromPreset,
  defaultGuestPolicy,
  withGuestAccess,
  DELEGABLE_BUILTIN_TOOLS,
  allowsCapability,
  buildAllowedToolRules,
  computeDisallowedBuiltins,
  fullCapabilityPolicy,
  isRestrictivePolicy,
  resolveBashAccess,
  grantsEverything,
  colleagueReach,
  intersectPolicies,
} from '../../../../src/shared/apps/capability-policy'
import {
  applyCapabilityPolicy,
  describeWithheld,
  filterMcpServersByPolicy,
  isBorrowedTeamTurn,
} from '../../../../src/main/apps/runtime/capability-policy'
import type { TeamTriggerContext } from '../../../../src/shared/apps/team-types'

const ALL_MCP = {
  'web-search': {},
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
    // The task list is the one exception: it touches nothing outside the turn.
    expect(computeDisallowedBuiltins(undefined, 'strict').sort())
      .toEqual([...ALL_BUILTIN_TOOLS].filter(name => name !== 'TodoWrite').sort())
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

  it('never lends another caller the conversation tools, whatever they were granted', () => {
    // Reading and messaging the owner's other conversations is the owner's own
    // decision per digital human; no delegated switch reaches it.
    const withTools = { ...ALL_MCP, 'halo-conversations': {} }
    const everything = fullCapabilityPolicy()

    expect(filterMcpServersByPolicy(withTools, DB_MCP, undefined, 'permissive', TEAM_CHANNEL)).not.toHaveProperty('halo-conversations')
    expect(filterMcpServersByPolicy(withTools, DB_MCP, everything, 'permissive', TEAM_CHANNEL)).not.toHaveProperty('halo-conversations')
    expect(filterMcpServersByPolicy(withTools, DB_MCP, {}, 'strict')).not.toHaveProperty('halo-conversations')
    expect(filterMcpServersByPolicy(withTools, DB_MCP, everything, 'strict')).not.toHaveProperty('halo-conversations')
  })

  it('gives a guest only the always-safe servers by default', () => {
    const out = filterMcpServersByPolicy(ALL_MCP, DB_MCP, {}, 'strict')

    expect(Object.keys(out).sort()).toEqual(['web-search'])
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
  // The question is where THIS turn's request came from — read from its own
  // trigger, never from what the session did before.
  it('does not restrict the owner talking to their own digital human', () => {
    expect(isBorrowedTeamTurn({ kind: undefined }, false)).toBe(false)
  })

  it('does not restrict the owner’s own digital humans working for each other', () => {
    expect(isBorrowedTeamTurn({ kind: 'message' }, false)).toBe(false)
  })

  it('does not restrict the turns the runtime starts here', () => {
    for (const kind of ['run_start', 'periodic_check', 'member_stopped'] as const) {
      expect(isBorrowedTeamTurn({ kind }, false)).toBe(false)
    }
  })

  it('restricts a request from another machine, whatever its presentation kind', () => {
    const kinds: Array<TeamTriggerContext['kind']> = [undefined, 'message', 'human_message', 'periodic_check', 'invalid' as never]
    for (const kind of kinds) {
      expect(isBorrowedTeamTurn({ kind, origin: 'colleague' }, false)).toBe(true)
    }
  })

  it('restricts a guest’s request reaching a member', () => {
    expect(isBorrowedTeamTurn({ kind: 'message', origin: 'guest' }, false)).toBe(true)
  })

  it('leaves the person in an IM chat a member fronts to that chat’s owner/guest rules', () => {
    expect(isBorrowedTeamTurn({ kind: 'human_message' }, true)).toBe(false)
    expect(isBorrowedTeamTurn({ kind: 'human_message', origin: 'guest' }, true)).toBe(false)
  })

  it('leaves a front-desk turn woken by the owner’s own work as it was', () => {
    expect(isBorrowedTeamTurn({ kind: 'message' }, true)).toBe(false)
  })

  it('restricts a front-desk turn woken to continue a request from outside', () => {
    expect(isBorrowedTeamTurn({ kind: 'message', origin: 'colleague' }, true)).toBe(true)
    expect(isBorrowedTeamTurn({ kind: 'periodic_check', origin: 'guest' }, true)).toBe(true)
  })
})

describe('how far the command tool reaches', () => {
  it('reads a policy written before command rules existed as before', () => {
    // The whole compatibility question: 'Bash' granted and nothing said about
    // its reach used to mean "any command", and must keep meaning that.
    expect(resolveBashAccess({ allowedTools: ['Bash'] }, 'permissive')).toEqual({ scope: 'full', rules: [] })
    expect(resolveBashAccess(undefined, 'permissive')).toEqual({ scope: 'full', rules: [] })
    expect(resolveBashAccess(undefined, 'strict')).toEqual({ scope: 'none', rules: [] })
  })

  it('grants nothing when the whitelist is empty', () => {
    // "I picked the whitelist and have not written a rule yet" must not read as
    // "anything goes" — the safe reading of an unfinished decision.
    const access = resolveBashAccess({ allowedTools: ['Bash'], bashScope: 'listed' }, 'permissive')
    expect(access).toEqual({ scope: 'listed', rules: [] })
    expect(buildAllowedToolRules({ allowedTools: ['Bash'], bashScope: 'listed' }, 'strict')).toEqual(['TodoWrite'])
  })

  it('narrowing reach cannot resurrect a withheld tool', () => {
    expect(resolveBashAccess({ allowedTools: [], bashScope: 'full' }, 'strict').scope).toBe('none')
  })

  it('hands command patterns to the engine untouched', () => {
    const policy = {
      allowedTools: ['Read', 'Bash'],
      bashScope: 'listed' as const,
      bashRules: ['npm run:*', 'git log *', ' ', 'npm run:*'],
    }
    const rules = buildAllowedToolRules(policy, 'strict')

    expect(rules).toContain('Read')
    // Deduplicated and blank-stripped, but otherwise verbatim: the engine is
    // what matches them, and it is the only thing that splits a chained command.
    expect(rules.filter(r => r.startsWith('Bash('))).toEqual(['Bash(npm run:*)', 'Bash(git log *)'])
  })

  it('closes the terminal whenever commands are limited', () => {
    // A terminal runs whatever is typed into it, so no command rule reaches it.
    const listed = { allowedTools: ['Bash'], bashScope: 'listed' as const, bashRules: ['ls'], allowTerminal: true }
    expect(allowsCapability(listed, 'allowTerminal', 'permissive')).toBe(false)
    expect(filterMcpServersByPolicy(ALL_MCP, DB_MCP, listed, 'permissive', TEAM_CHANNEL))
      .not.toHaveProperty('ai-terminal')
  })
})

describe('when a policy is enforced at all', () => {
  it('leaves a teammate turn on the engine fast path while nothing is withheld', () => {
    expect(isRestrictivePolicy(undefined, 'permissive')).toBe(false)
    expect(isRestrictivePolicy(fullCapabilityPolicy(), 'permissive')).toBe(false)

    const options: Record<string, any> = { extraArgs: { 'dangerously-skip-permissions': null }, permissionMode: 'bypassPermissions' }
    const applied = applyCapabilityPolicy(options, {
      policy: fullCapabilityPolicy(),
      mode: 'permissive',
      mcpServers: ALL_MCP,
      dbMcpServers: DB_MCP,
      alwaysKeep: TEAM_CHANNEL,
    })

    expect(applied.enforced).toBe(false)
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(options.extraArgs['dangerously-skip-permissions']).toBe(null)
  })

  it('always enforces for a caller whose silence means no', () => {
    expect(isRestrictivePolicy(fullCapabilityPolicy(), 'strict')).toBe(true)
  })

  it('takes away BOTH ways of bypassing the permission engine', () => {
    // Either one alone leaves the command rules unevaluated, so a whitelist
    // would be accepted and silently ignored.
    const options: Record<string, any> = { extraArgs: { 'dangerously-skip-permissions': null }, permissionMode: 'bypassPermissions' }
    applyCapabilityPolicy(options, {
      policy: { allowedTools: ['Read'] },
      mode: 'strict',
      mcpServers: ALL_MCP,
      dbMcpServers: DB_MCP,
    })

    expect(options.permissionMode).toBe('default')
    expect(options.extraArgs['dangerously-skip-permissions']).toBeUndefined()
    expect(options.allowedTools).toEqual(['TodoWrite', 'Read'])
    expect(options.disallowedTools).toContain('Bash')
  })
})

describe('a policy never re-opens a tool the session already withholds', () => {
  it('keeps the user\'s disabled tools when it grants them', () => {
    // The policy allows Read and Grep, but the user disabled Grep everywhere.
    const options: Record<string, any> = { disallowedTools: ['Grep', 'TeamCreate'] }
    applyCapabilityPolicy(options, {
      policy: { allowedTools: ['Read', 'Grep'] },
      mode: 'strict',
      mcpServers: ALL_MCP,
      dbMcpServers: DB_MCP,
    })

    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Grep', 'TeamCreate', 'Bash']))
    expect(new Set(options.disallowedTools).size).toBe(options.disallowedTools.length)
  })

  it('withholds the policy\'s own tools when the session withheld nothing', () => {
    const options: Record<string, any> = {}
    applyCapabilityPolicy(options, {
      policy: { allowedTools: ['Read'] },
      mode: 'strict',
      mcpServers: ALL_MCP,
      dbMcpServers: DB_MCP,
    })
    expect(options.disallowedTools).toContain('Bash')
  })
})

describe('granting everything', () => {
  const inventory = { skills: ['pdf', 'xlsx'], userMcp: ['my-mcp'] }

  it('the "everything" preset grants everything, with or without an inventory', () => {
    expect(grantsEverything(fullCapabilityPolicy())).toBe(true)
    expect(grantsEverything(fullCapabilityPolicy(), inventory)).toBe(true)
    expect(grantsEverything({ ...fullCapabilityPolicy(), allowChecks: false } as never, inventory)).toBe(true)
  })

  it('a list naming everything this machine has grants everything; one missing a name does not', () => {
    const listed = { ...fullCapabilityPolicy(), allowedSkills: ['pdf', 'xlsx'], allowedUserMcp: ['my-mcp'] }
    expect(grantsEverything(listed, inventory)).toBe(true)
    expect(grantsEverything({ ...listed, allowedSkills: ['pdf'] }, inventory)).toBe(false)
    expect(grantsEverything({ ...listed, allowedUserMcp: [] }, inventory)).toBe(false)
    // Without an inventory a written list cannot be shown to cover anything.
    expect(grantsEverything(listed)).toBe(false)
  })

  it('anything switched off, or commands narrowed to a list, is not everything', () => {
    const full = fullCapabilityPolicy()
    expect(grantsEverything({ ...full, allowedTools: full.allowedTools!.filter(t => t !== 'WebFetch') }, inventory)).toBe(false)
    expect(grantsEverything({ ...full, allowAiBrowser: false }, inventory)).toBe(false)
    expect(grantsEverything({ ...full, bashScope: 'listed', bashRules: ['ls'] }, inventory)).toBe(false)
    // Unset switches read strictly: silence is not "on".
    expect(grantsEverything({ allowedTools: full.allowedTools, bashScope: 'full' }, inventory)).toBe(false)
    // The old name of the sub-agent tool grants nothing at run time, so it does not count here either.
    expect(grantsEverything({ ...full, allowedTools: [...full.allowedTools!.filter(t => t !== 'Agent'), 'Task'] }, inventory)).toBe(false)
  })

  it('the presets short of everything are read strictly', () => {
    expect(grantsEverything(capabilityPolicyFromPreset('read_only'), inventory)).toBe(false)
    expect(grantsEverything(capabilityPolicyFromPreset('workspace'), inventory)).toBe(false)
    expect(grantsEverything(capabilityPolicyFromPreset('full'), inventory)).toBe(true)
  })

  it('reads what is installed only when every switch is on, and only for a list actually written', () => {
    let reads = 0
    const counted = { get skills() { reads++; return ['pdf', 'xlsx'] }, userMcp: ['my-mcp'] }
    grantsEverything(capabilityPolicyFromPreset('read_only'), counted)
    grantsEverything({ ...capabilityPolicyFromPreset('workspace'), allowedSkills: ['pdf'] }, counted)
    grantsEverything(fullCapabilityPolicy(), counted)
    expect(reads).toBe(0)

    expect(grantsEverything({ ...fullCapabilityPolicy(), allowedSkills: ['pdf', 'xlsx'] }, counted)).toBe(true)
    expect(reads).toBe(1)
  })

  it('a colleague reads an unsaved policy, or one granting everything, as full reach', () => {
    expect(colleagueReach(null)).toBe('full')
    expect(colleagueReach(undefined)).toBe('full')
    expect(colleagueReach(fullCapabilityPolicy(), inventory)).toBe('full')
    expect(colleagueReach(capabilityPolicyFromPreset('read_only'), inventory)).toBe('strict')
    expect(colleagueReach({}, inventory)).toBe('strict')
  })
})

describe('what two settings both allow', () => {
  it('keeps only the tools, switches, skills and installed servers both grant', () => {
    const member = { ...fullCapabilityPolicy(), allowedSkills: ['pdf', 'xlsx'], allowedUserMcp: ['a', 'b'] }
    const chat = { allowedTools: ['Read', 'Glob', 'Grep', 'Task'], allowAiBrowser: true, allowEmail: false, allowedSkills: ['pdf'], allowedUserMcp: ['b', 'c'] }
    const both = intersectPolicies(member, chat)
    expect(both.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Agent'])
    expect(both.allowAiBrowser).toBe(true)
    expect(both.allowEmail).toBe(false)
    expect(both.allowOcr).toBe(false)
    expect(both.allowedSkills).toEqual(['pdf'])
    expect(both.allowedUserMcp).toEqual(['b'])
    expect(resolveBashAccess(both, 'strict').scope).toBe('none')
  })

  it('reads silence on either side as a refusal', () => {
    const both = intersectPolicies(fullCapabilityPolicy(), {})
    expect(computeDisallowedBuiltins(both, 'strict')).toEqual(ALL_BUILTIN_TOOLS.filter(t => !ALWAYS_AVAILABLE_BUILTIN_TOOLS.includes(t)))
    expect(filterMcpServersByPolicy(ALL_MCP, DB_MCP, both, 'strict', TEAM_CHANNEL)).toEqual({ 'web-search': {}, 'halo-team': {}, 'halo-report': {} })
    // The member's saved "everything" never lends a stranger more than nothing.
    expect(grantsEverything(both, { skills: [], userMcp: [] })).toBe(false)
  })

  it('takes the narrower command reach, and meets two whitelists rule by rule', () => {
    const full = { allowedTools: ['Bash'], bashScope: 'full' as const }
    const listed = (rules: string[]) => ({ allowedTools: ['Bash'], bashScope: 'listed' as const, bashRules: rules })
    expect(resolveBashAccess(intersectPolicies(full, full), 'strict')).toEqual({ scope: 'full', rules: [] })
    expect(resolveBashAccess(intersectPolicies(full, listed(['ls'])), 'strict')).toEqual({ scope: 'listed', rules: ['ls'] })
    expect(resolveBashAccess(intersectPolicies(listed(['git log *', 'ls']), full), 'strict')).toEqual({ scope: 'listed', rules: ['git log *', 'ls'] })
    expect(resolveBashAccess(intersectPolicies(listed(['ls', 'npm run:*']), listed(['npm run:*', 'pwd'])), 'strict'))
      .toEqual({ scope: 'listed', rules: ['npm run:*'] })
    // A command two different rules would each allow is refused rather than guessed at.
    expect(resolveBashAccess(intersectPolicies(listed(['npm run:*']), listed(['npm run build'])), 'strict'))
      .toEqual({ scope: 'listed', rules: [] })
    expect(resolveBashAccess(intersectPolicies(full, { allowedTools: [] }), 'strict').scope).toBe('none')
    // A terminal needs unrestricted commands on both sides.
    expect(allowsCapability(intersectPolicies({ ...full, allowTerminal: true }, { ...listed(['ls']), allowTerminal: true }), 'allowTerminal', 'strict')).toBe(false)
  })
})

describe('what a restricted turn is told is off', () => {
  const offered = { ...ALL_MCP }
  const describe_ = (policy: Parameters<typeof applyCapabilityPolicy>[1]['policy'], fileBoundary = true) => {
    const options: Record<string, any> = {}
    const applied = applyCapabilityPolicy(options, { policy, mode: 'strict', mcpServers: offered, dbMcpServers: DB_MCP, alwaysKeep: TEAM_CHANNEL, keepFileTools: fileBoundary })
    return describeWithheld({ policy, mode: 'strict', applied, offered, dbMcpServers: DB_MCP, fileBoundary })
  }

  it('names commands, skills, capabilities, installed tools and file reach', () => {
    const items = describe_(undefined)
    expect(items).toContain('running commands')
    expect(items).toContain('skills')
    expect(items).toContain('AI Browser')
    expect(items).toContain('Terminal')
    expect(items).toContain('the installed tool "my-mcp"')
    expect(items).toContain('reading files, except your memory and the files handed to you')
    expect(items).toContain('editing files, except your memory')
    expect(items).not.toContain('files outside this workspace')
  })

  it('says what a granted tool cannot reach, and what a command whitelist leaves out', () => {
    const items = describe_({ allowedTools: ['Read', 'Glob', 'Grep', 'Bash'], bashScope: 'listed', bashRules: ['ls'] })
    expect(items).toContain('running commands other than "ls"')
    expect(items).toContain('files outside this workspace')
    expect(items.some(item => item.startsWith('reading the output of a command left running in the background'))).toBe(true)
    expect(items.some(item => item.startsWith('reading files'))).toBe(false)
  })

  it('lists no capability the digital human never had', () => {
    const items = describeWithheld({
      policy: undefined, mode: 'strict', fileBoundary: false,
      applied: applyCapabilityPolicy({}, { policy: undefined, mode: 'strict', mcpServers: { 'halo-team': {} }, dbMcpServers: null, alwaysKeep: TEAM_CHANNEL }),
      offered: { 'halo-team': {} }, dbMcpServers: null,
    })
    expect(items).not.toContain('AI Browser')
    expect(items).not.toContain('Email')
  })
})

describe('always-available tools', () => {
  it('keeps the task list for every caller, whatever the policy', () => {
    expect(computeDisallowedBuiltins({ allowedTools: [] }, 'strict')).not.toContain('TodoWrite')
    expect(allowsBuiltinAtCallTime({ allowedTools: [] }, 'TodoWrite', 'strict')).toBe(true)
    expect(DELEGABLE_BUILTIN_TOOLS.map(t => t.name)).not.toContain('TodoWrite')
  })

  it('defaults a newly opened guest access to looking at files', () => {
    expect([...DEFAULT_GUEST_ALLOWED_TOOLS]).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('a build default wins, an explicit empty list included', () => {
    expect(defaultGuestPolicy(undefined)).toEqual({ allowedTools: ['Read', 'Glob', 'Grep'] })
    expect(defaultGuestPolicy({})).toEqual({ allowedTools: ['Read', 'Glob', 'Grep'] })
    expect(defaultGuestPolicy({ allowedTools: ['WebSearch'] })).toEqual({ allowedTools: ['WebSearch'] })
    expect(defaultGuestPolicy({ allowedTools: [] })).toEqual({ allowedTools: [] })
    // A copy: editing it never edits the default.
    expect(defaultGuestPolicy(undefined).allowedTools).not.toBe(DEFAULT_GUEST_ALLOWED_TOOLS)
  })

  it('turning guest access off and on again restores the choices made', () => {
    const chosen = { allowedTools: ['Read', 'WebFetch'], allowOcr: true }
    const off = withGuestAccess({ id: 'x', guestPolicy: chosen }, false, { allowedTools: [] })
    expect(off).toEqual({ id: 'x', guestPolicy: undefined, savedGuestPolicy: chosen })
    const on = withGuestAccess(off, true, { allowedTools: [] })
    expect(on).toEqual({ id: 'x', guestPolicy: chosen })
    expect('savedGuestPolicy' in on).toBe(false)
  })

  it('a first turn-on starts from the build default', () => {
    expect(withGuestAccess({ id: 'x', guestPolicy: undefined }, true, null).guestPolicy).toEqual({ allowedTools: ['Read', 'Glob', 'Grep'] })
    expect(withGuestAccess({ id: 'x', guestPolicy: undefined }, true, { allowedTools: [] }).guestPolicy).toEqual({ allowedTools: [] })
  })

  it('the read-only preset grants viewing and the internet only', () => {
    expect(capabilityPolicyFromPreset('read_only').allowedTools).toEqual(
      DELEGABLE_BUILTIN_TOOLS.filter(t => t.group === 'file' || t.group === 'network').map(t => t.name)
    )
  })
})

describe('the sub-agent switch', () => {
  // The engine still answers to the tool's old name, "Task", and a rule naming
  // it acts on the sub-agent tool. Left without a switch, "Task" stayed withheld
  // and took the tool away whatever the owner ticked.
  it('grants the tool under both of its names once a guest is allowed sub-agents', () => {
    const withheld = computeDisallowedBuiltins({ allowedTools: ['Read', 'Agent'] }, 'strict')

    expect(withheld).not.toContain('Agent')
    expect(withheld).not.toContain('Task')
    expect(allowsBuiltinAtCallTime({ allowedTools: ['Agent'] }, 'Task', 'strict')).toBe(true)
  })

  it('withholds both names while the switch is off', () => {
    const withheld = computeDisallowedBuiltins({ allowedTools: ['Read'] }, 'strict')

    expect(withheld).toEqual(expect.arrayContaining(['Agent', 'Task']))
    expect(allowsBuiltinAtCallTime({ allowedTools: ['Read'] }, 'Task', 'strict')).toBe(false)
  })
})

describe('skills', () => {
  it('gives a guest the skill tool only once some skill was allowed', () => {
    // It was withheld from every guest whatever the owner did: there was no
    // switch for it, and a strict policy withholds what no switch grants.
    expect(computeDisallowedBuiltins({ allowedTools: ['Read'], allowedSkills: ['weekly-report'] }, 'strict'))
      .not.toContain('Skill')
    expect(computeDisallowedBuiltins({ allowedTools: ['Read'] }, 'strict')).toContain('Skill')
    expect(computeDisallowedBuiltins({ allowedTools: ['Read'], allowedSkills: [] }, 'strict')).toContain('Skill')
  })

  it('reads silence like the other lists: none for a guest, all for a teammate', () => {
    expect(allowsSkill(undefined, 'weekly-report', 'strict')).toBe(false)
    expect(allowsSkill({ allowedSkills: ['weekly-report'] }, 'weekly-report', 'strict')).toBe(true)
    expect(allowsSkill({ allowedSkills: ['weekly-report'] }, 'place-order', 'strict')).toBe(false)
    expect(allowsSkill(undefined, 'place-order', 'permissive')).toBe(true)
    expect(allowsSkill({ allowedSkills: [] }, 'place-order', 'permissive')).toBe(false)
  })

  it('leaves a teammate with every skill until skills are listed, and enforces a list once there is one', () => {
    expect(computeDisallowedBuiltins(fullCapabilityPolicy(), 'permissive')).toEqual([])
    expect(computeDisallowedBuiltins({ allowedSkills: [] }, 'permissive')).toEqual(['Skill'])
    expect(isRestrictivePolicy({ ...fullCapabilityPolicy(), allowedSkills: ['weekly-report'] }, 'permissive')).toBe(true)
  })

  it('is never auto-allowed: each call is decided per skill by the gate', () => {
    const policy = { allowedTools: ['Read'], allowedSkills: ['weekly-report'] }

    expect(buildAllowedToolRules(policy, 'strict').some(rule => rule.startsWith(SKILL_TOOL))).toBe(false)
    expect(allowsBuiltinAtCallTime(policy, SKILL_TOOL, 'strict')).toBe(false)
  })
})

describe('the switches and the withheld list are one definition', () => {
  it('a guest with every switch on is withheld only the tools no switch offers', () => {
    const everySwitch = { ...fullCapabilityPolicy(), allowedSkills: ['weekly-report'] }
    const offered = (name: string) =>
      ALWAYS_AVAILABLE_BUILTIN_TOOLS.includes(name) ||
      name === SKILL_TOOL ||
      DELEGABLE_BUILTIN_TOOLS.some(t => t.name === canonicalBuiltinTool(name))

    const withheld = computeDisallowedBuiltins(everySwitch, 'strict')

    expect(withheld.sort()).toEqual(ALL_BUILTIN_TOOLS.filter(name => !offered(name)).sort())
    expect(withheld).not.toContain('Task')
    expect(withheld).not.toContain('Skill')
  })
})


it('removes self-API administrator credentials when delegated policy withholds its manual', () => {
  const options: Record<string, any> = {
    env: { HALO_API_URL: 'http://127.0.0.1:1234', HALO_API_TOKEN: 'test-secret', HALO_SPACE_ID: 'space', PATH: '/bin' },
    mcpServers: { 'halo-api-ref': {} },
  }
  applyCapabilityPolicy(options, { policy: undefined, mode: 'strict', mcpServers: options.mcpServers, dbMcpServers: null })
  expect(options.env).toEqual({ PATH: '/bin' })
  expect(options.mcpServers).not.toHaveProperty('halo-api-ref')
})
