/**
 * Ships repo-authored skills under `resources/builtin-skills/<id>/` (SKILL.md
 * frontmatter + files, committed to git, shipped inside the asar) as global
 * skills, installed/refreshed through manager's skill lifecycle.
 * Companion to builtin-loader.ts, but for skills rather than digital humans.
 *
 * Slug is stamped `halo-builtin-skills/<id>` with install_source 'bundled' —
 * deliberately not 'builtin', since builtin-loader's GC hard-deletes any
 * 'builtin'-stamped row missing from its own manifest, and these skills fall
 * outside that manifest.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createHash } from 'node:crypto'

import type { AppManagerService } from './types'
import type { SkillSpec } from '../spec'
import { readSkillPackage } from '../../services/skills'
import { extractFrontmatterField } from '../../../shared/skill-frontmatter'
import { bundleKey, isBundleSeeded, markBundleSeeded } from './bundle-seed-stamp'
import { AppAlreadyInstalledError } from './errors'
import { BUILTIN_SKILL_SLUG_PREFIX } from '../../../shared/apps/app-types'

/** Resolve resources/builtin-skills/ for dev and packaged (asar reads work through fs). */
function getBuiltinSkillsDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', 'builtin-skills'),
    join(process.cwd(), 'resources', 'builtin-skills'),
  ].filter((p, i, arr) => arr.indexOf(p) === i)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Build a SkillSpec from one resources/builtin-skills/<id>/ directory. */
function buildSkillSpec(rootDir: string, dirName: string): SkillSpec | null {
  const skillDir = join(rootDir, dirName)
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    console.warn(`[BuiltinSkills] Skipping "${dirName}" — no SKILL.md`)
    return null
  }

  const pkg = readSkillPackage(join(skillDir, 'SKILL.md'))
  const md = pkg.files['SKILL.md']
  const version = extractFrontmatterField(md, 'version') ?? '1.0'
  const description = extractFrontmatterField(md, 'description') ?? `Built-in skill ${dirName}`
  const author = extractFrontmatterField(md, 'author') ?? 'Halo'

  return {
    spec_version: '1',
    name: dirName,
    type: 'skill',
    version,
    description,
    author,
    skill_files: pkg.files,
    skill_assets: pkg.assets,
    store: {
      slug: `${BUILTIN_SKILL_SLUG_PREFIX}${dirName}`,
      tags: [],
      install_source: 'bundled' as const,
    },
  } as SkillSpec
}

async function seedSdkSkills(manager: AppManagerService): Promise<void> {
  try {
    const sdk = await import('@hello-halo/agent-sdk/worker')
    const definitions = sdk.getBuiltinSkillDefinitions()
    const records = manager.listSkillRecords(null)
    for (const definition of definitions) {
      const slug = `${BUILTIN_SKILL_SLUG_PREFIX}sdk-${definition.name}`
      const existing = records.find(record => record.spec.store?.slug === slug)
      if (existing && (existing.status === 'uninstalled' || existing.userOverrides.skill?.deleted || existing.userOverrides.skill?.customized)) continue
      const version = createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16)
      const spec: SkillSpec = {
        type: 'skill', spec_version: '1', name: definition.name, description: definition.description,
        version, author: 'Halo',
        skill_content: `---\nname: ${definition.name}\ndescription: ${JSON.stringify(definition.description)}\n${definition.argumentHint ? `argument-hint: ${JSON.stringify(definition.argumentHint)}\n` : ''}---\n\n${definition.instructions}`,
        store: { slug, install_source: 'bundled', tags: [] },
      }
      try {
        if (!existing) await manager.install(null, spec)
        else if (existing.spec.version !== version) manager.upgradeSpec(existing.id, spec)
      } catch (error) {
        if (error instanceof AppAlreadyInstalledError) {
          console.log('[BuiltinSkills] Kept the user\'s own skill of the same name', { name: definition.name })
        } else {
          console.warn('[BuiltinSkills] SDK workflow was not installed; other skills remain available', { name: definition.name, reason: (error as Error).message })
        }
      }
    }
  } catch (error) {
    console.warn('[BuiltinSkills] SDK workflows were not installed; other skills remain available', { reason: (error as Error).message })
  }
}

/** Which skills ship and when each SKILL.md changed — cheap stats, no file reads. */
function skillsBundleKey(root: string, dirNames: string[]): string {
  return dirNames.map(name => {
    const md = join(root, name, 'SKILL.md')
    return `${name}:${existsSync(md) ? statSync(md).mtimeMs : 0}`
  }).join(',')
}

/**
 * Install/refresh shipped skills without reviving deletions or replacing edits.
 * Retired packages and their tombstones stay until an explicit user action.
 * Per-skill failures never block the rest of the bundle.
 * Skipped when the shipped set is the one the last complete run applied.
 */
export async function seedBuiltinSkills(appManager: AppManagerService): Promise<void> {
  const t0 = performance.now()
  await seedSdkSkills(appManager)
  const root = getBuiltinSkillsDir()
  if (!root) {
    console.log('[BuiltinSkills] resources/builtin-skills/ not present — skipping.')
    return
  }

  const dirNames = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && statSync(join(root, entry.name)).isDirectory())
    .map(entry => entry.name)
    .sort()
  const stampKey = bundleKey(skillsBundleKey(root, dirNames))
  if (isBundleSeeded('builtin-skills', stampKey)) return

  const specs: SkillSpec[] = []
  let failures = 0
  for (const name of dirNames) {
    try {
      const spec = buildSkillSpec(root, name)
      if (spec) specs.push(spec)
    } catch (error) {
      failures++
      console.warn('[BuiltinSkills] Failed to read shipped package', { name, error })
    }
  }

  let skillRows: ReturnType<AppManagerService['listSkillRecords']> | null = null
  const globalSkills = () => (skillRows ??= appManager.listSkillRecords(null))

  let installed = 0
  let refreshed = 0
  let deferred = 0
  for (const spec of specs) {
    try {
      const slug = spec.store?.slug
      const existing = globalSkills().find(a => a.spec.store?.slug === slug)

      if (!existing) {
        skillRows = null
        await appManager.install(null, spec, {})
        installed++
        console.log(`[BuiltinSkills] Installed "${spec.name}" v${spec.version}`)
        continue
      }

      if (existing.status === 'uninstalled' || existing.userOverrides.skill?.deleted
        || existing.userOverrides.skill?.customized || !existing.userOverrides.skill) {
        if (existing.status !== 'uninstalled' && !existing.userOverrides.skill) deferred++
        console.log('[BuiltinSkills] Kept removed, customized or unmigrated skill', { appId: existing.id })
        continue
      }

      if (existing.spec.version !== spec.version) {
        const outcome = appManager.upgradeSpec(existing.id, spec)
        if (outcome.toVersion === spec.version) refreshed++
      }
    } catch (err) {
      if (err instanceof AppAlreadyInstalledError) {
        console.log('[BuiltinSkills] Kept the user\'s own skill of the same name', { name: spec.name })
        continue
      }
      failures++
      console.warn(`[BuiltinSkills] Failed to seed "${spec.name}":`, err)
    }
  }

  if (failures === 0 && deferred === 0) markBundleSeeded('builtin-skills', stampKey)

  const dt = performance.now() - t0
  console.log(
    `[BuiltinSkills] Done in ${dt.toFixed(1)}ms ` +
    `(${specs.length} shipped, ${installed} installed, ${refreshed} refreshed)`
  )
}
