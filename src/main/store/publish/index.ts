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
import { dispatch as dispatchGithubPr } from './dispatchers/github-pr'
import { dispatch as dispatchHttpRegistry } from './dispatchers/http-registry'
import { dispatch as dispatchLocalDhpkg } from './dispatchers/local-dhpkg'
import { enrichSpecForPublish } from './spec-enrich'
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
export function getPublishPreview(appId: string, authorOverride?: string): PublishPreview {
  const manager = getAppManager()
  if (!manager) throw new Error('App Manager is not yet initialized')
  const app = manager.getApp(appId)
  if (!app) throw new Error(`App not found: ${appId}`)

  const spec = enrichSpecForPublish(app.spec, authorOverride)
  const slug = spec.store!.slug!
  const found = findStoreEntry(slug)
  return {
    slug,
    localVersion: spec.version ?? '0.0.0',
    storeVersion: found?.entry.version ?? null,
  }
}

/** Publish an installed App through the configured dispatcher. */
export async function publish(appId: string, authorOverride?: string, versionOverride?: string): Promise<PublishResult> {
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
    spec = enrichSpecForPublish(app.spec, authorOverride)
    const version = versionOverride?.trim()
    if (version) spec = { ...spec, version }
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

  const registries = getRegistries()
  const registry = registries.find(r => r.id === target.registryId)
  const ctx: PublishContext = {
    registryId: target.registryId,
    registryUrl: registry?.url ?? null,
  }

  console.log(
    `[publish] Dispatching app ${appId} ("${spec.name}") via target=${target.config.target}`
  )

  switch (target.config.target) {
    case 'github-pr':
      return dispatchGithubPr(spec, files, ctx, { github: target.config.github })
    case 'http-registry':
      return dispatchHttpRegistry(spec, files, ctx, {
        url: registry?.url,
        token: target.config.token,
      })
    case 'local-dhpkg':
      return dispatchLocalDhpkg(spec, files, ctx, {})
    default: {
      const _exhaustive: never = target.config.target
      return {
        status: 'error',
        target: 'local-dhpkg',
        details: `Unknown publish target: ${_exhaustive as string}`,
      }
    }
  }
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
  const bundledDeps = (spec.requires?.skills ?? []).filter(
    (dep): dep is { id: string; bundled?: boolean } => typeof dep !== 'string' && dep.bundled === true,
  )
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
