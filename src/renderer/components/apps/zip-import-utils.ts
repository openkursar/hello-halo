/**
 * zip-import-utils.ts
 *
 * Pure utility module for Digital Human bundle import.
 * Supports two input modes:
 *   1. Archive (.zip / .dhpkg) → parseDigitalHumanZip(file)
 *   2. Folder                  → parseDigitalHumanFolder(files)
 *
 * Both converge on the same Layer 2 (structure) → Layer 3 (schema)
 * validation pipeline. Layer 4 (Zod) runs on the backend at install time.
 *
 * Bundle Format:
 *   my-digital-human/            (or .zip / .dhpkg)
 *   ├── spec.yaml            ← required, the automation spec
 *   └── skills/              ← optional, bundled skills
 *       ├── skill-a/
 *       │   └── SKILL.md
 *       └── skill-b/
 *           ├── SKILL.md
 *           └── references/
 *               └── guide.md
 *
 * Supports both flat (spec.yaml at root) and wrapped (single top-level
 * folder — macOS zip default). macOS metadata is silently ignored.
 */

import { parse as parseYaml } from 'yaml'
import { isIgnoredPackagePath, unwrapPackageFolder, canonicalizePackageEntry } from './package-paths'
import { readArchiveEntries, MAX_ARCHIVE_BYTES } from './package-archive'

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** `.dhpkg` is a zip under another name (see main/store/dhpkg), so it parses here too. */
const ARCHIVE_EXTENSIONS = ['.zip', '.dhpkg']

// ─────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────

/** A single validation error with full context */
export interface ZipValidationError {
  /** Where the error occurred (e.g. "spec.yaml → type", "skills/my-skill/") */
  location: string
  /** What was expected */
  expected: string
  /** What was actually found */
  actual: string
  /** Actionable suggestion */
  suggestion: string
}

/** Warning that doesn't block installation */
export interface ZipValidationWarning {
  location: string
  message: string
}

/** A bundled skill discovered inside skills/ */
export interface BundledSkill {
  /** Directory name under skills/ */
  name: string
  /** All files keyed by relative path within the skill directory */
  files: Record<string, string>
}

/** Successful parse result */
export interface ZipParseResult {
  /** Raw parsed YAML object (for preview) */
  rawSpec: Record<string, unknown>
  /** YAML string content (for passing to backend import) */
  yamlContent: string
  /** App display name extracted from spec */
  displayName: string
  /** App description extracted from spec */
  description: string
  /** App version */
  version: string
  /** App author */
  author: string
  /** Bundled skills found in skills/ directory */
  bundledSkills: BundledSkill[]
  /** Non-fatal warnings collected during parse */
  warnings: ZipValidationWarning[]
}

/** Parse outcome — either success or failure with detailed errors */
export type ZipParseOutcome =
  | { ok: true; result: ZipParseResult }
  | { ok: false; errors: ZipValidationError[] }

// ─────────────────────────────────────────────────────────
// Layer 1 — File validation (pre-extraction)
// ─────────────────────────────────────────────────────────

function validateFileLayer(file: File): ZipValidationError[] {
  const errors: ZipValidationError[] = []

  // Check extension
  const lowerName = file.name.toLowerCase()
  if (!ARCHIVE_EXTENSIONS.some(ext => lowerName.endsWith(ext))) {
    errors.push({
      location: file.name,
      expected: '.zip or .dhpkg',
      actual: file.name.split('.').pop() || '(none)',
      suggestion: 'Please select a .zip or .dhpkg archive file.',
    })
  }

  // Check size
  if (file.size > MAX_ARCHIVE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
    errors.push({
      location: file.name,
      expected: `≤ 10 MB`,
      actual: `${sizeMB} MB`,
      suggestion: 'Reduce the archive size. Remove unnecessary files from the zip.',
    })
  }

  if (file.size === 0) {
    errors.push({
      location: file.name,
      expected: 'Non-empty file',
      actual: 'Empty file (0 bytes)',
      suggestion: 'The file appears to be empty. Please check and re-export.',
    })
  }

  return errors
}

// ─────────────────────────────────────────────────────────
// Layer 2 — Structure validation (post-extraction)
// ─────────────────────────────────────────────────────────

interface StructureResult {
  /** Normalized file map with clean paths */
  files: Record<string, string>
  /** spec.yaml content as string */
  specContent: string
  /** Discovered bundled skills */
  bundledSkills: BundledSkill[]
  /** Non-blocking warnings */
  warnings: ZipValidationWarning[]
}

function validateStructureLayer(
  rawFiles: Record<string, string>,
  sourceName: string
): { ok: true; result: StructureResult } | { ok: false; errors: ZipValidationError[] } {
  const errors: ZipValidationError[] = []
  const warnings: ZipValidationWarning[] = []

  const cleanFiles: Record<string, string> = {}
  for (const [path, content] of Object.entries(rawFiles)) {
    if (isIgnoredPackagePath(path)) continue
    cleanFiles[path] = content
  }

  if (Object.keys(cleanFiles).length === 0) {
    errors.push({
      location: sourceName,
      expected: 'At least spec.yaml',
      actual: 'No usable files (only empty folders or system metadata)',
      suggestion: 'Select the folder that directly contains spec.yaml.',
    })
    return { ok: false, errors }
  }

  // Security: path traversal check
  for (const path of Object.keys(cleanFiles)) {
    if (path.includes('..') || path.startsWith('/')) {
      errors.push({
        location: path,
        expected: 'Safe relative path',
        actual: `Path traversal detected: "${path}"`,
        suggestion: 'Re-create the ZIP without path traversal sequences.',
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const normalizedFiles = unwrapPackageFolder(cleanFiles)

  // Locate spec.yaml
  const specPaths = Object.keys(normalizedFiles).filter(
    p => p === 'spec.yaml' || p === 'spec.yml'
  )

  if (specPaths.length === 0) {
    errors.push({
      location: sourceName,
      expected: 'spec.yaml',
      actual: 'Not found',
      suggestion:
        'The digital human package must have a spec.yaml at its root. ' +
        'For a single .yaml file, use the "Import" tab instead.',
    })
    return { ok: false, errors }
  }

  if (specPaths.length > 1) {
    errors.push({
      location: sourceName,
      expected: 'Exactly one spec.yaml',
      actual: `Found ${specPaths.length}: ${specPaths.join(', ')}`,
      suggestion: 'A digital human package must contain exactly one spec.yaml.',
    })
    return { ok: false, errors }
  }

  const specContent = normalizedFiles[specPaths[0]]

  // Discover bundled skills
  const bundledSkills: BundledSkill[] = []
  const skillDirs = new Set<string>()

  for (const path of Object.keys(normalizedFiles)) {
    if (path.startsWith('skills/')) {
      const parts = path.split('/')
      if (parts.length >= 3) {
        // skills/<name>/...
        skillDirs.add(parts[1])
      }
    }
  }

  for (const dirName of Array.from(skillDirs)) {
    const prefix = `skills/${dirName}/`
    const collected: Record<string, string> = {}
    for (const [path, content] of Object.entries(normalizedFiles)) {
      if (path.startsWith(prefix)) {
        collected[path.slice(prefix.length)] = content
      }
    }

    const files = canonicalizePackageEntry(collected, 'SKILL.md')
    if (!files['SKILL.md']) {
      warnings.push({
        location: `skills/${dirName}/`,
        message: `Missing SKILL.md — this skill will be skipped. It will not affect the main installation.`,
      })
      continue
    }

    bundledSkills.push({ name: dirName, files })
  }

  return {
    ok: true,
    result: {
      files: normalizedFiles,
      specContent,
      bundledSkills,
      warnings,
    },
  }
}

// ─────────────────────────────────────────────────────────
// Layer 3 — Schema validation (parsed YAML, pre-backend)
// ─────────────────────────────────────────────────────────

function validateSchemaLayer(
  specContent: string
): { ok: true; parsed: Record<string, unknown> } | { ok: false; errors: ZipValidationError[] } {
  const errors: ZipValidationError[] = []

  // Parse YAML
  let parsed: unknown
  try {
    parsed = parseYaml(specContent)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.push({
      location: 'spec.yaml',
      expected: 'Valid YAML syntax',
      actual: `Parse error: ${message}`,
      suggestion: 'Fix the YAML syntax error and re-export.',
    })
    return { ok: false, errors }
  }

  // Must be an object
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({
      location: 'spec.yaml',
      expected: 'A YAML mapping (object)',
      actual: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
      suggestion: 'spec.yaml must contain a YAML object, not a scalar or array.',
    })
    return { ok: false, errors }
  }

  const spec = parsed as Record<string, unknown>

  // Check type
  if (spec.type !== undefined && spec.type !== 'automation') {
    const typeStr = String(spec.type)
    let suggestion = ''
    if (typeStr === 'skill') {
      suggestion = 'This is a Skill spec. Use "My Apps → Add Skill" to install Skills.'
    } else if (typeStr === 'mcp') {
      suggestion = 'This is an MCP Server spec. Use "My Apps → Add MCP Server" to install MCP Servers.'
    } else {
      suggestion = `Type "${typeStr}" is not supported for digital human import.`
    }
    errors.push({
      location: 'spec.yaml → type',
      expected: 'automation',
      actual: typeStr,
      suggestion,
    })
  }

  // Required fields
  const requiredFields = ['name', 'description', 'system_prompt'] as const
  for (const field of requiredFields) {
    if (spec[field] === undefined || spec[field] === null || spec[field] === '') {
      errors.push({
        location: `spec.yaml → ${field}`,
        expected: 'Non-empty value',
        actual: spec[field] === undefined ? 'missing' : spec[field] === null ? 'null' : 'empty string',
        suggestion: `Add a "${field}" field to spec.yaml.`,
      })
    }
  }

  // Field type checks
  if (spec.name !== undefined && typeof spec.name !== 'string') {
    errors.push({
      location: 'spec.yaml → name',
      expected: 'string',
      actual: typeof spec.name,
      suggestion: 'The "name" field must be a string.',
    })
  }

  if (spec.description !== undefined && typeof spec.description !== 'string') {
    errors.push({
      location: 'spec.yaml → description',
      expected: 'string',
      actual: typeof spec.description,
      suggestion: 'The "description" field must be a string.',
    })
  }

  if (spec.system_prompt !== undefined && typeof spec.system_prompt !== 'string') {
    errors.push({
      location: 'spec.yaml → system_prompt',
      expected: 'string',
      actual: typeof spec.system_prompt,
      suggestion: 'The "system_prompt" field must be a string.',
    })
  }

  if (spec.subscriptions !== undefined && !Array.isArray(spec.subscriptions)) {
    errors.push({
      location: 'spec.yaml → subscriptions',
      expected: 'array',
      actual: typeof spec.subscriptions,
      suggestion: 'The "subscriptions" field must be an array.',
    })
  }

  if (spec.config_schema !== undefined && !Array.isArray(spec.config_schema)) {
    errors.push({
      location: 'spec.yaml → config_schema',
      expected: 'array',
      actual: typeof spec.config_schema,
      suggestion: 'The "config_schema" field must be an array.',
    })
  }

  if (spec.permissions !== undefined && !Array.isArray(spec.permissions)) {
    errors.push({
      location: 'spec.yaml → permissions',
      expected: 'array',
      actual: typeof spec.permissions,
      suggestion: 'The "permissions" field must be an array.',
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, parsed: spec }
}

// ─────────────────────────────────────────────────────────
// Shared: Structure → Schema → Result pipeline
// ─────────────────────────────────────────────────────────

/**
 * Run Layer 2 + 3 on a pre-built file map. Used by both zip and folder paths.
 * @param rawFiles – relative-path → text content map
 * @param sourceName – display name for error messages (file name or folder name)
 */
function validateAndBuildResult(
  rawFiles: Record<string, string>,
  sourceName: string
): ZipParseOutcome {
  // Layer 2 — Structure validation
  const structureResult = validateStructureLayer(rawFiles, sourceName)
  if (!structureResult.ok) {
    return { ok: false, errors: structureResult.errors }
  }

  // Layer 3 — Schema validation
  const schemaResult = validateSchemaLayer(structureResult.result.specContent)
  if (!schemaResult.ok) {
    return { ok: false, errors: schemaResult.errors }
  }

  const spec = schemaResult.parsed

  return {
    ok: true,
    result: {
      rawSpec: spec,
      yamlContent: structureResult.result.specContent,
      displayName: String(spec.name ?? ''),
      description: String(spec.description ?? ''),
      version: String(spec.version ?? '1.0'),
      author: String(spec.author ?? ''),
      bundledSkills: structureResult.result.bundledSkills,
      warnings: structureResult.result.warnings,
    },
  }
}

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────

/**
 * Parse and validate a ZIP file for digital human import.
 * Runs Layer 1 → 2 → 3 validation, failing fast at each layer.
 * Returns either a success result with parsed data, or detailed errors.
 */
export async function parseDigitalHumanZip(file: File): Promise<ZipParseOutcome> {
  // Layer 1 — File validation
  const fileErrors = validateFileLayer(file)
  if (fileErrors.length > 0) {
    return { ok: false, errors: fileErrors }
  }

  // Extract ZIP — Layer 1 already refused an oversized archive, so the read's
  // own ceiling cannot fire here.
  let entries: Record<string, Uint8Array>
  try {
    entries = await readArchiveEntries(file)
  } catch {
    return {
      ok: false,
      errors: [{
        location: file.name,
        expected: 'Valid ZIP archive',
        actual: 'Could not extract — file may be corrupted',
        suggestion: 'Re-create the ZIP archive. Make sure the file is not damaged.',
      }],
    }
  }

  // Decode all entries to text
  const decoder = new TextDecoder('utf-8')
  const rawFiles: Record<string, string> = {}
  for (const [path, bytes] of Object.entries(entries)) {
    if (isIgnoredPackagePath(path)) continue
    rawFiles[path] = decoder.decode(bytes)
  }

  return validateAndBuildResult(rawFiles, file.name)
}

/**
 * Parse and validate a folder (Record<string, string>) for digital human import.
 * Skips Layer 1 (zip-specific checks), runs Layer 2 → 3 directly.
 *
 * @param files – relative-path → text content (same format as zip extract output)
 * @param folderName – display name for the folder (used in preview)
 */
export async function parseDigitalHumanFolder(
  files: Record<string, string>,
  folderName: string
): Promise<ZipParseOutcome> {
  if (Object.keys(files).length === 0) {
    return {
      ok: false,
      errors: [{
        location: folderName,
        expected: 'At least spec.yaml',
        actual: 'Empty folder (no files)',
        suggestion: 'The folder contains no files. Please check and try again.',
      }],
    }
  }

  return validateAndBuildResult(files, folderName)
}
