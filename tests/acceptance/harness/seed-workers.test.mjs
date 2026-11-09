import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const electron = require('electron')
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const fixtures = path.join(repository, 'tests/e2e/fixtures')
const directory = await mkdtemp(path.join(tmpdir(), 'halo-seed-workers-'))
after(() => rm(directory, { recursive: true, force: true }))
await symlink(path.join(repository, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
const config = path.join(directory, 'seed-config.mjs')
await build({ entryPoints: [path.join(fixtures, 'seed-sdk-bundle.ts')], outfile: config, platform: 'node', format: 'esm', bundle: true, logLevel: 'silent' })
const { seedSdkAliases } = await import(pathToFileURL(config).href)

async function profile(name) {
  const root = path.join(directory, name)
  const halo = path.join(root, '.halo')
  await mkdir(path.join(halo, 'temp', 'conversations'), { recursive: true })
  await mkdir(path.join(halo, 'temp', 'artifacts'), { recursive: true })
  await mkdir(path.join(halo, 'spaces'), { recursive: true })
  await writeFile(path.join(halo, 'config.json'), JSON.stringify({ api: { provider: 'openai', apiKey: '', apiUrl: 'http://127.0.0.1:9', model: 'fixture' },
    aiSources: { version: 2, currentId: null, sources: [] }, modelConfigSkipped: true, agent: { sdkEngine: 'halo' } }))
  return root
}

async function compile(worker, externalPackages = true) {
  const output = path.join(directory, worker.replace(/\.ts$/, '.cjs'))
  const result = await build({ entryPoints: [path.join(fixtures, worker)], outfile: output,
    platform: 'node', format: 'cjs', bundle: true, metafile: true, logLevel: 'silent',
    ...(externalPackages ? { packages: 'external', alias: seedSdkAliases, external: ['better-sqlite3', 'electron', '@parcel/watcher'] }
      : { external: ['better-sqlite3'] }),
  })
  const unresolved = Object.values(result.metafile.outputs).flatMap(entry => entry.imports)
    .filter(entry => entry.external && entry.path.startsWith('@hello-halo/agent-sdk/collaboration'))
  assert.deepEqual(unresolved, [], 'A CommonJS seed must not require the SDK import-only collaboration entries')
  return output
}

function execute(worker, root, payload, dedicated = false) {
  const result = spawnSync(electron, [worker, JSON.stringify(payload)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HALO_DATA_DIR: path.join(root, '.halo') },
    encoding: 'utf8', cwd: directory, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return dedicated ? JSON.parse(result.output[3]) : JSON.parse(result.stdout.trim().split('\n').at(-1))
}

function rows(root, sql) {
  const code = `const Database=require('better-sqlite3'); const db=new Database(process.argv[1],{readonly:true}); process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all())); db.close();`
  const result = spawnSync(electron, ['-e', code, path.join(root, '.halo', 'halo.db'), sql], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: directory, encoding: 'utf8', timeout: 20000,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

for (const legacySaved of [false, true]) test(`the actual collaboration seed creates its conversation and scoped room (legacySaved=${legacySaved})`, async () => {
  const root = await profile(`collaboration-${legacySaved}`)
  const result = execute(await compile('team-collab-seed-worker.ts'), root, { directory: root, legacySaved,
    teamName: 'Seed team', memberName: 'Reader', conversationTitle: 'Seed conversation' })
  assert.equal(result.teamId, 'collab-team')
  assert.equal(result.roomId, 'collab-room')
  assert.deepEqual(rows(root, 'SELECT id, ephemeral, coordinator_conversation_id FROM teams'), [
    { id: result.teamId, ephemeral: legacySaved ? 0 : 1, coordinator_conversation_id: result.conversationId },
  ])
  assert.equal(rows(root, 'SELECT id FROM team_epochs')[0].id, result.roomId)
  const transcript = JSON.parse(await readFile(path.join(root, '.halo/temp/conversations', `${result.conversationId}.json`), 'utf8'))
  assert.equal(transcript.messages.length, 2)
})

test('the long-conversation seed still returns its dedicated result and real saved messages', async () => {
  const root = await profile('conversation')
  const result = execute(await compile('seed-conversation-worker.ts'), root, { testConfigDir: root, options: { messageCount: 4, variety: 'mixed' } }, true)
  const transcript = JSON.parse(await readFile(path.join(root, '.halo/temp/conversations', `${result.conversationId}.json`), 'utf8'))
  assert.deepEqual(transcript.messages.map(message => message.id), result.messageIds)
  assert.equal(result.messageIds.length, 4)
})

test('the Git workspace seed retains actual conversation and tool evidence', async () => {
  const root = await profile('workspace')
  const repoRoot = path.join(root, 'project'); await mkdir(repoRoot)
  const result = execute(await compile('git-workspace-seed-worker.ts'), root, {
    repoRoot, spaceName: 'Seed workspace', conversationTitle: 'Seed edit', userMessage: 'Inspect the local file.', replyText: 'The file was inspected.',
    edits: [{ tool: 'Write', filePath: path.join(repoRoot, 'fixture.txt'), content: 'synthetic evidence' }],
    followUp: { content: 'Keep that evidence.', references: [] },
  })
  const transcript = JSON.parse(await readFile(path.join(root, '.halo/spaces', result.spaceId, '.halo/conversations', `${result.conversationId}.json`), 'utf8'))
  assert.equal(transcript.messages.length, 3)
  assert.equal(transcript.messages[1].id, result.replyMessageId)
  assert.equal(transcript.messages[2].id, result.followUpMessageId)
})

test('the existing bundled people seed remains compatible with the shared protocol', async () => {
  const root = await profile('people')
  const worker = await compile('people-seed-worker.ts', false)
  const result = spawnSync(electron, [worker, JSON.stringify({ directory: root, count: 3 })], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HALO_DATA_DIR: path.join(root, '.halo') },
    cwd: directory, encoding: 'utf8', timeout: 20000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(rows(root, 'SELECT id FROM installed_apps').length, 4)
  assert.equal(rows(root, 'SELECT id FROM teams').length, 2)
})
