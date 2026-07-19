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
 *   - .zip archive             → SKILL.md at root OR inside a single
 *                                top-level wrapper folder; macOS metadata
 *                                (__MACOSX/, .DS_Store, ._*) is silently stripped
 *
 * Each successful parse returns a `ParsedSkill` ready to feed into
 * `api.appInstall` with `type: 'skill'`.
 */

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
 */
export function toSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Build a SKILL.md string from explicit fields (used by the Visual form).
 */
export function buildMdFromForm(form: { name: string; description: string; bodyContent: string }): string {
  const slug = toSlug(form.name) || 'my-skill'
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

import { readFileText, readDirectoryEntryToMap } from './file-read-utils'

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
 * Build a ParsedSkill from a FileSystemDirectoryEntry (drag-drop folder).
 * The entry is the folder itself; we strip its name from all paths.
 */
export async function processDirectoryEntry(entry: FileSystemDirectoryEntry): Promise<ParsedSkill> {
  const files = await readDirectoryEntryToMap(entry)

  if (!files['SKILL.md']) {
    throw new Error('SKILL.md not found. A skill folder must contain SKILL.md at its root.')
  }

  const { name, description } = parseMd(files['SKILL.md'])
  return {
    name: name || toSlug(entry.name),
    description: description || '',
    skillFiles: files,
  }
}

/**
 * Build a ParsedSkill from a FileList produced by <input webkitdirectory>.
 * Each file's webkitRelativePath is "folderName/path/to/file".
 */
export async function processFileListAsFolder(fileList: FileList): Promise<ParsedSkill> {
  const skillFiles: Record<string, string> = {}
  let folderName = ''

  for (const file of Array.from(fileList)) {
    const relPath = file.webkitRelativePath // e.g. "halo-dev/SKILL.md"
    const parts = relPath.split('/')
    if (parts.length < 2) continue
    if (!folderName) folderName = parts[0]
    const filePath = parts.slice(1).join('/') // strip top-level folder segment
    if (!filePath) continue
    skillFiles[filePath] = await readFileText(file)
  }

  if (!skillFiles['SKILL.md']) {
    throw new Error('SKILL.md not found. A skill folder must contain SKILL.md at its root.')
  }

  const { name, description } = parseMd(skillFiles['SKILL.md'])
  return {
    name: name || toSlug(folderName),
    description: description || '',
    skillFiles,
  }
}

/**
 * Build a ParsedSkill from a .zip file using fflate (pure JS).
 * Tolerates two shapes:
 *   - Flat:    SKILL.md at the archive root
 *   - Wrapped: every file under a single top-level folder (macOS Finder default)
 * macOS metadata (__MACOSX/, .DS_Store, ._*) is silently ignored.
 */
export async function processZipFile(file: File): Promise<ParsedSkill> {
  const { unzipSync } = await import('fflate')
  const buffer = await file.arrayBuffer()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('Could not extract ZIP. Make sure the file is a valid ZIP archive.')
  }

  // Build a raw map (skip directory-only entries and macOS metadata)
  const rawFiles: Record<string, string> = {}
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/')) continue // directory entry
    if (path.startsWith('__MACOSX/')) continue
    if (path.split('/').some(seg => seg === '.DS_Store' || seg.startsWith('._'))) continue
    rawFiles[path] = new TextDecoder('utf-8').decode(bytes)
  }

  if (Object.keys(rawFiles).length === 0) {
    throw new Error('ZIP archive is empty.')
  }

  // Detect a single common top-level folder (e.g. "halo-dev/") and strip it.
  const topDirs = new Set(
    Object.keys(rawFiles)
      .map(p => p.split('/')[0])
      .filter(Boolean)
  )

  let skillFiles: Record<string, string> = {}
  if (topDirs.size === 1) {
    const prefix = Array.from(topDirs)[0] + '/'
    const allInPrefix = Object.keys(rawFiles).every(p => p.startsWith(prefix))
    if (allInPrefix) {
      for (const [path, content] of Object.entries(rawFiles)) {
        const stripped = path.slice(prefix.length)
        if (stripped) skillFiles[stripped] = content
      }
    } else {
      skillFiles = rawFiles
    }
  } else {
    skillFiles = rawFiles
  }

  if (!skillFiles['SKILL.md']) {
    throw new Error(
      'SKILL.md not found in ZIP. The archive must contain SKILL.md at the root level, ' +
      'or inside a single top-level folder.'
    )
  }

  const { name, description } = parseMd(skillFiles['SKILL.md'])
  const folderName = file.name.replace(/\.zip$/i, '')
  return {
    name: name || toSlug(folderName),
    description: description || '',
    skillFiles,
  }
}
