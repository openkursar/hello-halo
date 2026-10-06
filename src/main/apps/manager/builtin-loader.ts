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
 * Lifecycle (a Tier-3 idle task; skipped outright when the bundle is the one
 * the last complete run applied — see bundle-seed-stamp.ts):
 *   1. Locate manifest.json (dev: app.getAppPath()/resources/builtin-apps/,
 *      packaged: process.resourcesPath/builtin-apps/).
 *   2. For each manifest entry:
 *      a. Parse spec.yaml, scan skills/<id>/ folders, build SkillSpec[] for
 *         bundled skills (matches the existing fetchBundledSkills contract).
 *      b. Stamp `spec.store.install_source = 'builtin'` on the parent and on
 *         every bundled skill — this is the marker every other layer uses.
 *      c. Look up `(specId, spaceId)` in the App Manager.
 *         - Not present: install fresh, install every `requires.skills` entry
 *           (bundled from disk, non-bundled from the store — delegated to
 *           registry.service.ts:installRequiredSkills), runtime.activate(),
 *           apply default status (active or paused) per manifest.
 *         - Present, status='uninstalled': respect user choice; skip refresh.
 *           User can re-enable via the standard reinstall flow at any time.
 *         - Present, version unchanged: record the bundled spec as the author's
 *           original if the row predates recorded originals; nothing else.
 *         - Present, bundled version newer: in-place upgrade via upgradeSpec()
 *           (never a downgrade — a newer row from the store is left alone),
 *           which keeps the user's edits to the definition, then a subscription
 *           resync. userConfig / status / overrides live outside the spec and
 *           are never touched. Bundled skills are refreshed via updateSpec
 *           regardless of parent version; non-bundled skills are (re)installed
 *           from the store if missing.
 *   3. Garbage-collect: any installed app marked install_source='builtin' that
 *      is no longer in the current manifest (renamed, removed, swapped to a
 *      different product variant) is hard-deleted along with its bundled skills.
 *      Non-bundled skill dependencies installed via the store are NOT stamped
 *      `install_source='builtin'` — they are ordinary store installs (so they
 *      follow the normal store update/uninstall path) and this GC pass leaves
 *      them alone.
 *
 * Performance notes:
 *   - An idle task still runs on the main thread, so the unchanged-bundle
 *     launch (the common case) must not run at all: it is gated on the stamp.
 *   - Installed rows are read once per run (InstalledView): listApps() parses
 *     every row's spec, bundled skill files included, so a lookup per entry
 *     or per skill made the run grow with everything the user installed.
 *   - When changes are detected, only the diff incurs SQLite writes.
 *
 * Open-source builds with no `builtinApps` field in product.json end up with
 * an empty manifest.json (or no resources/builtin-apps/ at all). The loader
 * detects this and exits as a no-op — zero overhead, zero side effects.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { app } from 'electron'

import type { AppManagerService, InstalledApp } from './types'
import { isBuiltinApp } from './types'
import type { AppSpec, AppType, SkillSpec } from '../spec/schema'
import { parseAppSpec, validateAppSpec, AppSpecParseError, AppSpecValidationError } from '../spec'
import { extractFrontmatterField } from '../../../shared/skill-frontmatter'
import { compareDotVersions } from '../../../shared/store/version-compare'
import { AppAlreadyInstalledError } from './errors'
import { bundleKey, isBundleSeeded, markBundleSeeded } from './bundle-seed-stamp'

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
 *
 * Exported for the builtin-skills seeder (builtin-skills.ts), which builds the
 * same `skill_files` shape from resources/builtin-skills/.
 */
export function readSkillFiles(skillDir: string): Record<string, string> {
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
// Required-skill installation
// ---------------------------------------------------------------------------

/**
 * Install every dependency in `spec.requires.skills` — both the ones bundled
 * under `<appDir>/skills/` (passed in `bundledSkills`, matched by `dep.id`)
 * and any plain store-slug reference (e.g. `halo-team/weoa-todo-list`), which
 * this delegates to `installFromStore()` the same way a store-installed app's
 * dependencies are resolved. Without this, a builtin whose spec declares a
 * non-bundled skill dependency would install with that dependency silently
 * missing, since `buildBundledSkillSpecs()` only ever sees what physically
 * shipped under `skills/`.
 *
 * Dynamic import mirrors the runtime.activate() call below — it keeps
 * registry.service.ts's transitive electron/network module graph out of the
 * module-load path for consumers that only need the manifest-scanning parts
 * of this file (e.g. builtin-gc-flag.ts, unit tests).
 */
async function installRequiredSkillsForBuiltin(
  spec: AppSpec,
  spaceId: string | null,
  bundledSkills: SkillSpec[],
): Promise<boolean> {
  if (!spec.requires?.skills?.length) return true
  try {
    const { installRequiredSkills } = await import('../../store/registry.service')
    const bundledMap = new Map(bundledSkills.map(s => [s.name, s]))
    await installRequiredSkills(spec, spaceId, bundledMap)
    return true
  } catch (err) {
    console.warn(`[BuiltinLoader] Failed to install required skills for "${spec.name}":`, err)
    return false
  }
}

/**
 * Reschedule a digital human whose spec an upgrade just changed. The runtime
 * activated it from the previous spec earlier in startup, so a trigger the
 * upgrade added or moved would otherwise wait for the next launch.
 */
async function syncSubscriptions(appId: string): Promise<void> {
  try {
    const { getAppRuntime } = await import('../runtime')
    getAppRuntime()?.syncAppSubscriptions(appId)
  } catch (err) {
    console.warn(`[BuiltinLoader] Failed to reschedule ${appId} after its upgrade; it applies on next launch:`, err)
  }
}

// ---------------------------------------------------------------------------
// Installed rows
// ---------------------------------------------------------------------------

/**
 * Installed rows, read once per run and again only after this run installs
 * something. Same space semantics as listApps: null means global only.
 */
interface InstalledView {
  all(): InstalledApp[]
  list(spaceId: string | null, type?: AppType): InstalledApp[]
  invalidate(): void
}

function createInstalledView(appManager: AppManagerService): InstalledView {
  let rows: InstalledApp[] | null = null
  const all = (): InstalledApp[] => (rows ??= appManager.listApps())
  return {
    all,
    list(spaceId, type) {
      return all().filter(a => a.spaceId === spaceId && (!type || a.spec.type === type))
    },
    invalidate() {
      rows = null
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
  /** Steps that failed and must be retried, so the bundle is not stamped. */
  failures: number
  /**
   * Store installs retrying a dependency an earlier launch failed to fetch.
   * Not awaited by the run: an unreachable store would hold every idle task
   * queued behind this one for the registry timeout, on every launch.
   */
  retries: Promise<boolean>[]
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
  installed: InstalledView,
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
  const existing = installed.list(entry.spaceId)
    .find(a => a.specId === stampedSpec.name)

  if (!existing) {
    // ── Fresh install ──────────────────────────────────────────────────
    let installedAppId: string | null = null
    try {
      installedAppId = await appManager.install(entry.spaceId, stampedSpec, {})
    } catch (err) {
      processed.failures++
      if (err instanceof AppAlreadyInstalledError) {
        // Race or stale state — fall through to refresh path on next launch.
        console.warn(`[BuiltinLoader] Race detected installing "${stampedSpec.name}"; will retry next launch`)
        return { parsed: true }
      }
      console.warn(`[BuiltinLoader] Failed to install "${stampedSpec.name}":`, err)
      return { parsed: true }
    } finally {
      installed.invalidate()
    }

    // Install every declared skill dependency — bundled (from `skills/` on
    // disk) and non-bundled (fetched from the store by slug) alike.
    if (!await installRequiredSkillsForBuiltin(stampedSpec, entry.spaceId, bundledSkills)) processed.failures++
    installed.invalidate()

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
        processed.failures++
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

  // Upgrade only: a row the store already moved past the bundle keeps its
  // newer version.
  const versionOrder = compareDotVersions(stampedSpec.version, existing.spec.version)
  if (versionOrder > 0) {
    try {
      const outcome = appManager.upgradeSpec(existing.id, stampedSpec)
      console.log(
        `[BuiltinLoader] Upgraded builtin "${stampedSpec.name}": ` +
        `${existing.spec.version} → ${stampedSpec.version} (kept=${outcome.kept.length})`
      )
      await syncSubscriptions(existing.id)
    } catch (err) {
      processed.failures++
      console.warn(`[BuiltinLoader] Failed to upgrade "${stampedSpec.name}":`, err)
    }
  } else if (versionOrder === 0 && !appManager.getAuthorSpec(existing.id)) {
    // The bundle still carries the installed version, so it is that version's
    // original: record it for a row installed before originals were kept.
    try {
      appManager.recordAuthorSpec(existing.id, stampedSpec)
    } catch (err) {
      console.warn(`[BuiltinLoader] Failed to record the original of "${stampedSpec.name}":`, err)
    }
  }

  // Refresh bundled skills regardless of parent version — skills can change
  // independently and updateSpec is idempotent on equal content.
  for (const skillSpec of bundledSkills) {
    const existingSkill = installed.list(entry.spaceId, 'skill')
      .find(a => a.specId === skillSpec.name)

    if (!existingSkill) {
      try {
        await appManager.install(entry.spaceId, skillSpec, {})
      } catch (err) {
        if (!(err instanceof AppAlreadyInstalledError)) {
          processed.failures++
          console.warn(`[BuiltinLoader] Failed to install missing bundled skill "${skillSpec.name}":`, err)
        }
      }
      installed.invalidate()
      continue
    }

    if (!isBuiltinApp(existingSkill)) {
      console.warn(
        `[BuiltinLoader] Bundled skill "${skillSpec.name}" already exists as a non-builtin install — leaving untouched.`
      )
      continue
    }

    if (existingSkill.status === 'uninstalled') continue

    if (compareDotVersions(skillSpec.version, existingSkill.spec.version) > 0) {
      try {
        appManager.updateSpec(existingSkill.id, skillSpec as unknown as Record<string, unknown>)
      } catch (err) {
        processed.failures++
        console.warn(`[BuiltinLoader] Failed to refresh bundled skill "${skillSpec.name}":`, err)
      }
    }
  }

  // Non-bundled requires.skills entries (store slug references) aren't covered
  // by the loop above, which only walks `skills/` on disk. Only entries with no
  // existing DB record are passed through: installRequiredSkills()'s network
  // fetch (registry auth + spec download) happens before its own
  // AppAlreadyInstalledError check, so without this filter every launch would
  // pay a store round-trip per dependency regardless of whether it's already
  // installed. This also protects a skill the user explicitly uninstalled —
  // the bundled-skill branch of installRequiredSkills() force-reinstalls on
  // AppAlreadyInstalledError, which would otherwise undo the `continue` above.
  //
  // Matched by spec.store.slug rather than specId: a non-bundled dep's `id`
  // (e.g. "halo-team/weoa-todo-list") is the registry slug it was installed
  // under, which withInstallStoreMetadata() persists as spec.store.slug —
  // specId instead holds the fetched spec's own `name` field, which is not
  // guaranteed to equal the slug's second segment.
  const missingNonBundledDeps = stampedSpec.requires?.skills?.filter(dep => {
    if (typeof dep !== 'string' && dep.bundled === true) return false
    const skillId = typeof dep === 'string' ? dep : dep.id
    return !installed.list(entry.spaceId, 'skill')
      .some(a => a.spec.store?.slug === skillId)
  })

  if (missingNonBundledDeps?.length) {
    const nonBundledSpec: AppSpec = {
      ...stampedSpec,
      requires: { ...stampedSpec.requires, skills: missingNonBundledDeps },
    }
    processed.retries.push(installRequiredSkillsForBuiltin(nonBundledSpec, entry.spaceId, []))
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
  installed: InstalledView,
  processed: ProcessedSpecIds,
): Promise<void> {
  const all = installed.all()
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
      await appManager.uninstall(app.id, { reason: 'system' })
    } catch {
      /* may already be uninstalled — proceed to hard delete */
    }
    try {
      await appManager.deleteApp(app.id, { allowBuiltin: true })
      removed++
      console.log(`[BuiltinLoader] GC: removed stale builtin "${app.specId}" (${app.id})`)
    } catch (err) {
      processed.failures++
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

  const stampKey = bundleKey(`${manifest.generatedAt}|${JSON.stringify(manifest.apps)}`)
  if (isBundleSeeded('builtin-apps', stampKey)) return

  const installed = createInstalledView(appManager)

  if (manifest.apps.length === 0) {
    // Built-in rows in the DB decide whether the empty-manifest case is safe to GC.
    const existingBuiltinCount = installed.all().filter(isBuiltinApp).length
    if (manifest.intentionalEmpty) {
      // Build author explicitly declared zero builtins (product.json has
      // `builtinApps.apps: []`). This is the supported way to clean up after
      // switching variants — we run GC.
      await garbageCollectStaleBuiltins(appManager, installed, {
        parents: new Set(),
        skills: new Set(),
        parseFailed: new Set(),
        failures: 0,
        retries: [],
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
    failures: 0,
    retries: [],
  }
  let unhandledErrors = 0
  for (const entry of manifest.apps) {
    try {
      await processEntry(entry, root, appManager, installed, processed)
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

  await garbageCollectStaleBuiltins(appManager, installed, processed)

  if (processed.parseFailed.size === 0 && unhandledErrors === 0 && processed.failures === 0) {
    void Promise.all(processed.retries).then(results => {
      if (results.every(Boolean)) markBundleSeeded('builtin-apps', stampKey)
    })
  }

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
