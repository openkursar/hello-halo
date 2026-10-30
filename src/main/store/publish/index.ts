/**
 * Entry point for publishing an installed App to the configured registry.
 *
 * The dispatcher is selected from `loadProductConfig().registryOverrides`;
 * the renderer never picks a target.
 */

import { loadProductConfig } from '../../foundation/product-config'
import { getAppManager } from '../../apps/manager'
import { findLoadableSkill, findUndeclaredSkills, hasPackageableSkillMd, listLoadableSkills, readLoadableSkillFiles, type LoadableSkill } from '../../apps/skill-discovery'
import type { AppManagerService } from '../../apps/manager'
import { getRegistries, findStoreEntry, findSkillListing } from '../registry.service'
import type { RegistryEntry, SkillDepInspection } from '../../../shared/store/store-types'
import { fetchMyPublications } from '../backend/publications'
import { dispatch as dispatchGithubPr } from './dispatchers/github-pr'
import { dispatch as dispatchHttpRegistry } from './dispatchers/http-registry'
import { dispatch as dispatchLocalDhpkg } from './dispatchers/local-dhpkg'
import { enrichSpecForPublish } from './spec-enrich'
import { skillFilesOf, withSkillMdName } from '../../../shared/skill-frontmatter'
import { toSkillDirName } from '../../../shared/skill-naming'
import { isHaloShippedSkill } from '../../../shared/apps/app-types'
import type { PublishResult, PublishContext } from './types'
import type { AppSpec, SkillSpec } from '../../apps/spec'
import type { SkillDependency } from '../../../shared/apps/spec-types'

export { findAppByPublishSlug } from './find-app'

/**
 * Resolve the publish target for the official registry from product config.
 * Returns `null` when none is configured — UI should hide the Publish button.
 * Only the `official` override is consulted; other registries are read-only mirrors.
 */
export function resolvePublishTarget(): { registryId: string; config: NonNullable<NonNullable<ReturnType<typeof loadProductConfig>['registryOverrides']>[string]['publish']> } | null {
  const overrides = loadProductConfig().registryOverrides ?? {}
  const officialPublish = overrides['official']?.publish
  if (!officialPublish) return null
  return { registryId: 'official', config: officialPublish }
}

export interface PublishPreview {
  /** Registry slug the app would publish under (author-dependent). */
  slug: string
  /** Version currently in the local spec. */
  localVersion: string
  /** Version currently in the store index, or null when unpublished. */
  storeVersion: string | null
}

/**
 * Resolve what a publish of `appId` would target: the derived slug and the
 * version currently in the store index. Slug derivation goes through the
 * same enrichment as publish itself so the pre-check can never disagree
 * with the actual upload. Throws on the same author/name problems publish
 * would throw on.
 */
export async function getPublishPreview(appId: string, authorOverride?: string, nameOverride?: string): Promise<PublishPreview> {
  const manager = getAppManager()
  if (!manager) throw new Error('App Manager is not yet initialized')
  const app = manager.getApp(appId)
  if (!app) throw new Error(`App not found: ${appId}`)

  // Derive the slug from the final (possibly renamed) name so the previewed
  // store version matches the slug publish will actually target — a rename must
  // preview the new slug (typically unpublished ⇒ no version bump), not the old.
  // Skills are exempt: their name is the command identifier, so a rename edits
  // only the display name and keeps the listing in place.
  const spec = enrichSpecForPublish(applyDisplayOverride(app.spec, 'name', nameOverride), authorOverride)
  const slug = spec.store!.slug!
  return {
    slug,
    localVersion: spec.version ?? '0.0.0',
    storeVersion: await resolveStoreVersion(slug),
  }
}

// Coalesce the burst of preview probes a single publish form fires (the app
// itself plus one per bundled skill) into one round-trip.
let submissionsCache: { at: number; data: Awaited<ReturnType<typeof fetchMyPublications>> } | null = null

// Drop the cache after a publish so the next preview reflects the just-listed
// version — otherwise co-publishing a skill then publishing it standalone would
// still suggest the old version and collide on the monotonicity check.
function invalidateSubmissionsCache(): void {
  submissionsCache = null
}

/**
 * The version to increment from. Prefer the author's own submissions: they
 * record a version the instant it is submitted — even while pending review and
 * before the public browse index syncs — so a just-published app increments
 * correctly. The published listing is decoupled from the local app (publish
 * snapshots an immutable copy without bumping the installed spec), so the
 * registry is the only source of truth here. Falls back to the local browse
 * index when there is no identity binding / the user is signed out.
 */
async function resolveStoreVersion(slug: string): Promise<string | null> {
  try {
    const now = Date.now()
    if (!submissionsCache || now - submissionsCache.at > 3000) {
      submissionsCache = { at: now, data: await fetchMyPublications() }
    }
    const mine = submissionsCache.data.find(p => p.slug === slug)
    if (mine?.version) return mine.version
  } catch {
    // Not signed in / no identity-bound server — fall through to the index.
  }
  return findStoreEntry(slug)?.entry.version ?? null
}

/**
 * Publish-time edits applied to a one-time snapshot of the source spec.
 * They never touch the creator's local installed app — the snapshot is an
 * immutable copy, so editing the store listing here has no local side effect.
 */
export interface PublishOverrides {
  author?: string
  version?: string
  /** Per-version release notes; recorded server-side and shown in version history. */
  changelog?: string
  category?: string
  name?: string
  description?: string
  tags?: string[]
}

/** Drop one field from every locale entry so an edited top-level value is not
 * shadowed by a stale i18n override. */
function stripI18nField(i18n: Record<string, Record<string, unknown>>, field: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [locale, entry] of Object.entries(i18n)) {
    const { [field]: _dropped, ...rest } = entry
    out[locale] = rest
  }
  return out
}

/** Apply a snapshot edit to a display field, also stripping the field's per-locale
 * i18n overrides so the edited value is what installers see. A skill's `name` is
 * its command identifier rather than a display string, so a name edit lands on
 * `display_name` — renaming a listing must not repoint the slash command. */
function applyDisplayOverride(spec: AppSpec, field: 'name' | 'description', value: string | undefined): AppSpec {
  const trimmed = value?.trim()
  if (!trimmed) return spec
  const target = field === 'name' && spec.type === 'skill' ? 'display_name' : field
  let next: AppSpec = { ...spec, [target]: trimmed }
  if (next.i18n) {
    next = { ...next, i18n: stripI18nField(next.i18n as unknown as Record<string, Record<string, unknown>>, field) as typeof next.i18n }
  }
  return next
}

/** Ship the package with the same frontmatter name the local install writes, so
 * an installer's slash command matches the one the author sees. */
function alignSkillCommandName(spec: AppSpec): AppSpec {
  if (spec.type !== 'skill') return spec
  const s = spec as SkillSpec
  return s.display_name ? withSkillMdName(s, s.name) : spec
}

/** Publish an installed App through the configured dispatcher. */
export async function publish(appId: string, overrides: PublishOverrides = {}): Promise<PublishResult> {
  const manager = getAppManager()
  if (!manager) {
    return { status: 'error', target: 'local-dhpkg', details: 'App Manager is not yet initialized' }
  }

  const app = manager.getApp(appId)
  if (!app) {
    return { status: 'error', target: 'local-dhpkg', details: `App not found: ${appId}` }
  }

  const target = resolvePublishTarget()
  if (!target) {
    return {
      status: 'error',
      target: 'local-dhpkg',
      details: 'No publish target configured in product.json (registryOverrides.official.publish).',
    }
  }

  // Enrich publish-only metadata (e.g. derive store.slug from name) so any
  // spec the local runtime accepts is also accepted by registries. Kept out
  // of the create-time schema so locally-running apps aren't forced to
  // populate distribution fields they don't use.
  let spec: AppSpec
  try {
    // Apply the name override BEFORE enrichment so the derived slug reflects the
    // final store name. A renamed app must map to a fresh slug — otherwise it
    // still targets the original slug and collides with its already-published
    // version, making a genuine rename indistinguishable from a re-publish.
    // (Skills excepted — see applyDisplayOverride.)
    spec = enrichSpecForPublish(applyDisplayOverride(app.spec, 'name', overrides.name), overrides.author)
    const version = overrides.version?.trim()
    if (version) spec = { ...spec, version }
    const category = overrides.category?.trim()
    if (category) spec = { ...spec, store: { ...spec.store!, category } }
    const changelog = overrides.changelog?.trim()
    if (changelog) spec = { ...spec, store: { ...spec.store!, changelog } }
    if (overrides.tags) {
      const tags = overrides.tags.map(tg => tg.trim()).filter(Boolean)
      spec = { ...spec, store: { ...spec.store!, tags } }
    }
    spec = applyDisplayOverride(spec, 'description', overrides.description)
    spec = alignSkillCommandName(spec)
  } catch (e) {
    return {
      status: 'error',
      target: 'local-dhpkg',
      details: (e as Error).message,
    }
  }
  const { files, missingSkillIds, packagedSpec } = collectFiles(spec, manager, app.spaceId)
  if (missingSkillIds.length > 0) {
    return {
      status: 'error',
      target: target.config.target,
      details:
        `Skill dependencies are unresolvable — publishing would produce a broken package. ` +
        `Not found in any configured registry or among the skills this digital human can load, or their SKILL.md cannot be read: ${missingSkillIds.join(', ')}. ` +
        `Install them (or fix SKILL.md) first, then publish again.`,
    }
  }
  spec = packagedSpec

  const registries = getRegistries()
  const registry = registries.find(r => r.id === target.registryId)
  const ctx: PublishContext = {
    registryId: target.registryId,
    registryUrl: registry?.url ?? null,
  }

  console.log(
    `[publish] Dispatching app ${appId} ("${spec.name}") via target=${target.config.target}`
  )

  let result: PublishResult
  switch (target.config.target) {
    case 'github-pr':
      result = await dispatchGithubPr(spec, files, ctx, { github: target.config.github })
      break
    case 'http-registry':
      result = await dispatchHttpRegistry(spec, files, ctx, {
        url: registry?.url,
        token: target.config.token,
      })
      break
    case 'local-dhpkg':
      result = await dispatchLocalDhpkg(spec, files, ctx, {})
      break
    default: {
      const _exhaustive: never = target.config.target
      return {
        status: 'error',
        target: 'local-dhpkg',
        details: `Unknown publish target: ${_exhaustive as string}`,
      }
    }
  }
  if (result.status !== 'error') invalidateSubmissionsCache()
  return result
}

/**
 * Declare each packaged skill's uploaded files in the wire spec's
 * requires.skills[] so the install adapter knows what to fetch. collectFiles
 * uploads them under `skills/<dir>/<file>`; the declaration is the matching
 * relative-path list, under the id `<dir>`. Without it, a registry install
 * fails with "declares no files" — this includes skills collectFiles packaged
 * because they were not resolvable from any registry, even if the author never
 * marked them `bundled: true`: once the files travel inside the package, the
 * dependency must say so, or an installer will try (and fail) to fetch them
 * elsewhere.
 */
function declareBundledSkillFiles(spec: AppSpec, files: Record<string, string>, packageDirs: Map<string, string>): AppSpec {
  if (spec.type !== 'automation') return spec
  const deps = spec.requires?.skills
  if (!deps || deps.length === 0) return spec
  const skills = deps.map(dep => {
    const dir = packageDirs.get(typeof dep === 'string' ? dep : dep.id)
    if (!dir) return dep
    const prefix = `skills/${dir}/`
    const fileList = Object.keys(files)
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length))
    if (fileList.length === 0) return dep
    const base = typeof dep === 'string' ? { id: dir } : { ...dep, id: dir }
    return { ...base, bundled: true, files: fileList }
  })
  return { ...spec, requires: { ...spec.requires, skills } }
}

/**
 * Collect the auxiliary files to upload alongside the spec.
 *
 * - For a skill: its own `skill_files` (name → content).
 * - For a digital human (or other non-skill app): the files of any skill
 *   dependency that must travel inside the package, so the package stays
 *   self-contained. The DH spec only carries `requires.skills[]` metadata —
 *   each dependency's content lives in its own installed skill app
 *   (materialized at install time), so it is read back from there and
 *   uploaded under `skills/<dir>/<file>`, the layout the registry stores and
 *   `fetchBundledSkills()` reads on install. `<dir>` is the dependency id, or
 *   the skill's folder name when the id is a namespaced Store slug: importers
 *   take the first segment under `skills/` as the skill.
 *
 * A dependency is packaged when no Store skill listing serves it
 * (`findSkillListing`) — regardless of whether the author remembered to mark
 * it `bundled: true`. Most dependencies are plain store references and are
 * deliberately left alone here: installers fetch them from the Store, so they
 * are not re-packaged into every consumer. Only a dependency that
 * install-time resolution could never satisfy — because it isn't published
 * anywhere the current registries know about — gets its files pulled in
 * here, so the reference doesn't silently produce a broken package for every
 * installer, whether or not the author declared it `bundled`.
 *
 * Skills are looked up as the engine loads them (a global folder winning a
 * name the space also holds), so a skill installed in global scope satisfies
 * the dependency, and a skill folder placed by hand is read from disk. A dependency that resolves nowhere —
 * not in a registry, not loadable locally — is returned in
 * `missingSkillIds`; the caller must fail rather than ship a package that can
 * never be completed by any installer. `packagedSpec` is `spec` with each
 * packaged dependency declared bundled under its package folder — the spec to
 * ship alongside `files`.
 */
export function collectFiles(
  spec: AppSpec,
  manager: AppManagerService,
  spaceId: string | null,
): { files: Record<string, string>; missingSkillIds: string[]; packagedSpec: AppSpec } {
  if (spec.type === 'skill') {
    const skillFiles = (spec as SkillSpec).skill_files ?? {}
    const files: Record<string, string> = {}
    for (const [name, content] of Object.entries(skillFiles)) {
      if (name === 'spec.yaml') continue
      files[name] = content
    }
    return { files, missingSkillIds: [], packagedSpec: spec }
  }

  const files: Record<string, string> = {}
  const missingSkillIds: string[] = []
  const packageDirs = new Map<string, string>()
  const deps = spec.requires?.skills ?? []
  if (deps.length === 0) return { files, missingSkillIds, packagedSpec: spec }

  const installedSkills = effectiveSkillApps(manager, spaceId)
  const loadable = listLoadableSkills(spaceId, manager)

  const shippedIds = new Set<string>()
  for (const dep of deps) {
    const { id, shipped, resolvable, skillApp, localSkill, packageable } = classifySkillDep(dep, installedSkills, loadable)
    if (shipped) {
      shippedIds.add(id)
      continue
    }
    if (resolvable) continue
    const skillFiles = !packageable ? null : skillApp ? skillFilesOf(skillApp.spec as SkillSpec) : readLoadableSkillFiles(localSkill!)
    if (!skillFiles?.['SKILL.md']) {
      missingSkillIds.push(id)
      continue
    }
    const dir = id.includes('/') ? (localSkill?.folder ?? toSkillDirName(skillApp!.specId)) : id
    packageDirs.set(id, dir)
    for (const [name, content] of Object.entries(skillFiles)) {
      if (name === 'spec.yaml') continue
      files[`skills/${dir}/${name}`] = content
    }
  }
  return { files, missingSkillIds, packagedSpec: declareBundledSkillFiles(withoutSkills(spec, shippedIds), files, packageDirs) }
}

/** `spec` without the `requires.skills` entries whose id is in `ids`. */
function withoutSkills(spec: AppSpec, ids: Set<string>): AppSpec {
  if (spec.type !== 'automation' || ids.size === 0 || !spec.requires?.skills) return spec
  const skills = spec.requires.skills.filter(dep => !ids.has(typeof dep === 'string' ? dep : dep.id))
  return { ...spec, requires: { ...spec.requires, skills } }
}

type InstalledSkillApp = ReturnType<AppManagerService['listApps']>[number]

function effectiveSkillApps(manager: AppManagerService, spaceId: string | null): InstalledSkillApp[] {
  return spaceId
    ? manager.listEffectiveSkillApps(spaceId)
    : manager.listApps({ spaceId: null, type: 'skill' })
}

/**
 * Classify one `requires.skills[]` entry against the current registries and
 * local installs. Shared by `collectFiles` (decides what to package) and
 * `inspectSkillDeps` (tells the publish UI what it's about to package), so
 * the two can never disagree about which dependencies are self-contained.
 *
 * - `shipped`: a skill Halo itself ships — never packaged nor fetched.
 * - `resolvable`: installers fetch it from the Store. Only a skill listing
 *   from an enabled source counts, and a dependency that names a local skill
 *   counts only when that skill was installed from that very listing, so a
 *   hand-placed folder is never swapped for someone else's of the same name.
 * - `localSkill` wins over `skillApp`: the folder the engine loads for the
 *   name, not an installed app that folder shadows.
 * - `packageable`: something local holds the skill and its SKILL.md would
 *   survive packaging (not a symlink, binary or oversized file): an importer
 *   skips a skill without one. Checked without reading the whole folder.
 */
function classifySkillDep(
  dep: SkillDependency,
  installedSkills: InstalledSkillApp[],
  loadable: LoadableSkill[],
): { id: string; declaredBundled: boolean; shipped: boolean; resolvable: boolean; skillApp: InstalledSkillApp | null; localSkill: LoadableSkill | null; packageable: boolean; storeEntry: RegistryEntry | null } {
  const id = typeof dep === 'string' ? dep : dep.id
  const declaredBundled = typeof dep !== 'string' && dep.bundled === true
  const localSkill = findLoadableSkill(loadable, dep) ?? null
  const skillApp = localSkill ? localSkill.app : (installedSkills.find(a => a.specId === id) ?? null)
  const shipped = !!localSkill?.app && isHaloShippedSkill(localSkill.app)
  const localStore = localSkill?.app?.spec.store
  const trustStore = !localSkill || (!!localStore?.slug && localStore.slug.toLowerCase() === id.toLowerCase())
  const found = declaredBundled || shipped || !trustStore ? null : findSkillListing(id, localStore?.registry_id)?.entry ?? null
  const packageable = skillApp ? !!skillFilesOf(skillApp.spec as SkillSpec)['SKILL.md'] : !!localSkill && hasPackageableSkillMd(localSkill)
  return { id, declaredBundled, shipped, resolvable: Boolean(found), skillApp, localSkill, packageable, storeEntry: found }
}

/**
 * Preview how each of an automation's skill dependencies will be handled by
 * `collectFiles`, without doing the packaging. Drives the publish form's
 * "Associated Skills" section, including dependencies the author never
 * marked `bundled: true` — those get auto-packaged too when they aren't
 * resolvable from any registry, so the UI must be able to surface them.
 */
export function inspectSkillDeps(
  spec: AppSpec,
  manager: AppManagerService,
  spaceId: string | null,
): SkillDepInspection[] {
  if (spec.type !== 'automation') return []
  const deps = spec.requires?.skills ?? []
  const loadable = listLoadableSkills(spaceId, manager)
  const undeclared = findUndeclaredSkills(spec, loadable).map(skill => skill.id)
  if (deps.length === 0 && undeclared.length === 0) return []

  const installedSkills = effectiveSkillApps(manager, spaceId)
  const inspect = (dep: SkillDependency, declared: boolean): SkillDepInspection | null => {
    const { id, declaredBundled, shipped, resolvable, skillApp, localSkill, packageable, storeEntry } = classifySkillDep(dep, installedSkills, loadable)
    if (shipped) return null
    return {
      id,
      declaredBundled,
      resolvable,
      installed: resolvable ? skillApp !== null || localSkill !== null : packageable,
      appId: skillApp?.id ?? null,
      storeName: storeEntry ? (storeEntry.display_name ?? storeEntry.name) : null,
      declared,
    }
  }
  return [...deps.map(dep => inspect(dep, true)), ...undeclared.map(id => inspect(id, false))]
    .filter((entry): entry is SkillDepInspection => entry !== null)
}
