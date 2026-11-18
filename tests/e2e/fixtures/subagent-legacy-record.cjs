const { realpathSync } = require('node:fs')
const { join, relative, isAbsolute, sep } = require('node:path')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const profile = realpathSync(process.argv[2])
const member = process.argv[3]
if (!/^halo-e2e-test-\d+$/.test(require('node:path').basename(profile))) throw new Error('Legacy mutation requires an owned acceptance profile')
const file = realpathSync(join(profile, '.halo', 'halo.db'))
const owned = relative(profile, file)
if (!owned || isAbsolute(owned) || owned === '..' || owned.startsWith(`..${sep}`)) throw new Error('Database outside owned profile')
const database = new Database(file, { fileMustExist: true })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
try {
  const result = database.transaction(() => {
    const rows = database.prepare('SELECT * FROM team_participants WHERE app_id = ?').all(member)
    if (rows.length !== 1 || rows[0].origin !== 'local' || !rows[0].execution_json) throw new Error('Expected one exact local participant')
    const row = rows[0]
    const before = JSON.parse(row.execution_json)
    if (!before.inheritedReasoning || before.modelBinding) throw new Error('Expected a basic inheritance snapshot without advanced binding')
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    const unchanged = () => tables.filter(name => name !== 'team_participants').map(name => ({ name, rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }))
    const transcriptBefore = hash(unchanged())
    const after = { ...before }
    delete after.inheritedReasoning
    const changed = database.prepare('UPDATE team_participants SET execution_json = ? WHERE app_id = ? AND execution_json = ?').run(JSON.stringify(after), member, row.execution_json)
    if (changed.changes !== 1) throw new Error('Legacy row changed concurrently')
    const transcriptAfter = hash(unchanged())
    if (transcriptBefore !== transcriptAfter) throw new Error('Legacy simulation changed transcript or unrelated tables')
    const stored = database.prepare('SELECT * FROM team_participants WHERE app_id = ?').get(member)
    if (hash({ ...row, execution_json: undefined }) !== hash({ ...stored, execution_json: undefined })) throw new Error('Legacy simulation changed participant identity')
    return { member, removed: ['inheritedReasoning'], transcriptBefore, transcriptAfter, originalReasoning: before.inheritedReasoning, unchangedSelection: after.modelSelection }
  })()
  process.stdout.write(JSON.stringify(result))
} finally { database.close() }
