/**
 * SKILL.md Frontmatter Utilities (shared)
 *
 * Pure-TypeScript utilities for normalizing and extracting frontmatter fields
 * from Claude Code SKILL.md files.  No Node.js / Electron imports — safe for
 * both the main process and the renderer.
 *
 * --------------------------------------------------------------------------
 * CC SDK Skill Frontmatter Reference (as of 2026-03):
 *
 *   name                     - Display name (default: directory name)
 *   description              - What the skill does; used for auto-discovery
 *   argument-hint            - Autocomplete hint, e.g. "[issue-number]"
 *   user-invocable           - Show in `/` menu (default: true)
 *   disable-model-invocation - Prevent Claude from auto-loading (default: false)
 *   allowed-tools            - Comma-separated tool list, e.g. "Read, Grep, Glob"
 *   model                    - Override model when skill is active
 *   context                  - "fork" to run in a subagent
 *   agent                    - Subagent type when context=fork
 *   hooks                    - Lifecycle hooks scoped to this skill
 *
 * See https://code.claude.com/docs/en/skills#frontmatter-reference
 * --------------------------------------------------------------------------
 *
 * Normalizations applied by `normalizeSkillMd` (all idempotent):
 *   1. Injects `user-invocable: true` when the field is absent.
 *   2. Converts `allowed-tools` from YAML array to comma-separated string.
 *
 * Design constraints:
 *   - Minimal textual diff: only the affected lines are touched.
 *   - No YAML library dependency — targeted regex replacements only.
 *   - Safe on non-frontmatter input: returns content unchanged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed CC SDK SKILL.md frontmatter fields.
 *
 * This type documents the complete CC SDK skill API surface.  Halo stores
 * the raw SKILL.md in `SkillSpec.skill_files` — this type is for runtime
 * introspection, not persistence.
 */
export interface SkillFrontmatter {
  name?: string
  description?: string
  'argument-hint'?: string
  'user-invocable'?: boolean
  'disable-model-invocation'?: boolean
  'allowed-tools'?: string
  model?: string
  context?: 'fork'
  agent?: string
  hooks?: unknown
}

// ---------------------------------------------------------------------------
// Frontmatter normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a SKILL.md file's frontmatter for SDK compatibility.
 * Returns the (possibly modified) full file content.
 */
export function normalizeSkillMd(content: string): string {
  const fmRegex = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/
  const match = content.match(fmRegex)
  if (!match) return content

  const [fullMatch, opening, fmBody, closing] = match
  let normalised = fmBody
  let modified = false

  // 1. Ensure `user-invocable: true` when not explicitly declared.
  //    Only skip injection when the field is already present (regardless of value).
  if (!/^user-invocable\s*:/m.test(normalised)) {
    normalised += '\nuser-invocable: true'
    modified = true
  }

  // 2. Convert `allowed-tools: [X, Y, Z]` → `allowed-tools: X, Y, Z`
  const toolsArrayRe = /^(allowed-tools\s*:\s*)\[([^\]]*)\][ \t]*$/m
  const toolsMatch = normalised.match(toolsArrayRe)
  if (toolsMatch) {
    const tools = toolsMatch[2]
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .join(', ')
    normalised = normalised.replace(toolsMatch[0], `${toolsMatch[1]}${tools}`)
    modified = true
  }

  if (!modified) return content

  const bodyAfterFrontmatter = content.slice(fullMatch.length)
  return opening + normalised + closing + bodyAfterFrontmatter
}

// ---------------------------------------------------------------------------
// Frontmatter field extraction (lightweight, regex-based)
// ---------------------------------------------------------------------------

/**
 * Extract a single scalar value from SKILL.md frontmatter.
 * Returns `undefined` when the field is absent or the file has no frontmatter.
 *
 * Handles `key: value` lines only (not nested structures).
 * Sufficient for `argument-hint`, `name`, `description`, etc.
 */
export function extractFrontmatterField(content: string, field: string): string | undefined {
  const fmMatch = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return undefined

  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fieldRe = new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'm')
  const fieldMatch = fmMatch[1].match(fieldRe)
  if (!fieldMatch) return undefined

  // Strip surrounding quotes if present
  return fieldMatch[1].trim().replace(/^["'](.*)["']$/, '$1')
}

/**
 * Extract the primary SKILL.md content string from a skill spec's storage.
 * `skill_files` takes priority (registry installs); falls back to `skill_content`.
 */
export function getSkillMdContent(
  spec: { skill_files?: Record<string, string>; skill_content?: string }
): string {
  return spec.skill_files?.['SKILL.md'] ?? spec.skill_content ?? ''
}

/** Quote a value for a YAML `key: value` line only when it would otherwise be
 * mis-parsed (colon, comment marker, indicator chars, edge whitespace). */
function yamlScalar(value: string): string {
  const needsQuote = /[:#[\]{}&*!|>'"%@`,]/.test(value) || /^[\s?-]/.test(value) || /\s$/.test(value)
  return needsQuote ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value
}

/**
 * Set (or insert) the `name` field in SKILL.md frontmatter, returning the full
 * file. Used at publish time so the runtime skill command — derived from the
 * frontmatter name (default: directory name) — stays consistent with the store
 * listing name. No-op when the content has no frontmatter block.
 */
export function setSkillMdName(content: string, name: string): string {
  const fmRegex = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/
  const match = content.match(fmRegex)
  if (!match) return content

  const [fullMatch, opening, fmBody, closing] = match
  const line = `name: ${yamlScalar(name)}`
  const nameRe = /^name[ \t]*:.*$/m
  const nextBody = nameRe.test(fmBody) ? fmBody.replace(nameRe, line) : `${line}\n${fmBody}`
  if (nextBody === fmBody) return content

  return opening + nextBody + closing + content.slice(fullMatch.length)
}
