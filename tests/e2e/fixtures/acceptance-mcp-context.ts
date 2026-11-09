import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import Database from 'better-sqlite3'

export async function withRejectedMcpPreferenceWrites(profile: string, appId: string, operation: () => Promise<void>) {
  const filename = join(profile, '.halo', 'halo.db')
  const owned = relative(realpathSync(profile), realpathSync(filename))
  assert.ok(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink())
  assert.ok(owned && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`))
  const database = new Database(filename, { fileMustExist: true })
  const trigger = `acceptance_mcp_context_${randomUUID().replaceAll('-', '')}`
  let installed = false
  try {
    const target = database.prepare("SELECT id FROM installed_apps WHERE id = ? AND json_extract(spec_json, '$.type') = 'mcp'").get(appId)
    assert.ok(target, 'The write fault must target an installed MCP in the owned profile')
    database.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF user_overrides_json ON installed_apps
      WHEN NEW.id = '${appId.replaceAll("'", "''")}'
      BEGIN SELECT RAISE(ABORT, 'Acceptance MCP preference write refused'); END`)
    installed = true
    await operation()
  } finally {
    try { if (installed) database.exec(`DROP TRIGGER ${trigger}`) }
    finally { database.close() }
  }
}
