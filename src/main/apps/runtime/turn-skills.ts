/**
 * Which skills a borrowed turn may load — the skill-by-skill half of the
 * per-call gate (delegation-gate), and the folders that open to the turn's
 * file boundary (turn-file-access).
 *
 * The engine loads a skill two ways a policy has to answer for:
 *
 *   the skill tool   judged here, on every call, before the engine's own
 *                    permission flow — which loads a skill that brings no
 *                    pre-approvals of its own without ever asking the gate
 *   "/name" typed    the engine runs a message starting with "/" as the command
 *                    it names, with no tool call anything could judge; a borrowed
 *                    turn's message never reaches it in that form
 *                    ({@link inertCommandText})
 *
 * A skill grants nothing beyond itself. Each tool call it makes is judged by
 * the policy like any other. What the engine lets a loaded skill do WITHOUT
 * asking — run the tools its `allowed-tools` pre-approve for the rest of the
 * turn, run its own hooks, run itself as a sub-agent — must already be within
 * the policy, or the skill does not load.
 */

import { parse as parseYaml } from 'yaml'
import { allowsSkill, canonicalBuiltinTool } from '../../../shared/apps/capability-policy'
import type { CapabilityMode, CapabilityPolicy } from '../../../shared/apps/capability-policy'
import type { AvailableSkill } from '../../../shared/apps/app-types'

/** A skill the engine can load for this turn. */
export interface TurnSkill {
  /** Its folder name: what the engine registers it as, and what a policy lists */
  dirName: string
  /** Its frontmatter name, which the engine answers to as well */
  name: string
  /** Its folder */
  path: string
  /** Allowed by the policy */
  granted: boolean
  /** Why it may not load here even so, or null */
  refusal: string | null
}

export interface TurnSkillAccess {
  skills: TurnSkill[]
  /**
   * Whether a skill Halo does not list (built into the engine, from a plugin)
   * may load. It has no switch, so only a policy where silence means yes and
   * no skill list was written grants it.
   */
  grantsUnlisted: boolean
}

/**
 * What the engine already settles for this turn without asking the gate — the
 * yardstick a skill's pre-approvals are measured against.
 */
export interface SkillCeiling {
  /** The turn's auto-allow rules (`allowedTools`) */
  allowedRules: readonly string[]
  /** The turn's deny list (`disallowedTools`); only whole-tool entries count */
  disallowed: readonly string[]
  /** Tools a pre-tool hook judges on every call this turn */
  hooked: readonly string[]
}

/** The skills of this turn: which are granted, and which of those still cannot load. */
export function turnSkillAccess(
  available: readonly AvailableSkill[],
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode,
  ceiling: SkillCeiling
): TurnSkillAccess {
  const allowed = new Set(ceiling.allowedRules.map(normalizeRule))
  const denied = new Set(ceiling.disallowed.filter(entry => !entry.includes('(')).map(canonicalBuiltinTool))
  const hooked = new Set(ceiling.hooked)
  const covered = (entry: string): boolean => {
    const { tool, content } = parseRule(entry)
    if (tool.startsWith('mcp__')) return true // granted by the server being there at all
    if (denied.has(tool) || hooked.has(tool) || allowed.has(tool)) return true
    return content !== undefined && allowed.has(`${tool}(${content})`)
  }

  const skills = available.map((skill): TurnSkill => {
    const granted = allowsSkill(policy, skill.dirName, mode)
    return {
      dirName: skill.dirName,
      name: skill.name,
      path: skill.path,
      granted,
      refusal: granted ? preApprovalRefusal(skill, covered, allowed) : null,
    }
  })
  return { skills, grantsUnlisted: mode === 'permissive' && policy?.allowedSkills === undefined }
}

/**
 * The folders of the skills this turn may load: readable to it, whatever else it
 * may read. A name with any copy that may not load opens none of its copies.
 */
export function grantedSkillFolders(access: TurnSkillAccess | undefined): string[] {
  if (!access) return []
  const blocked = new Set(access.skills.filter(skill => skill.refusal).map(skill => skill.dirName))
  return access.skills.filter(skill => skill.granted && !blocked.has(skill.dirName)).map(skill => skill.path)
}

export type SkillCallDecision = { allow: true } | { allow: false; reason: string }

/**
 * Decide one call of the skill tool. The name is resolved the way the engine
 * resolves it — folder name or frontmatter name, a leading "/" ignored — and
 * every skill it could mean must be allowed to load.
 */
export function decideSkillCall(access: TurnSkillAccess, input: Record<string, unknown>): SkillCallDecision {
  const raw = typeof input.skill === 'string' ? input.skill.trim() : ''
  const requested = raw.startsWith('/') ? raw.slice(1) : raw
  const meant = access.skills.filter(skill => skill.dirName === requested || skill.name === requested)

  if (meant.length === 0 ? !(requested && access.grantsUnlisted) : meant.some(skill => !skill.granted)) {
    const usable = access.skills.filter(skill => skill.granted && !skill.refusal).map(skill => skill.dirName)
    return {
      allow: false,
      reason:
        `The skill "${requested}" is not available for this request. ` +
        (usable.length > 0 ? `Skills available here: ${usable.join(', ')}.` : 'No skill is available here.'),
    }
  }
  const refused = meant.find(skill => skill.refusal)
  return refused ? { allow: false, reason: refused.refusal! } : { allow: true }
}

/** Shown before a borrowed turn's message that would otherwise run as a command. */
const COMMAND_AS_TEXT_NOTE = '[Sent as text: commands are not run directly in this conversation.]'

/**
 * A borrowed turn's message as the engine should receive it: never starting
 * with "/", which it would run as the command named — a skill loading with its
 * pre-approvals and no call the gate could judge. A skill that is granted is
 * still reached the usual way, through the skill tool.
 */
export function inertCommandText(text: string): string {
  return text.trimStart().startsWith('/') ? `${COMMAND_AS_TEXT_NOTE}\n${text}` : text
}

// ── A skill's own pre-approvals ──

/**
 * Why a granted skill may still not load: what it would have the engine allow
 * without asking — the tools its `allowed-tools` name, commands its hooks run,
 * a sub-agent of its own — reaches past what the turn already allows.
 */
function preApprovalRefusal(
  skill: AvailableSkill,
  covered: (entry: string) => boolean,
  allowed: ReadonlySet<string>
): string | null {
  const frontmatter = readFrontmatter(skill.content)
  if (frontmatter === null) {
    return `The skill "${skill.dirName}" cannot run here: its settings (SKILL.md frontmatter) could not be read, ` +
      'so whether it stays within what this request allows cannot be told.'
  }

  const reasons: string[] = []
  const reaching = allowedToolsOf(frontmatter['allowed-tools']).filter(entry => !covered(entry))
  if (reaching.length > 0) {
    reasons.push(`it pre-approves ${reaching.join(', ')}, more than this request is allowed`)
  }
  // Hook commands run with no permission check at all: only a caller who may
  // run any command may have them run.
  if (hasContent(frontmatter.hooks) && !allowed.has('Bash')) {
    reasons.push('it runs commands of its own (hooks), and running any command is not allowed for this request')
  }
  if (frontmatter.context === 'fork' && !allowed.has('Agent')) {
    reasons.push('it runs as a sub-agent, which this request is not allowed')
  }
  if (reasons.length === 0) return null
  return `The skill "${skill.dirName}" cannot run here: ${reasons.join('; ')}. ` +
    "Its owner can allow that for this request, or take it out of the skill's settings."
}

/** The frontmatter block, read as the engine reads it; null when it cannot be read. */
function readFrontmatter(content: string): Record<string, unknown> | null {
  const block = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(content)
  if (!block) return content.startsWith('---') ? null : {}
  for (const text of [block[1], quoteLooseValues(block[1])]) {
    try {
      const data = parseYaml(text) as unknown
      return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
    } catch {
      // The engine retries with loose values quoted, and so do we.
    }
  }
  return null
}

/** The engine's second reading of a frontmatter: `key: value` lines with YAML-special values quoted. */
function quoteLooseValues(text: string): string {
  return text.split('\n').map(line => {
    const match = /^([a-zA-Z_-]+):\s+(.+)$/.exec(line)
    if (!match) return line
    const [, key, value] = match
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted || !/[{}[\]*&#!|>%@`]|: /.test(value)) return line
    return `${key}: "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }).join('\n')
}

/**
 * `allowed-tools` as the engine lists it: a string or a list of strings, each
 * split on commas and spaces outside parentheses; any "*" stands for every tool.
 */
function allowedToolsOf(value: unknown): string[] {
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const entries: string[] = []
  for (const item of items) {
    let current = ''
    let inParens = false
    for (const char of item) {
      if (char === '(') inParens = true
      else if (char === ')') inParens = false
      if ((char === ',' || char === ' ') && !inParens) {
        if (current.trim()) entries.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    if (current.trim()) entries.push(current.trim())
  }
  return entries.includes('*') ? ['*'] : entries
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** A permission rule as the engine compares it: tool name by its current name, "(*)" and "()" read as none. */
function parseRule(entry: string): { tool: string; content?: string } {
  const match = /^([^(]+)\((.*)\)$/.exec(entry.trim())
  if (!match) return { tool: canonicalBuiltinTool(entry.trim()) }
  const content = match[2]
  const tool = canonicalBuiltinTool(match[1])
  return content === '' || content === '*' ? { tool } : { tool, content }
}

function normalizeRule(entry: string): string {
  const { tool, content } = parseRule(entry)
  return content === undefined ? tool : `${tool}(${content})`
}
