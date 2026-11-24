/**
 * The skill Halo writes for each command-line tool in a command view
 * (`views/<viewKey>/skills/cli-<command>/SKILL.md`). The host owns its format:
 * only `name` and `description` reach the frontmatter, whatever the
 * administrator or the package wrote, so a tool's skill can never pre-approve
 * tools or change how it is loaded. See DESIGN.md "Tool skills".
 */

import { existsSync, readFileSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import { parse as parseYaml } from 'yaml'
import type { SkillCatalogEntry } from '../../../shared/types/skills'

/** Longest description kept, in characters; the registry enforces the same. */
export const CLI_SKILL_DESCRIPTION_MAX = 300
/** Largest guide body inlined into a skill, in UTF-8 bytes. */
export const CLI_SKILL_BODY_MAX_BYTES = 64 * 1024

/** Where a skill's description came from, first match wins. */
export type CliSkillSource = 'admin' | 'package' | 'manifest' | 'default'

/** One tool skill as `view.json` records it. */
export interface CliSkillRecord {
  name: string
  description: string
  toolId: string
  version: string
  source: CliSkillSource
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/
const SKILL_NAME = /^cli-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** One line, trimmed, at most `CLI_SKILL_DESCRIPTION_MAX` characters; undefined when empty. */
export function normalizeSkillDescription(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  const chars = Array.from(line)
  return chars.length > CLI_SKILL_DESCRIPTION_MAX ? chars.slice(0, CLI_SKILL_DESCRIPTION_MAX).join('').trimEnd() : line
}

/**
 * Split a guide into its frontmatter description and its body. Only
 * `description` is read; a block that is not valid YAML yields no
 * description, and the block is dropped from the body either way.
 */
export function splitGuide(text: string): { description?: string; body: string } {
  const match = text.match(FRONTMATTER)
  if (!match) return { body: text.replace(/^\uFEFF/, '') }
  let description: string | undefined
  try {
    const data: unknown = parseYaml(match[1] ?? '')
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      description = normalizeSkillDescription((data as Record<string, unknown>).description)
    }
  } catch {
    description = undefined
  }
  const body = text.slice(match[0].length).replace(/^\s*\n/, '')
  return description ? { description, body } : { body }
}

/** The description a tool's skill uses, from the first source that has one. */
export function resolveSkillDescription(input: {
  admin?: string
  package?: string
  manifest?: string
  command: string
  toolName: string
}): { description: string; source: CliSkillSource } {
  const admin = normalizeSkillDescription(input.admin)
  if (admin) return { description: admin, source: 'admin' }
  const pkg = normalizeSkillDescription(input.package)
  if (pkg) return { description: pkg, source: 'package' }
  const manifest = normalizeSkillDescription(input.manifest)
  if (manifest) return { description: manifest, source: 'manifest' }
  return {
    description: normalizeSkillDescription(`Use the \`${input.command}\` command-line tool (${input.toolName}).`)!,
    source: 'default',
  }
}

/**
 * Skill names for tools in pin order, `cli-` plus the tool's first command in
 * lowercase. Two commands that fold to the same name get `-2`, `-3`, ...
 */
export function assignCliSkillNames(tools: Array<{ toolId: string; command: string }>): Map<string, string> {
  const names = new Map<string, string>()
  const taken = new Set<string>()
  for (const tool of tools) {
    const slug = tool.command.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 56).replace(/^-+|-+$/g, '') || 'tool'
    const base = `cli-${slug}`
    let name = base
    for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`
    taken.add(name)
    names.set(tool.toolId, name)
  }
  return names
}

/** Cut text to at most `maxBytes` of UTF-8 without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf-8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString('utf-8').replace(/\uFFFD+$/, ''), truncated: true }
}

export interface CliSkillInput {
  name: string
  description: string
  toolId: string
  version: string
  toolName: string
  commands: Array<{ command: string; exposedAs: string }>
  /** A registered program Halo does not manage. */
  external: boolean
  sideEffects: string
  signIn: string
  /** The tool's sign-in is provided by Halo's enterprise identity. */
  enterpriseSignIn: boolean
  /** Guide body without frontmatter; absent when the tool has none. */
  guide?: string
  /** Where the full guide is, named when the body had to be cut. */
  guidePath?: string
  /** The guide was already cut when read. */
  guideCut?: boolean
}

/** The SKILL.md text of one tool. */
export function renderCliSkill(input: CliSkillInput): string {
  const primary = input.commands[0]
  const lines = [
    '---',
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    '---',
    '',
    `<!-- Written by Halo for ${input.toolId} ${input.external ? '(registered program)' : input.version}. Do not edit: Halo rewrites it. -->`,
    '',
    `# ${primary.exposedAs} (${input.toolName}${input.external ? '' : ` ${input.version}`})`,
    '',
    input.external
      ? 'An existing program on this computer that the user registered. Halo does not manage it or its dependencies.'
      : 'Halo installed this command-line tool for this session and runs it on its bundled runtime.',
    `Run it from the shell; the session's launcher directory is \`$HALO_CLI_TOOLS_BIN\`.`,
    '',
    `- Commands: ${input.commands.map(c => `\`${c.exposedAs}\``).join(', ')}`,
    `- Side effects: ${input.sideEffects}`,
    `- Sign-in: ${input.signIn}`,
  ]
  const renamed = input.commands.filter(c => c.exposedAs !== c.command)
  if (renamed.length > 0) {
    lines.push(
      '',
      ...renamed.map(c => `\`${c.command}\` is another program on this computer, so this tool runs as \`${c.exposedAs}\`. Where the guide below says \`${c.command}\`, run \`${c.exposedAs}\`.`),
    )
  }
  lines.push(
    '',
    '## Rules',
    '',
    '- Do not install, update or remove this tool, and do not run npm or any installer for it.',
    '- Never ask for, print, store or pass a credential in arguments, files or output.',
    '- If a command that changes data fails or its outcome is unknown, do not run it again: check the result first and tell the user.',
    input.enterpriseSignIn
      ? '- If it reports that it is not signed in or not authorized, ask the user to sign in under Settings > Enterprise identity, then run it again.'
      : '- If it asks for sign-in, tell the user what the tool asks for and let them do it.',
    '',
    '## Usage',
    '',
  )
  if (input.guide && input.guide.trim()) {
    const cut = truncateUtf8(input.guide.trimEnd(), CLI_SKILL_BODY_MAX_BYTES)
    lines.push(cut.text)
    if (cut.truncated || input.guideCut) {
      lines.push('', input.guidePath
        ? `(The guide was cut here. The full guide is \`${input.guidePath}\`.)`
        : '(The guide was cut here.)')
    }
  } else {
    lines.push(`No usage guide was provided. Run \`${primary.exposedAs} --help\` to learn its commands before using it.`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * The folder holding the tool skills of the command view a session was pinned
 * to, given the session's `HALO_CLI_TOOLS_BIN`; each skill is a
 * `cli-<command>/SKILL.md` inside it. Undefined for a path that is not absolute.
 */
export function cliSkillsRoot(binDir: string | undefined): string | undefined {
  return binDir && isAbsolute(binDir) ? join(dirname(binDir), 'skills') : undefined
}

/**
 * The tool skills of the command view a session was pinned to, given the
 * session's `HALO_CLI_TOOLS_BIN`. Reads only that view's `view.json`; a
 * missing or unreadable view yields no skills.
 */
export function cliSkillEntries(binDir: string | undefined): SkillCatalogEntry[] {
  const root = cliSkillsRoot(binDir)
  if (!root) return []
  const viewDir = dirname(root)
  let skills: unknown
  try {
    skills = (JSON.parse(readFileSync(join(viewDir, 'view.json'), 'utf-8')) as { skills?: unknown }).skills
  } catch {
    return []
  }
  if (!Array.isArray(skills)) return []
  const entries: SkillCatalogEntry[] = []
  for (const skill of skills as Array<Partial<CliSkillRecord>>) {
    if (typeof skill?.name !== 'string' || !SKILL_NAME.test(skill.name) || typeof skill.description !== 'string') continue
    const path = join(root, skill.name, 'SKILL.md')
    if (!existsSync(path)) continue
    entries.push({ name: skill.name, description: skill.description, source: { kind: 'file', path } })
  }
  return entries
}
