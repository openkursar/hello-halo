import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'

export const CLI_SKILL_DESCRIPTION_MAX = 300
/** Largest administrator guide accepted, in UTF-8 bytes. */
export const GUIDE_MAX_BYTES = 64 * 1024

export type CliSkillSource = 'admin' | 'package' | 'manifest' | 'default'

export interface CliToolSkill {
  toolId: string
  name: string
  description: string
  body: string
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

/** Stable across command renames, exposed aliases and other installed tools. */
export function cliSkillName(toolId: string): string {
  const slug = toolId.replace(/\./g, '-').slice(0, 47).replace(/-$/, '')
  const hash = createHash('sha256').update(toolId).digest('hex').slice(0, 12)
  return `cli-${slug}-${hash}`
}

export function renderCliSkill(toolId: string): string {
  return [
    `# ${toolId}`,
    '',
    '- Check `HALO_CLI_TOOLS_BIN` in your shell environment. If it is unset or empty, this session has no tool pin: do not run this tool or fall back to a bare command.',
    `- Read \`$HALO_CLI_TOOLS_BIN/../TOOLS.md\` (use your shell's environment variable syntax). Find the tool ID \`${toolId}\` in the available commands table. If the index cannot be read or the tool is unavailable or unlisted, do not run it or use another program in its place.`,
    '- Read the guide linked there before using the tool. Invoke only the command listed for it, from the launcher directory; do not use a bare command, start the runtime or search for another copy. If no guide is provided, use `--help` with the listed launcher.',
    '- Do not install, upgrade or remove this tool. Never ask for, print or pass credentials in arguments or files. If a command changed data and its outcome is unclear, check the result before trying again.',
    '',
  ].join('\n')
}
