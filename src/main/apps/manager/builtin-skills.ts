/**
 * Ships repo-authored skills under `resources/builtin-skills/<id>/` (SKILL.md
 * frontmatter + files, committed to git, shipped inside the asar) as global
 * skills, installed/refreshed through the existing skill-sync pipeline.
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

import type { AppManagerService } from './types'
import type { SkillSpec } from '../spec/schema'
import { readSkillFiles } from './builtin-loader'
import { extractFrontmatterField } from '../../../shared/skill-frontmatter'
import { AppAlreadyInstalledError } from './errors'

/** Slug namespace identifying rows this seeder owns (install + GC scope). */
const BUILTIN_SKILL_SLUG_PREFIX = 'halo-builtin-skills/'

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
  const skillFiles = readSkillFiles(skillDir)
  const md = skillFiles['SKILL.md']
  if (!md) {
    console.warn(`[BuiltinSkills] Skipping "${dirName}" — no SKILL.md`)
    return null
  }

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
    skill_files: skillFiles,
    store: {
      slug: `${BUILTIN_SKILL_SLUG_PREFIX}${dirName}`,
      tags: [],
      install_source: 'bundled' as const,
    },
  } as SkillSpec
}

function isSeededSkillRow(spec: { type: string; store?: { slug?: string } }): boolean {
  return spec.type === 'skill' && (spec.store?.slug ?? '').startsWith(BUILTIN_SKILL_SLUG_PREFIX)
}

/**
 * Scan resources/builtin-skills/, install/refresh each skill globally, and GC
 * seeded rows whose source directory no longer ships. Failures are isolated
 * per skill and logged — a broken built-in skill never blocks the others.
 */
export async function seedBuiltinSkills(appManager: AppManagerService): Promise<void> {
  const t0 = performance.now()
  const root = getBuiltinSkillsDir()
  if (!root) {
    console.log('[BuiltinSkills] resources/builtin-skills/ not present — skipping.')
    return
  }

  const specs: SkillSpec[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!statSync(join(root, entry.name)).isDirectory()) continue
    const spec = buildSkillSpec(root, entry.name)
    if (spec) specs.push(spec)
  }

  const globalSkills = () => appManager.listApps({ spaceId: null, type: 'skill' })

  let installed = 0
  let refreshed = 0
  for (const spec of specs) {
    try {
      const slug = spec.store?.slug
      const existing = globalSkills().find(a => a.spec.store?.slug === slug)

      if (!existing) {
        await appManager.install(null, spec, {})
        installed++
        console.log(`[BuiltinSkills] Installed "${spec.name}" v${spec.version}`)
        continue
      }

      if (existing.status === 'uninstalled') {
        // User explicitly removed this skill — honour it across boots.
        continue
      }

      if (existing.spec.version !== spec.version) {
        appManager.updateSpec(existing.id, spec as unknown as Record<string, unknown>)
        refreshed++
        console.log(
          `[BuiltinSkills] Refreshed "${spec.name}": ${existing.spec.version} → ${spec.version}`
        )
      }
    } catch (err) {
      if (err instanceof AppAlreadyInstalledError) continue
      console.warn(`[BuiltinSkills] Failed to seed "${spec.name}":`, err)
    }
  }

  // GC — only when the scan produced a non-empty picture of what should exist;
  // an empty/unreadable resources dir must never delete user rows.
  let removed = 0
  if (specs.length > 0) {
    const expected = new Set(specs.map(s => s.store?.slug))
    for (const row of globalSkills()) {
      if (!isSeededSkillRow(row.spec) || expected.has(row.spec.store?.slug)) continue
      try {
        await appManager.uninstall(row.id)
      } catch {
        /* may already be uninstalled — proceed to delete */
      }
      try {
        await appManager.deleteApp(row.id)
        removed++
        console.log(`[BuiltinSkills] GC: removed stale built-in skill "${row.specId}"`)
      } catch (err) {
        console.warn(`[BuiltinSkills] GC: failed to remove "${row.specId}":`, err)
      }
    }
  }

  const dt = performance.now() - t0
  console.log(
    `[BuiltinSkills] Done in ${dt.toFixed(1)}ms ` +
    `(${specs.length} shipped, ${installed} installed, ${refreshed} refreshed, ${removed} removed)`
  )
}
