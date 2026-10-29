import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { PNG } from 'pngjs'

const directory = await mkdtemp(path.join(tmpdir(), 'acceptance-conversation-migration-'))
after(() => rm(directory, { recursive: true, force: true }))
const source = new URL('../../e2e/fixtures/acceptance-conversation-migration.ts', import.meta.url)
const compiled = path.join(directory, 'fixture.cjs')
await build({ entryPoints: [fileURLToPath(source)], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', define: { 'import.meta.url': JSON.stringify(source.href) }, logLevel: 'silent' })
const { legacyConversationFixture, legacyConversationIdentity, installLegacyConversation } = createRequire(import.meta.url)(compiled)

async function emptyProfile(name) {
  const profile = path.join(directory, name)
  const space = path.join(profile, 'space')
  const conversations = path.join(space, '.halo', 'conversations')
  await mkdir(conversations, { recursive: true })
  const current = { id: 'target', spaceId: 'owned-space', title: 'Empty target', version: 2, messages: [] }
  const control = { id: 'control', spaceId: 'owned-space', title: 'Unchanged control', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 2 }
  const main = path.join(conversations, 'target.json')
  const index = path.join(conversations, 'index.json')
  await writeFile(main, JSON.stringify(current))
  await writeFile(index, JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', conversations: [{ ...current, updatedAt: '2026-01-02T00:00:00.000Z' }, control] }))
  return { profile, space, conversations, main, index, control }
}

test('the frozen unversioned input has historical fields and a separately decoded real image', () => {
  const fixture = legacyConversationFixture('space', 'conversation')
  assert.equal(Object.hasOwn(fixture, 'version'), false)
  assert.equal(Object.hasOwn(fixture, 'sessionId'), false)
  assert.equal(Object.hasOwn(fixture, 'engineId'), false)
  assert.equal(fixture.messages.length, 4)
  assert.equal(new Set(fixture.messages.map(message => message.id)).size, 4)
  const image = fixture.messages[0].images[0]
  const bytes = Buffer.from(image.data, 'base64')
  assert.equal(bytes.length, image.size)
  const png = PNG.sync.read(bytes)
  assert.deepEqual([png.width, png.height], [2, 2])
  assert.deepEqual([...png.data], [224, 24, 48, 255, 16, 144, 80, 255, 24, 96, 224, 255, 232, 184, 16, 255])
  assert.deepEqual(fixture.messages[1].thoughts.map(thought => thought.type), ['thinking', 'tool_use', 'tool_result', 'result'])
  assert.deepEqual(fixture.messages[1].tokenUsage, { inputTokens: 82, outputTokens: 31, cacheReadTokens: 16, cacheCreationTokens: 8, totalCostUsd: 0.0012, contextWindow: 200000 })
  assert.equal(fixture.messages[1].toolCalls[0].output, 'Archived notes contain maple-782.')
  const identity = legacyConversationIdentity()
  assert.match(identity.sha256, /^[a-f0-9]{64}$/)
  fixture.messages[0].content = 'A caller cannot mutate the frozen source.'
  assert.notEqual(legacyConversationFixture('space', 'conversation').messages[0].content, fixture.messages[0].content)
  assert.deepEqual(legacyConversationIdentity(), identity)
})

test('only the closed empty target becomes historical input and its index keeps the independent control', async () => {
  const own = await emptyProfile('closed')
  const output = installLegacyConversation(own.profile, { exitCode: 0, signalCode: null }, own.space, 'owned-space', 'target')
  assert.deepEqual(JSON.parse(await readFile(own.main, 'utf8')), output.legacy)
  const index = JSON.parse(await readFile(own.index, 'utf8'))
  assert.deepEqual(index.conversations.find(entry => entry.id === 'control'), own.control)
  assert.equal(index.conversations.find(entry => entry.id === 'target').messageCount, 4)
  await assert.rejects(readFile(output.thoughts), { code: 'ENOENT' })
})

test('an unknown or live child and a populated target are rejected without rewriting existing bytes', async () => {
  const own = await emptyProfile('live')
  const main = await readFile(own.main)
  const index = await readFile(own.index)
  for (const child of [{ exitCode: null, signalCode: null }, {}]) {
    assert.throws(() => installLegacyConversation(own.profile, child, own.space, 'owned-space', 'target'), /process to have exited/)
  }
  assert.deepEqual(await readFile(own.main), main)
  assert.deepEqual(await readFile(own.index), index)
  const populated = JSON.stringify({ id: 'target', spaceId: 'owned-space', version: 2, messages: [{ id: 'keep', content: 'Keep existing work.' }] })
  await writeFile(own.main, populated)
  assert.throws(() => installLegacyConversation(own.profile, { exitCode: 0, signalCode: null }, own.space, 'owned-space', 'target'), /Only the empty conversation/)
  assert.equal(await readFile(own.main, 'utf8'), populated)
})

test('a directory outside the owned profile and a dangling thoughts link are rejected', async () => {
  const own = await emptyProfile('owned')
  const other = await emptyProfile('other')
  const main = await readFile(other.main)
  assert.throws(() => installLegacyConversation(own.profile, { exitCode: 0, signalCode: null }, other.space, 'owned-space', 'target'), /isolated profile/)
  assert.deepEqual(await readFile(other.main), main)
  const target = path.join(directory, 'must-not-be-created.json')
  await symlink(target, path.join(own.conversations, 'target.thoughts.json'))
  const ownMain = await readFile(own.main)
  assert.throws(() => installLegacyConversation(own.profile, { exitCode: 0, signalCode: null }, own.space, 'owned-space', 'target'), /Missing expected exception/)
  assert.deepEqual(await readFile(own.main), ownMain)
  await assert.rejects(readFile(target), { code: 'ENOENT' })
})
