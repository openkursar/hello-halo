/**
 * apps/manager -- Built-in App Loader
 *
 * Halo's equivalent of VSCode's BuiltinExtensionsScannerService.
 *
 * Bundled digital humans live in `resources/builtin-apps/`, materialized at
 * build time by `scripts/sync-builtin-apps.mjs` from an external SSOT (e.g.
 * `../digital-human-protocol-<variant>/packages/digital-humans/`). Each app is
 * a folder shaped like:
 *
 *   resources/builtin-apps/
 *     manifest.json                    (loader-consumed manifest)
 *     <specId>/
 *       spec.yaml                       (parsed into AppSpec)
 *       skills/
 *         <skillId>/
 *           SKILL.md                    (Claude SDK skill markdown + frontmatter)
 *           index.js                    (and any other companion files)
 *           ...
 *
 * Lifecycle (runs once per launch as a Tier-3 idle task):
 *   1. Locate manifest.json (dev: app.getAppPath()/resources/builtin-apps/,
 *      packaged: process.resourcesPath/builtin-apps/).
 *   2. For each manifest entry:
 *      a. Parse spec.yaml, scan skills/<id>/ folders, build SkillSpec[] for
 *         bundled skills (matches the existing fetchBundledSkills contract).
 *      b. Stamp `spec.store.install_source = 'builtin'` on the parent and on
 *         every bundled skill — this is the marker every other layer uses.
 *      c. Look up `(specId, spaceId)` in the App Manager.
 *         - Not present: install fresh, install bundled skills, runtime.activate(),
 *           apply default status (active or paused) per manifest.
 *         - Present, status='uninstalled': respect user choice; skip refresh.
 *           User can re-enable via the standard reinstall flow at any time.
 *         - Present, version unchanged: no-op (cheap by-spec lookup, no I/O).
 *         - Present, version differs: in-place spec refresh via updateSpec().
 *           userConfig / status / overrides are preserved automatically because
 *           updateSpec only touches the spec_json column.
 *   3. Garbage-collect: any installed app marked install_source='builtin' that
 *      is no longer in the current manifest (renamed, removed, swapped to a
 *      different product variant) is hard-deleted along with its bundled skills.
 *
 * Performance notes:
 *   - Runs as a Tier-3 idle task (registerIdleTask) so it never delays the UI.
 *   - The "no change since last boot" path is the common case and is bounded
 *     by N spec.yaml reads + N version comparisons. For a typical bundle of
 *     5 apps × 3 skills, that's ~20 small file reads — negligible.
 *   - When changes are detected, only the diff incurs SQLite writes.
 *
 * Open-source builds with no `builtinApps` field in product.json end up with
 * an empty manifest.json (or no resources/builtin-apps/ at all). The loader
 * detects this and exits as a no-op — zero overhead, zero side effects.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { app } from 'electron'

import type { AppManagerService } from './types'
import { isBuiltinApp } from './types'
import type { AppSpec, SkillSpec } from '../spec/schema'
import { parseAppSpec, validateAppSpec, AppSpecParseError, AppSpecValidationError } from '../spec'
import { extractFrontmatterField } from '../../../shared/skill-frontmatter'
import { AppAlreadyInstalledError } from './errors'

// ---------------------------------------------------------------------------
// Manifest types — kept in sync with scripts/sync-builtin-apps.mjs output
// ---------------------------------------------------------------------------

interface ManifestAppEntry {
  /** Subdirectory name under resources/builtin-apps/. Also used as spec id. */
  specId: string
  /** Target space; null = global; 'halo-temp' is the typical default. */
  spaceId: string | null
  /** Initial status when first installed. */
  defaultStatus: 'active' | 'paused'
}

interface BuiltinManifest {
  version: number
  sourcePath: string
  generatedAt: string
  apps: ManifestAppEntry[]
  /**
   * True only when the build author *intentionally* declared zero built-in apps
   * (i.e. product.json explicitly contains `builtinApps.apps: []`). False/absent
   * means the empty manifest was generated because no `builtinApps` config was
   * present in product.json. The GC pass uses this flag to distinguish
   * "user really meant to clear all builtins" from "this build doesn't ship
   * any" — only the former is allowed to wipe pre-existing built-in DB rows.
   */
  intentionalEmpty?: boolean
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk root for built-in apps.
 *
 * In dev `app.getAppPath()` points at the project root; in production it
 * points inside app.asar, but `process.resourcesPath` is what electron-builder
 * places the `resources/` extra-files at. Try both so this works in every mode
 * including unpacked Linux builds.
 */
function getBuiltinAppsDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', 'builtin-apps'),
    join(process.resourcesPath ?? '', 'builtin-apps'),
  ].filter((p, i, arr) => p && arr.indexOf(p) === i)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Read the manifest produced by scripts/sync-builtin-apps.mjs. Returns null
 * when the file is absent (open-source build with no built-ins) or unreadable
 * — both cases short-circuit the loader without raising.
 */
function readManifest(rootDir: string): BuiltinManifest | null {
  const manifestPath = join(rootDir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<BuiltinManifest>
    if (!raw || raw.version !== 1 || !Array.isArray(raw.apps)) {
      console.warn('[BuiltinLoader] Manifest is malformed or unsupported version:', raw?.version)
      return null
    }
    // Defensive: the build script already validated, but coerce to be safe
    const apps: ManifestAppEntry[] = []
    for (const entry of raw.apps) {
      if (!entry || typeof entry.specId !== 'string') continue
      apps.push({
        specId: entry.specId,
        spaceId: entry.spaceId === null ? null : (entry.spaceId ?? 'halo-temp'),
        defaultStatus: entry.defaultStatus === 'active' ? 'active' : 'paused',
      })
    }
    return {
      version: 1,
      sourcePath: typeof raw.sourcePath === 'string' ? raw.sourcePath : '',
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      apps,
      intentionalEmpty: raw.intentionalEmpty === true,
    }
  } catch (err) {
    console.warn('[BuiltinLoader] Failed to read manifest.json:', (err as Error).message)
    return null
  }
}

/**
 * Read every file under `dir` (one level deep) into a Record<filename, content>.
 * Used to build the `skill_files` map for a bundled skill — the same shape the
 * registry adapter produces for downloaded skills, so the existing skill-sync
 * pipeline picks it up unchanged.
 *
 * Subdirectories are descended recursively; resulting keys use forward-slash
 * paths (e.g. "references/INDEX.md"), matching what `skill-sync.ts` expects.
 */
function readSkillFiles(skillDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const root = resolve(skillDir)

  function walk(current: string, relative: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(abs, rel)
      } else if (entry.isFile()) {
        out[rel] = readFileSync(abs, 'utf8')
      }
    }
  }

  if (!existsSync(root) || !statSync(root).isDirectory()) return out
  walk(root, '')
  return out
}

/**
 * Build SkillSpec records for every directory under `<appDir>/skills/`. Each
 * subdirectory becomes one skill; SKILL.md frontmatter provides name and
 * description so the spec validates without needing a sidecar yaml.
 */
function buildBundledSkillSpecs(appDir: string, parentAuthor?: string): SkillSpec[] {
  const skillsRoot = join(appDir, 'skills')
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) return []

  const specs: SkillSpec[] = []
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFiles = readSkillFiles(skillDir)
    const md = skillFiles['SKILL.md']
    if (!md) {
      console.warn(`[BuiltinLoader] Skipping bundled skill "${entry.name}" — no SKILL.md`)
      continue
    }
    const fmName = extractFrontmatterField(md, 'name') ?? entry.name
    const fmDesc = extractFrontmatterField(md, 'description') ?? `Bundled skill ${entry.name}`
    const fmAuthor = extractFrontmatterField(md, 'author')
    specs.push({
      spec_version: '1',
      name: entry.name,
      type: 'skill',
      version: '1.0',
      description: fmDesc,
      author: fmAuthor || parentAuthor || 'unknown',
      skill_files: skillFiles,
      store: {
        slug: entry.name,
        tags: [fmName],
      },
    } as SkillSpec)
  }
  return specs
}

// ---------------------------------------------------------------------------
// Spec stamping
// ---------------------------------------------------------------------------

/**
 * Tag a spec as built-in. Preserves any existing store metadata (slug, tags,
 * registry_id) so the UI continues to render the app correctly.
 */
function stampBuiltin<T extends AppSpec>(spec: T): T {
  return {
    ...spec,
    store: {
      ...(spec.store ?? {}),
      install_source: 'builtin' as const,
    },
  }
}

// ---------------------------------------------------------------------------
// Per-entry processing
// ---------------------------------------------------------------------------

interface ProcessedSpecIds {
  /** Parent app spec ids successfully processed (used by GC). */
  parents: Set<string>
  /** Bundled skill spec ids successfully processed (used by GC). */
  skills: Set<string>
  /**
   * SpecIds whose source manifest entry exists but failed to parse this run.
   * GC must treat these as "still expected" — a transient bad spec.yaml must
   * not trigger removal of an otherwise-healthy DB row.
   */
  parseFailed: Set<string>
}

/**
 * Result of processing a single manifest entry. The `parsed` flag tells the
 * caller whether the spec was successfully loaded; a false value means GC
 * should not consider the entry "missing" because we have no authoritative
 * picture of what its specId or bundled skills are.
 */
interface ProcessEntryResult {
  parsed: boolean
}

async function processEntry(
  entry: ManifestAppEntry,
  rootDir: string,
  appManager: AppManagerService,
  processed: ProcessedSpecIds,
): Promise<ProcessEntryResult> {
  const appDir = join(rootDir, entry.specId)
  const specPath = join(appDir, 'spec.yaml')
  if (!existsSync(specPath)) {
    console.warn(`[BuiltinLoader] Skipping "${entry.specId}" — spec.yaml not found at ${specPath}`)
    // The manifest declared this entry, so we can use the directory name as a
    // proxy specId for GC protection. Without this, GC would treat the entry
    // as "expected to be gone" and delete the matching DB row.
    processed.parseFailed.add(entry.specId)
    return { parsed: false }
  }

  let spec: AppSpec
  try {
    const yamlText = readFileSync(specPath, 'utf8')
    const normalized = parseAppSpec(yamlText)
    spec = validateAppSpec(normalized)
  } catch (err) {
    if (err instanceof AppSpecParseError || err instanceof AppSpecValidationError) {
      console.warn(`[BuiltinLoader] Invalid spec for "${entry.specId}": ${err.message}`)
    } else {
      console.warn(`[BuiltinLoader] Failed to load spec for "${entry.specId}":`, err)
    }
    processed.parseFailed.add(entry.specId)
    return { parsed: false }
  }

  const stampedSpec = stampBuiltin(spec)
  processed.parents.add(stampedSpec.name)

  const bundledSkills = buildBundledSkillSpecs(appDir, spec.author).map(stampBuiltin)
  for (const s of bundledSkills) processed.skills.add(s.name)

  // Pass entry.spaceId verbatim: null filters to global-only, a string filters
  // to that space. Coercing null → undefined here would broaden the lookup to
  // ALL spaces and mistakenly match a same-named app in another space, causing
  // the loader to silently skip the install.
  const existing = appManager.listApps({ spaceId: entry.spaceId })
    .find(a => a.specId === stampedSpec.name)

  if (!existing) {
    // ── Fresh install ──────────────────────────────────────────────────
    let installedAppId: string | null = null
    try {
      installedAppId = await appManager.install(entry.spaceId, stampedSpec, {})
    } catch (err) {
      if (err instanceof AppAlreadyInstalledError) {
        // Race or stale state — fall through to refresh path on next launch.
        console.warn(`[BuiltinLoader] Race detected installing "${stampedSpec.name}"; will retry next launch`)
        return { parsed: true }
      }
      console.warn(`[BuiltinLoader] Failed to install "${stampedSpec.name}":`, err)
      return { parsed: true }
    }

    // Install bundled skills (mirror of registry.service.ts:installRequiredSkills)
    for (const skillSpec of bundledSkills) {
      try {
        await appManager.install(entry.spaceId, skillSpec, {})
      } catch (err) {
        if (err instanceof AppAlreadyInstalledError) {
          // Another path already installed this skill — refresh its content.
          const existingSkill = appManager.listApps({ spaceId: entry.spaceId, type: 'skill' })
            .find(a => a.specId === skillSpec.name)
          if (existingSkill) {
            try {
              appManager.updateSpec(existingSkill.id, skillSpec as unknown as Record<string, unknown>)
            } catch (refreshErr) {
              console.warn(`[BuiltinLoader] Failed to refresh existing bundled skill "${skillSpec.name}":`, refreshErr)
            }
          }
        } else {
          console.warn(`[BuiltinLoader] Failed to install bundled skill "${skillSpec.name}":`, err)
        }
      }
    }

    // Activate runtime so subscriptions and event sources wire up.
    // Dynamic import keeps the apps/runtime module graph (and its transitive
    // electron / http dependencies) out of the module-load path of consumers
    // that import service.ts indirectly via builtin-gc-flag.ts (e.g. unit tests).
    if (installedAppId) {
      try {
        const { getAppRuntime } = await import('../runtime')
        const runtime = getAppRuntime()
        if (runtime) {
          await runtime.activate(installedAppId)
        }
      } catch (err) {
        console.warn(`[BuiltinLoader] runtime.activate failed for "${stampedSpec.name}" (non-fatal):`, err)
      }
    }

    // Apply default status. install() always creates the row as 'active'; if the
    // manifest asks for 'paused', flip it now. Status changes propagate to the
    // runtime via the AppStatus listener (see service.ts:notifyStatusChange).
    if (entry.defaultStatus === 'paused') {
      try {
        appManager.pause(installedAppId)
      } catch (err) {
        console.warn(`[BuiltinLoader] Failed to pause newly-installed builtin "${stampedSpec.name}":`, err)
      }
    }

    console.log(
      `[BuiltinLoader] Installed builtin "${stampedSpec.name}" v${stampedSpec.version} ` +
      `in ${entry.spaceId === null ? 'global' : `space ${entry.spaceId}`} ` +
      `(status=${entry.defaultStatus}, bundledSkills=${bundledSkills.length})`
    )
    return { parsed: true }
  }

  // ── Existing record ───────────────────────────────────────────────────

  if (!isBuiltinApp(existing)) {
    // A user-installed app already occupies this (specId, spaceId) — do not
    // overwrite. This protects the user from a built-in clobbering an app they
    // installed manually with custom config.
    console.warn(
      `[BuiltinLoader] Skipping "${stampedSpec.name}" — a non-builtin app with the same id ` +
      `is already installed in this space; refusing to overwrite.`
    )
    // Still marked as processed (above) so GC doesn't try to delete it.
    return { parsed: true }
  }

  if (existing.status === 'uninstalled') {
    // User explicitly removed this built-in. Honour it across boots; standard
    // reinstall flow restores it. Skip refresh so userConfig stays preserved.
    return { parsed: true }
  }

  // Auto-upgrade if the bundled spec moved forward.
  if (existing.spec.version !== stampedSpec.version) {
    try {
      appManager.updateSpec(existing.id, stampedSpec as unknown as Record<string, unknown>)
      console.log(
        `[BuiltinLoader] Upgraded builtin "${stampedSpec.name}": ` +
        `${existing.spec.version} → ${stampedSpec.version}`
      )
    } catch (err) {
      console.warn(`[BuiltinLoader] Failed to upgrade "${stampedSpec.name}":`, err)
    }
  }

  // Refresh bundled skills regardless of parent version — skills can change
  // independently and updateSpec is idempotent on equal content.
  for (const skillSpec of bundledSkills) {
    const existingSkill = appManager.listApps({ spaceId: entry.spaceId, type: 'skill' })
      .find(a => a.specId === skillSpec.name)

    if (!existingSkill) {
      try {
        await appManager.install(entry.spaceId, skillSpec, {})
      } catch (err) {
        if (!(err instanceof AppAlreadyInstalledError)) {
          console.warn(`[BuiltinLoader] Failed to install missing bundled skill "${skillSpec.name}":`, err)
        }
      }
      continue
    }

    if (!isBuiltinApp(existingSkill)) {
      console.warn(
        `[BuiltinLoader] Bundled skill "${skillSpec.name}" already exists as a non-builtin install — leaving untouched.`
      )
      continue
    }

    if (existingSkill.status === 'uninstalled') continue

    if (existingSkill.spec.version !== skillSpec.version) {
      try {
        appManager.updateSpec(existingSkill.id, skillSpec as unknown as Record<string, unknown>)
      } catch (err) {
        console.warn(`[BuiltinLoader] Failed to refresh bundled skill "${skillSpec.name}":`, err)
      }
    }
  }

  return { parsed: true }
}

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

/**
 * Hard-delete any built-in app/skill rows that are no longer in the current
 * manifest. Common triggers: rename in the SSOT, removal from product.json, or
 * a switch to a different product variant.
 *
 * Restricted to rows marked install_source='builtin' so user-installed apps
 * are never touched.
 *
 * Safety: rows whose specId appears in `processed.parseFailed` are treated as
 * "still expected". A transient bad spec.yaml or missing file must not cause
 * the loader to delete an otherwise-healthy row — the next launch's parse
 * may succeed and the user's `userConfig` would already be gone.
 */
async function garbageCollectStaleBuiltins(
  appManager: AppManagerService,
  processed: ProcessedSpecIds,
): Promise<void> {
  const all = appManager.listApps()
  let removed = 0
  for (const app of all) {
    if (!isBuiltinApp(app)) continue

    const stillExpected =
      processed.parents.has(app.specId) ||
      processed.skills.has(app.specId) ||
      processed.parseFailed.has(app.specId)
    if (stillExpected) continue

    // The row's spec is no longer in the current manifest — drop it.
    // Two-step: soft uninstall (so cascade-delete of bundled-skills runs)
    // then hard delete with allowBuiltin so the protection guard does not
    // fire. The allowBuiltin flag is the loader's only sanctioned bypass.
    try {
      await appManager.uninstall(app.id)
    } catch {
      /* may already be uninstalled — proceed to hard delete */
    }
    try {
      await appManager.deleteApp(app.id, { allowBuiltin: true })
      removed++
      console.log(`[BuiltinLoader] GC: removed stale builtin "${app.specId}" (${app.id})`)
    } catch (err) {
      console.warn(`[BuiltinLoader] GC: failed to remove stale builtin "${app.specId}":`, err)
    }
  }
  if (removed > 0) {
    console.log(`[BuiltinLoader] GC: total removed = ${removed}`)
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Returns the number of built-in apps currently materialized on disk (whether
 * or not they have been seeded into the App Manager yet). Used by seed.ts to
 * decide whether the "Halo 助手" placeholder should be created.
 */
export function countBuiltinAppsOnDisk(): number {
  const root = getBuiltinAppsDir()
  if (!root) return 0
  const manifest = readManifest(root)
  return manifest?.apps.length ?? 0
}

/**
 * Scan `resources/builtin-apps/`, install/refresh each declared app via the
 * App Manager, and garbage-collect any builtins removed since the last build.
 *
 * Failures are isolated per app and logged as warnings — a single broken
 * built-in never blocks the others or affects user-installed apps.
 *
 * Safety guards (failure modes that must NOT trigger GC):
 *  - Manifest file is missing or unreadable → skip everything.
 *  - Manifest is empty BUT the build did not explicitly declare zero builtins
 *    (i.e. `intentionalEmpty` is not true) → skip GC. This covers the
 *    common-mode failure where `product.json` lost its `builtinApps` section
 *    or sync wrote an empty manifest as a no-op default. Wiping the user's
 *    pre-existing built-in rows in that scenario would silently destroy their
 *    `userConfig`.
 *  - Any individual entry failed to parse → its specId is still treated as
 *    "expected" by GC (see `parseFailed`).
 */
export async function loadBuiltinApps(appManager: AppManagerService): Promise<void> {
  const t0 = performance.now()
  const root = getBuiltinAppsDir()
  if (!root) {
    console.log('[BuiltinLoader] resources/builtin-apps/ not present — skipping (no builtins bundled).')
    return
  }
  const manifest = readManifest(root)
  if (!manifest) {
    console.log('[BuiltinLoader] No usable manifest — skipping.')
    return
  }

  // Count how many built-in rows currently live in the DB. Used to decide
  // whether the empty-manifest case is safe to GC.
  const existingBuiltinCount = appManager.listApps().filter(isBuiltinApp).length

  if (manifest.apps.length === 0) {
    if (manifest.intentionalEmpty) {
      // Build author explicitly declared zero builtins (product.json has
      // `builtinApps.apps: []`). This is the supported way to clean up after
      // switching variants — we run GC.
      await garbageCollectStaleBuiltins(appManager, {
        parents: new Set(),
        skills: new Set(),
        parseFailed: new Set(),
      })
      console.log('[BuiltinLoader] Manifest declares zero builtins (intentional) — GC complete.')
    } else if (existingBuiltinCount > 0) {
      // Empty by accident (no builtinApps in product.json, or sync didn't run).
      // Refuse to GC — preserve user state.
      console.warn(
        `[BuiltinLoader] Empty manifest with ${existingBuiltinCount} existing built-in row(s) ` +
        `in the DB — skipping GC to preserve userConfig. ` +
        `If this is intentional, set intentionalEmpty: true in the manifest.`
      )
    } else {
      console.log('[BuiltinLoader] Empty manifest, no built-in rows in DB — nothing to do.')
    }
    return
  }

  const processed: ProcessedSpecIds = {
    parents: new Set(),
    skills: new Set(),
    parseFailed: new Set(),
  }
  let unhandledErrors = 0
  for (const entry of manifest.apps) {
    try {
      await processEntry(entry, root, appManager, processed)
    } catch (err) {
      // Defensive — processEntry already swallows known errors. Anything that
      // escapes is logged so a single bad built-in cannot crash the loader.
      // Such an entry's specId is also added to parseFailed below so GC won't
      // delete its DB row based on incomplete information.
      console.warn(`[BuiltinLoader] Unhandled error while processing "${entry.specId}":`, err)
      processed.parseFailed.add(entry.specId)
      unhandledErrors++
    }
  }

  await garbageCollectStaleBuiltins(appManager, processed)

  const dt = performance.now() - t0
  const parseFailNote = processed.parseFailed.size > 0
    ? ` (${processed.parseFailed.size} parse-failed, protected from GC)`
    : ''
  const errNote = unhandledErrors > 0 ? ` (${unhandledErrors} unhandled errors)` : ''
  console.log(
    `[BuiltinLoader] Done in ${dt.toFixed(1)}ms ` +
    `(${manifest.apps.length} parent app(s), ${processed.skills.size} bundled skill(s))` +
    parseFailNote + errNote
  )
}
