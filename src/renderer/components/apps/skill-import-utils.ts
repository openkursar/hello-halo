/**
 * skill-import-utils.ts
 *
 * Pure parsing utilities for Skill import.
 * Extracted from SkillInstallDialog so multiple entry points
 * (Add Skill, Share to Store, Install from File) can share the
 * exact same lenient parsing logic.
 *
 * Supported sources:
 *   - Single `.md` file        → one-file skill, wrapped as SKILL.md
 *   - Folder (drag or browse)  → must contain SKILL.md at root
 *   - .zip archive             → same as a folder
 *
 * Folders and archives alike are read through `package-paths`, so a wrapping
 * top-level folder is accepted and macOS metadata never reaches the skill.
 *
 * Each successful parse returns a `ParsedSkill` ready to feed into
 * `api.appInstall` with `type: 'skill'`.
 */

import { readFileText, readDirectoryEntryToMap, readFileListToMap } from './file-read-utils'
import { isIgnoredPackagePath, unwrapPackageFolder, canonicalizePackageEntry } from './package-paths'
import { readArchiveEntries, ArchiveTooLarge } from './package-archive'

// ─────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────

/** A successfully parsed / assembled skill ready to install or publish */
export interface ParsedSkill {
  /** Slug-friendly name derived from frontmatter or file/folder name */
  name: string
  /** Description from frontmatter (may be empty) */
  description: string
  /** All files keyed by relative path. Single-file skills have only 'SKILL.md'. */
  skillFiles: Record<string, string>
}

// ─────────────────────────────────────────────────────────
// Slug / frontmatter helpers
// ─────────────────────────────────────────────────────────

/**
 * Derive a slug-friendly name from an arbitrary string.
 * "My Cool Skill" → "my-cool-skill"
 *
 * ASCII-only, so non-Latin scripts reduce to an empty string. Callers that need
 * a usable identifier for any input go through `api.appDeriveSkillCommandName`,
 * which romanizes in the main process; this stays as the synchronous fallback
 * while that result is in flight.
 */
export function toSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Constrain typed input to what a skill directory and slash command accept.
 * Leaves a trailing hyphen alone so the user can keep typing past a separator;
 * `finalizeCommandName` removes it once the value is committed.
 */
export function sanitizeCommandName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '')
}

/** The committed form: no edge hyphens. Empty when nothing usable remains. */
export function finalizeCommandName(raw: string): string {
  return sanitizeCommandName(raw).replace(/-+$/, '')
}

/**
 * Build a SKILL.md string from explicit fields (used by the Visual form).
 * The frontmatter carries the command name — the SDK reads the slash command
 * from it — while the authored name only shapes the body headline.
 */
export function buildMdFromForm(
  form: { name: string; commandName?: string; description: string; bodyContent: string }
): string {
  const slug = form.commandName?.trim() || toSlug(form.name) || 'my-skill'
  const desc = form.description.trim() || 'My skill description'
  const headline = form.name.trim() || 'My Skill'
  const body = form.bodyContent.trim()
    || `# ${headline}\n\nWrite your skill instructions here...`

  return `---\nname: ${slug}\ndescription: ${desc}\n---\n\n${body}`
}

/**
 * Parse a SKILL.md string into its frontmatter fields and body.
 * Returns empty strings for any field that is absent.
 */
export function parseMd(content: string): { name: string; description: string; bodyContent: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { name: '', description: '', bodyContent: content.trim() }
  const fm = match[1]
  const body = match[2].trim()
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  return { name, description, bodyContent: body }
}

// ─────────────────────────────────────────────────────────
// Top-level processors
// ─────────────────────────────────────────────────────────

/**
 * Build a ParsedSkill from a single .md file.
 * The file is always stored as 'SKILL.md' regardless of its original name.
 */
export async function processMdFile(file: File): Promise<ParsedSkill> {
  const content = await readFileText(file)
  const { name, description } = parseMd(content)
  return {
    name: name || toSlug(file.name.replace(/\.md$/i, '')),
    description: description || '',
    skillFiles: { 'SKILL.md': content },
  }
}

/**
 * Build a ParsedSkill from a read file tree. The tree is resolved against the
 * package root first, so every caller — folder, archive or file list — accepts
 * the same layouts and ships the same files. `folderName` only supplies a
 * fallback name for a SKILL.md whose frontmatter carries none.
 */
export function parseSkillFiles(files: Record<string, string>, folderName: string): ParsedSkill {
  const skillFiles = canonicalizePackageEntry(unwrapPackageFolder(files), 'SKILL.md')

  if (!skillFiles['SKILL.md']) {
    throw new Error(
      'SKILL.md not found. A skill package must contain SKILL.md at its root, ' +
      'or inside a single top-level folder.'
    )
  }

  const { name, description } = parseMd(skillFiles['SKILL.md'])
  return {
    name: name || toSlug(folderName),
    description: description || '',
    skillFiles,
  }
}

/**
 * Build a ParsedSkill from a FileSystemDirectoryEntry (drag-drop folder).
 * The entry is the folder itself; we strip its name from all paths.
 */
export async function processDirectoryEntry(entry: FileSystemDirectoryEntry): Promise<ParsedSkill> {
  return parseSkillFiles(await readDirectoryEntryToMap(entry), entry.name)
}

/** Build a ParsedSkill from a FileList produced by `<input webkitdirectory>`. */
export async function processFileListAsFolder(fileList: FileList): Promise<ParsedSkill> {
  const { files, folderName } = await readFileListToMap(fileList)
  return parseSkillFiles(files, folderName)
}

/** Build a ParsedSkill from a .zip file. */
export async function processZipFile(file: File): Promise<ParsedSkill> {
  let entries: Record<string, Uint8Array>
  try {
    entries = await readArchiveEntries(file)
  } catch (err) {
    if (err instanceof ArchiveTooLarge) throw err
    throw new Error('Could not extract ZIP. Make sure the file is a valid ZIP archive.')
  }

  // Ignored entries are skipped here rather than left to parseSkillFiles so
  // macOS's binary metadata is never decoded.
  const decoder = new TextDecoder('utf-8')
  const rawFiles: Record<string, string> = {}
  for (const [path, bytes] of Object.entries(entries)) {
    if (isIgnoredPackagePath(path)) continue
    rawFiles[path] = decoder.decode(bytes)
  }

  if (Object.keys(rawFiles).length === 0) {
    throw new Error('ZIP archive is empty.')
  }

  return parseSkillFiles(rawFiles, file.name.replace(/\.zip$/i, ''))
}
