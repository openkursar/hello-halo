import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDatabaseManager } from '../../../src/main/platform/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../src/main/apps/manager/migrations'
import type { SkillSpec } from '../../../src/shared/apps/spec-types'
import type { SkillInstallationState } from '../../../src/shared/types/skills'

export type LegacySkillKind = 'active' | 'incorrect-marker' | 'paused' | 'uninstalled' | 'deleted' | 'control'

export interface SeededLegacySkill {
  id: string
  kind: LegacySkillKind
  name: string
  body: string
  spec: SkillSpec
  status: 'active' | 'paused' | 'uninstalled'
  overrides: { skill?: SkillInstallationState }
  destination: string
}

export interface LegacySkillRow {
  id: string
  status: string
  spec_json: string
  user_overrides_json: string
}

function main() {
  const { profile, action = 'seed', ids = [] } = JSON.parse(process.argv[2]) as { profile: string; action?: 'seed' | 'inspect'; ids?: string[] }
  const haloDir = join(profile, '.halo')
  const databasePath = join(haloDir, 'halo.db')
  if (action === 'seed' && existsSync(databasePath)) throw new Error('Legacy seed requires a fresh database before application launch')
  if (action === 'inspect' && !existsSync(databasePath)) throw new Error('Cannot inspect a missing application database')
  mkdirSync(haloDir, { recursive: true })
  const manager = createDatabaseManager(databasePath)
  let result: unknown
  try {
    const db = manager.getAppDatabase()
    if (action === 'inspect') {
      const read = db.prepare('SELECT id, status, spec_json, user_overrides_json FROM installed_apps WHERE id = ?')
      result = ids.map(id => read.get(id))
    } else {
      manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
      const kinds: LegacySkillKind[] = ['active', 'incorrect-marker', 'paused', 'uninstalled', 'deleted', 'control']
      const records = kinds.map((kind, index): SeededLegacySkill => {
        const name = `legacy-${kind}-evidence`
        const body = `Original generic instructions for ${kind}. Preserve the supporting evidence.`
        const destination = join(profile, '.agents', 'skills', name, 'SKILL.md')
        const spec: SkillSpec = {
          spec_version: '1.0', type: 'skill', name, display_name: name, version: '1.0.0',
          author: 'Acceptance fixture', description: `Generic ${kind} upgrade evidence`,
          skill_files: {
            'SKILL.md': `---\nname: ${name}\ndescription: Generic ${kind} upgrade evidence\nuser-invocable: true\nx-acceptance-metadata: preserve-me\n---\n\n${body}\n`,
            'references/nested/evidence.md': `Supporting text for ${kind}.\n`,
          },
          skill_assets: {
            'templates/evidence.bin': { encoding: 'base64', content: Buffer.from([0, 255, 128, 13, 10, 0, index]).toString('base64') },
          },
        }
        const overrides: SeededLegacySkill['overrides'] = kind === 'incorrect-marker'
          ? { skill: { version: 1, filePath: destination, migrationWarning: 'The previous skill files are missing. Restore them before using this skill.' } }
          : kind === 'deleted' ? { skill: { version: 1, filePath: destination, deleted: true } }
            : kind === 'control' ? { skill: { version: 1, filePath: destination } } : {}
        return { id: randomUUID(), kind, name, body, spec, overrides, destination, status: kind === 'paused' ? 'paused' : ['uninstalled', 'deleted'].includes(kind) ? 'uninstalled' : 'active' }
      })
      const insert = db.prepare(`INSERT INTO installed_apps
        (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at, uninstalled_at)
        VALUES (?, ?, NULL, ?, ?, '{}', ?, '{"granted":[],"denied":[]}', ?, ?)`)
      db.transaction(() => {
        for (const record of records) insert.run(record.id, record.name, JSON.stringify(record.spec), record.status, JSON.stringify(record.overrides), Date.now(), record.status === 'uninstalled' ? Date.now() : null)
      })()
      const control = records.find(record => record.kind === 'control')!
      const directory = dirname(control.destination)
      for (const [relative, content] of Object.entries(control.spec.skill_files!)) {
        const file = join(directory, relative)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
      }
      for (const [relative, asset] of Object.entries(control.spec.skill_assets!)) {
        const file = join(directory, relative)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, Buffer.from(asset.content, 'base64'))
      }
      result = records
    }
  } finally {
    manager.closeAll()
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

main()
