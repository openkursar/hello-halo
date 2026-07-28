/**
 * Entry point for publishing an installed App to the configured registry.
 *
 * The dispatcher is selected from `loadProductConfig().registryOverrides`;
 * the renderer never picks a target.
 */

import { loadProductConfig } from '../../foundation/product-config'
import { getAppManager } from '../../apps/manager'
import type { AppManagerService } from '../../apps/manager'
import { getRegistries, findStoreEntry } from '../registry.service'
import { fetchMyPublications } from '../marketplace-mine'
import { dispatch as dispatchGithubPr } from './dispatchers/github-pr'
import { dispatch as dispatchHttpRegistry } from './dispatchers/http-registry'
import { dispatch as dispatchLocalDhpkg } from './dispatchers/local-dhpkg'
import { enrichSpecForPublish } from './spec-enrich'
import { bundledSkillDeps } from '../../../shared/apps/bundled-skills'
import { setSkillMdName } from '../../../shared/skill-frontmatter'
import type { PublishResult, PublishContext } from './types'
import type { AppSpec, SkillSpec } from '../../apps/spec'

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

/** Publish an installed App through the configured dispatcher. */
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
 * i18n overrides so the edited value is what installers see. */
function applyDisplayOverride(spec: AppSpec, field: 'name' | 'description', value: string | undefined): AppSpec {
  const trimmed = value?.trim()
  if (!trimmed) return spec
  let next: AppSpec = { ...spec, [field]: trimmed }
  if (next.i18n) {
    next = { ...next, i18n: stripI18nField(next.i18n as unknown as Record<string, Record<string, unknown>>, field) as typeof next.i18n }
  }
  return next
}

/** For a skill, write the final spec name into its SKILL.md frontmatter so the
 * runtime slash command (derived from that name) matches the store listing —
 * without this, renaming a skill to clear a name collision leaves the package's
 * command unchanged and it collides at install. */
function alignSkillCommandName(spec: AppSpec): AppSpec {
  if (spec.type !== 'skill' || !spec.name) return spec
  const s = spec as SkillSpec
  if (s.skill_files?.['SKILL.md'] !== undefined) {
    return { ...s, skill_files: { ...s.skill_files, 'SKILL.md': setSkillMdName(s.skill_files['SKILL.md'], spec.name) } }
  }
  if (s.skill_content !== undefined) {
    return { ...s, skill_content: setSkillMdName(s.skill_content, spec.name) }
  }
  return spec
}

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
  const { files, missingSkillIds } = collectFiles(spec, manager, app.spaceId)
  if (missingSkillIds.length > 0) {
    return {
      status: 'error',
      target: target.config.target,
      details:
        `Bundled skill dependencies are incomplete — publishing would produce a broken package. ` +
        `Missing skills: ${missingSkillIds.join(', ')}. Install them first, then publish again.`,
    }
  }
  spec = declareBundledSkillFiles(spec, files)

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
 * Collect the auxiliary files to upload alongside the spec.
 *
 * - For a skill: its own `skill_files` (name → content).
 * - For a digital human (or other non-skill app): the files of any BUNDLED
 *   skills, so the package stays self-contained. The DH spec only carries the
 *   `requires.skills[]` metadata — each bundled skill's content lives in its
 *   own installed skill app (materialized at install time), so it is read back
 *   from there and uploaded under `skills/<id>/<file>`, the layout the registry
 *   stores and `fetchBundledSkills()` reads on install.
 *
 * Bundled skills are looked up with the same effective-resolution semantics
 * the runtime uses (space-scoped overriding global), so a skill installed in
 * global scope satisfies the dependency. Skills still missing are returned in
 * `missingSkillIds` — the caller must fail the publish, because a bundled
 * declaration is a self-containment promise and a partial package is broken
 * for every installer.
 */
/**
 * Declare each bundled skill's uploaded files in the wire spec's
 * requires.skills[] so the install adapter knows what to fetch. collectFiles
 * uploads them under `skills/<id>/<file>`; the declaration is the matching
 * relative-path list. Without it, install fails with "declares no files".
 */
function declareBundledSkillFiles(spec: AppSpec, files: Record<string, string>): AppSpec {
  if (spec.type !== 'automation') return spec
  const deps = spec.requires?.skills
  if (!deps || deps.length === 0) return spec
  const skills = deps.map(dep => {
    if (typeof dep === 'string' || dep.bundled !== true) return dep
    const prefix = `skills/${dep.id}/`
    const fileList = Object.keys(files)
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length))
    return { ...dep, files: fileList }
  })
  return { ...spec, requires: { ...spec.requires, skills } }
}

export function collectFiles(
  spec: AppSpec,
  manager: AppManagerService,
  spaceId: string | null,
): { files: Record<string, string>; missingSkillIds: string[] } {
  if (spec.type === 'skill') {
    const skillFiles = (spec as SkillSpec).skill_files ?? {}
    const files: Record<string, string> = {}
    for (const [name, content] of Object.entries(skillFiles)) {
      if (name === 'spec.yaml') continue
      files[name] = content
    }
    return { files, missingSkillIds: [] }
  }

  const files: Record<string, string> = {}
  const missingSkillIds: string[] = []
  const bundledDeps = bundledSkillDeps(spec.requires?.skills)
  if (bundledDeps.length === 0) return { files, missingSkillIds }

  const installedSkills = spaceId
    ? manager.listEffectiveSkillApps(spaceId)
    : manager.listApps({ spaceId: null, type: 'skill' })
  for (const dep of bundledDeps) {
    const skillApp = installedSkills.find(a => a.specId === dep.id)
    if (!skillApp) {
      missingSkillIds.push(dep.id)
      continue
    }
    const skillFiles = (skillApp.spec as SkillSpec).skill_files ?? {}
    for (const [name, content] of Object.entries(skillFiles)) {
      if (name === 'spec.yaml') continue
      files[`skills/${dep.id}/${name}`] = content
    }
  }
  return { files, missingSkillIds }
}
