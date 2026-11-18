const { realpathSync, readdirSync, existsSync } = require('node:fs')
const { join, relative, isAbsolute, sep } = require('node:path')
const Database = require('better-sqlite3')
const profile = realpathSync(process.argv[2])
const file = realpathSync(join(profile, '.halo', 'halo.db'))
const owned = relative(profile, file)
if (!owned || isAbsolute(owned) || owned === '..' || owned.startsWith(`..${sep}`)) throw new Error('The observed database is outside the owned test profile')
const database = new Database(file, { readonly: true, fileMustExist: true })
try {
  const participants = database.prepare('SELECT app_id FROM team_participants ORDER BY app_id').all().map(row => row.app_id)
  const folder = join(profile, '.halo', 'temp', 'collaboration')
  const workspaces = existsSync(folder) ? readdirSync(folder).sort() : []
  process.stdout.write(JSON.stringify({ participants, workspaces }))
} finally { database.close() }
