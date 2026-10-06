/**
 * Unit tests for apps/runtime/turn-skills — which skills a borrowed turn may
 * load, and why a granted one may still not.
 *
 * Owners allow skills one by one; a skill grants nothing beyond itself. The
 * engine honours what a loaded skill brings with it — tools pre-approved for
 * the rest of the turn, hooks, a sub-agent of its own — without asking the
 * per-call gate, so those are measured here against what the turn was already
 * allowed. The ceiling below is the real one: the options `applyCapabilityPolicy`
 * leaves on the session.
 */

import { describe, it, expect } from 'vitest'
import {
  decideSkillCall,
  grantedSkillFolders,
  inertCommandText,
  turnSkillAccess,
} from '../../../../src/main/apps/runtime/turn-skills'
import { applyCapabilityPolicy } from '../../../../src/main/apps/runtime/capability-policy'
import { FILE_TOOLS } from '../../../../src/main/apps/runtime/turn-file-access'
import type { CapabilityMode, CapabilityPolicy } from '../../../../src/shared/apps/capability-policy'
import type { AvailableSkill } from '../../../../src/shared/apps/app-types'

function skill(dirName: string, frontmatter = '', name = dirName): AvailableSkill {
  return {
    name,
    description: '',
    scope: 'global',
    dirName,
    path: `/skills/${dirName}`,
    content: `---\nname: ${name}\n${frontmatter}---\n\nDo the thing.\n`,
  }
}

/** The turn's skills, measured against the options the policy really leaves on the session. */
function access(available: AvailableSkill[], policy: CapabilityPolicy, mode: CapabilityMode = 'strict') {
  const options: Record<string, any> = {}
  applyCapabilityPolicy(options, { policy, mode, mcpServers: {}, dbMcpServers: null, keepFileTools: mode === 'strict' })
  return turnSkillAccess(available, policy, mode, {
    allowedRules: options.allowedTools ?? [],
    disallowed: options.disallowedTools ?? [],
    hooked: mode === 'strict' ? ['Skill', ...FILE_TOOLS] : ['Skill'],
  })
}

const call = (a: ReturnType<typeof access>, name: string) => decideSkillCall(a, { skill: name })

/** A guest allowed to look at files and to run one listed command. */
const LISTED_COMMANDS: CapabilityPolicy = {
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  bashScope: 'listed',
  bashRules: ['npm run:*'],
}

describe('which skill a call means', () => {
  const skills = [skill('weekly-report', '', 'Weekly Report'), skill('place-order')]
  const guest = access(skills, { allowedTools: ['Read'], allowedSkills: ['weekly-report'] })

  it('loads a skill the owner allowed, by either name the engine answers to', () => {
    expect(call(guest, 'weekly-report')).toEqual({ allow: true })
    expect(call(guest, 'Weekly Report')).toEqual({ allow: true })
    expect(call(guest, '/weekly-report')).toEqual({ allow: true })
  })

  it('refuses one the owner did not allow, and says which ones it may use', () => {
    const decision = call(guest, 'place-order')

    expect(decision.allow).toBe(false)
    expect(decision).toMatchObject({ reason: expect.stringContaining('Skills available here: weekly-report.') })
  })

  it('refuses a skill no switch was ever shown for (built into the engine, from a plugin)', () => {
    expect(call(guest, 'simplify').allow).toBe(false)
    expect(call(guest, '').allow).toBe(false)
  })

  it('refuses a name that could also mean a skill that was not allowed', () => {
    // The engine takes the first command answering to the name, by either of
    // its names; which one that is cannot be told from here.
    const tangled = access(
      [skill('report', '', 'Report'), skill('Report')],
      { allowedTools: [], allowedSkills: ['report'] }
    )

    expect(call(tangled, 'Report').allow).toBe(false)
    expect(call(tangled, 'report').allow).toBe(true)
  })

  it('lets a teammate whose skills were never listed load any skill, and holds a written list', () => {
    expect(call(access(skills, {}, 'permissive'), 'place-order')).toEqual({ allow: true })
    expect(call(access(skills, {}, 'permissive'), 'simplify')).toEqual({ allow: true })
    expect(call(access(skills, { allowedSkills: ['weekly-report'] }, 'permissive'), 'place-order').allow).toBe(false)
    expect(call(access(skills, { allowedSkills: ['weekly-report'] }, 'permissive'), 'simplify').allow).toBe(false)
  })

  it('holds every copy of a name to the rules: a global and a space skill of the same name are both checked', () => {
    // Which copy the engine loads for a name is its own order; a check of the
    // space copy alone let a global copy with wider pre-approvals load.
    const space = skill('report')
    const global: AvailableSkill = { ...skill('report', 'allowed-tools: Bash\n'), scope: 'global', path: '/global/skills/report' }
    const both = access([space, global], { ...LISTED_COMMANDS, allowedSkills: ['report'] })

    expect(call(both, 'report').allow).toBe(false)
    expect(grantedSkillFolders(both)).toEqual([])

    const plainGlobal: AvailableSkill = { ...skill('report'), scope: 'global', path: '/global/skills/report' }
    const fine = access([space, plainGlobal], { ...LISTED_COMMANDS, allowedSkills: ['report'] })
    expect(call(fine, 'report')).toEqual({ allow: true })
    expect(grantedSkillFolders(fine)).toEqual(['/skills/report', '/global/skills/report'])
  })

  it('opens only the folders of the skills that may load', () => {
    expect(grantedSkillFolders(guest)).toEqual(['/skills/weekly-report'])
    expect(grantedSkillFolders(undefined)).toEqual([])
  })
})

describe('a skill cannot bring more than the request was allowed', () => {
  const allowedAs = (frontmatter: string, policy: CapabilityPolicy = LISTED_COMMANDS) =>
    call(access([skill('tool', frontmatter)], { ...policy, allowedSkills: ['tool'] }), 'tool')

  it('does not load when it pre-approves commands past the owner\'s command list', () => {
    // Loaded, the engine would run those commands for the rest of the turn
    // without the gate ever seeing them.
    for (const tools of ['Bash', 'Bash(*)', 'Bash(python3:*)', 'Read, Bash(curl:*)', '"*"']) {
      const decision = allowedAs(`allowed-tools: ${tools}\n`)
      expect(decision.allow, tools).toBe(false)
      expect(decision, tools).toMatchObject({ reason: expect.stringContaining('more than this request is allowed') })
    }
  })

  it('names what reaches too far, so the owner can tell what to allow', () => {
    expect(allowedAs('allowed-tools: Read, Bash(python3 run.py:*)\n'))
      .toMatchObject({ reason: expect.stringContaining('pre-approves Bash(python3 run.py:*),') })
  })

  it('reads a list in either YAML form, and one split by spaces', () => {
    expect(allowedAs('allowed-tools:\n  - Read\n  - Bash(git push:*)\n').allow).toBe(false)
    expect(allowedAs('allowed-tools: [Read, Bash]\n').allow).toBe(false)
    expect(allowedAs('allowed-tools: Read Bash\n').allow).toBe(false)
  })

  it('reads a frontmatter the engine only reads on its second try', () => {
    // A description with ": " in it is not valid YAML as written; the engine
    // quotes such values and reads it again, so its pre-approvals stand.
    expect(allowedAs('description: Use when: the user asks\nallowed-tools: Bash\n').allow).toBe(false)
    expect(allowedAs('description: Use when: the user asks\nallowed-tools: Read\n').allow).toBe(true)
  })

  it('loads when what it pre-approves is already allowed, or judged on every call anyway', () => {
    expect(allowedAs('allowed-tools: Bash(npm run:*)\n')).toEqual({ allow: true })
    // File tools pass the turn's file boundary call by call; MCP tools exist
    // only where their server was granted.
    expect(allowedAs('allowed-tools: Read, Grep, Glob, Write, mcp__halo-email__email_send\n')).toEqual({ allow: true })
    expect(allowedAs('')).toEqual({ allow: true })
  })

  it('loads when the tool it pre-approves is withheld outright: the withholding wins', () => {
    expect(allowedAs('allowed-tools: Bash, WebFetch, Agent\n', { allowedTools: ['Read'] })).toEqual({ allow: true })
  })

  it('does not load with a pre-approval for a tool no switch covers', () => {
    expect(allowedAs('allowed-tools: PowerShell(Get-ChildItem:*)\n').allow).toBe(false)
  })

  it('does not load with hooks of its own unless any command may run', () => {
    const hooks = 'hooks:\n  PostToolUse:\n    - hooks:\n        - type: command\n          command: ./after.sh\n'

    expect(allowedAs(hooks)).toMatchObject({ allow: false, reason: expect.stringContaining('(hooks)') })
    expect(allowedAs(hooks, { allowedTools: ['Read', 'Bash'] })).toEqual({ allow: true })
  })

  it('does not run as a sub-agent unless sub-agents were allowed', () => {
    expect(allowedAs('context: fork\n')).toMatchObject({ allow: false, reason: expect.stringContaining('sub-agent') })
    expect(allowedAs('context: fork\n', { ...LISTED_COMMANDS, allowedTools: ['Read', 'Agent'] })).toEqual({ allow: true })
  })

  it('does not load when its settings cannot be read', () => {
    const unreadable: AvailableSkill = { ...skill('tool'), content: '---\nname: tool\nallowed-tools: Bash\n' }
    const decision = call(access([unreadable], { ...LISTED_COMMANDS, allowedSkills: ['tool'] }), 'tool')

    expect(decision).toMatchObject({ allow: false, reason: expect.stringContaining('could not be read') })
    expect(grantedSkillFolders(access([unreadable], { ...LISTED_COMMANDS, allowedSkills: ['tool'] }))).toEqual([])
  })
})

describe('a borrowed turn\'s message never runs as a command', () => {
  it('puts a line before a message the engine would run as a command', () => {
    expect(inertCommandText('/place-order 2 coffees'))
      .toBe('[Sent as text: commands are not run directly in this conversation.]\n/place-order 2 coffees')
    expect(inertCommandText('  /clear').startsWith('[Sent as text')).toBe(true)
  })

  it('reads leading space the way the engines do, and only a plain slash as a command', () => {
    // Both engines trim before looking for "/": an ideographic space is trimmed
    // too. A zero-width space or a full-width slash is no command to either.
    expect(inertCommandText('\u3000/x').startsWith('[Sent as text')).toBe(true)
    expect(inertCommandText('\u200B/x')).toBe('\u200B/x')
    expect(inertCommandText('／x')).toBe('／x')
  })

  it('leaves every other message as it was', () => {
    expect(inertCommandText('please /stop that')).toBe('please /stop that')
    expect(inertCommandText('<msg-sender id="u1" name="A" />\n/place-order')).toBe('<msg-sender id="u1" name="A" />\n/place-order')
  })
})
