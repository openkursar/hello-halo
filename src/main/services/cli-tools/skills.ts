import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'

export const CLI_SKILL_DESCRIPTION_MAX = 300
/** Largest package guide read into a skill, in UTF-8 bytes; a bundle's SKILL.md has its own limit. */
export const GUIDE_MAX_BYTES = 64 * 1024

export type CliSkillSource = 'admin' | 'package' | 'manifest' | 'default'

export interface CliToolSkill {
  toolId: string
  /** The tool's installation on this device; recorded with the skill's location. */
  installId: string
  name: string
  description: string
  body: string
  /** The bundle skill's other files, paths relative to the skill folder. */
  attachments: Array<{ path: string; bytes: Buffer }>
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

export function normalizeSkillDescription(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return Array.from(line).slice(0, CLI_SKILL_DESCRIPTION_MAX).join('').trimEnd()
}

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

export function resolveSkillDescription(input: {
  admin?: string
  package?: string
  manifest?: string
  toolName: string
}): { description: string; source: CliSkillSource } {
  const admin = normalizeSkillDescription(input.admin)
  if (admin) return { description: admin, source: 'admin' }
  const pkg = normalizeSkillDescription(input.package)
  if (pkg) return { description: pkg, source: 'package' }
  const manifest = normalizeSkillDescription(input.manifest)
  if (manifest) return { description: manifest, source: 'manifest' }
  return {
    description: normalizeSkillDescription(`Use the ${input.toolName} command-line tool.`)!,
    source: 'default',
  }
}

const SKILL_NAME_MAX = 64

/**
 * `<command>-<tool id>-<install id>`; without an install id (a package not yet
 * installed) the last part is left out. The install id keeps two Halo
 * installations on one computer, which share the personal skill folder, from
 * writing or removing each other's skill. A tool id cut to fit gets a digest,
 * so different ids never fold into one name.
 */
export function cliSkillName(command: string, toolId: string, installId: string): string {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const head = (fold(command) || 'tool').slice(0, 24).replace(/-+$/, '')
  let slug = fold(toolId)
  const room = SKILL_NAME_MAX - head.length - (installId ? installId.length + 2 : 1)
  if (slug.length > room) {
    const digest = createHash('sha256').update(toolId).digest('hex').slice(0, 8)
    slug = `${slug.slice(0, Math.max(0, room - digest.length - 1)).replace(/-+$/, '')}-${digest}`.replace(/^-/, '')
  }
  return [head, slug, installId].filter(Boolean).join('-')
}

/** A skill description that names the command it belongs to, within the length limit. */
export function cliSkillDescription(command: string, description: string): string {
  return normalizeSkillDescription(`Companion skill for the ${command} command-line tool. ${description}`)!
}

export interface CliSkillLaunch {
  command: string
  /** Absolute launcher path for sh-family shells (Git Bash on Windows). */
  path: string
  /** Absolute launcher path for cmd.exe and PowerShell; Windows only. */
  cmdPath?: string
}

/**
 * The skill body: where the tool is, then the bundle's SKILL.md or the
 * package guide as written. The guide uses the bare command name, but the tool is not
 * on the shell's PATH, so the header names the file that command is.
 */
export function renderCliSkill(input: { toolId: string; installId: string; launches: CliSkillLaunch[]; guide?: string }): string {
  const lines = [
    `<!-- Installed by Halo for ${input.toolId} (install ${input.installId}). Halo rewrites this file when the tool changes. -->`,
    '',
    'Run the tool by the absolute path below, quoted, wherever the guide writes its command name:',
    '',
  ]
  for (const launch of input.launches) {
    lines.push(`- \`${launch.command}\`: \`${launch.path}\``)
    if (launch.cmdPath) lines.push(`  (cmd.exe and PowerShell: \`${launch.cmdPath}\`)`)
  }
  const guide = input.guide?.trim()
  lines.push('', guide || 'No usage guide was provided. Run the tool with `--help` to learn its commands.', '')
  return lines.join('\n')
}
