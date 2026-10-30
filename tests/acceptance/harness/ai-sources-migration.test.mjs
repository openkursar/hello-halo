import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(path.join(tmpdir(), 'acceptance-ai-sources-migration-'))
after(() => rm(directory, { recursive: true, force: true }))
const source = new URL('../../e2e/fixtures/acceptance-ai-sources-migration.ts', import.meta.url)
const compiled = path.join(directory, 'fixture.cjs')
await build({ entryPoints: [fileURLToPath(source)], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', define: { 'import.meta.url': JSON.stringify(source.href) }, logLevel: 'silent' })
const { legacyAiSourcesFixture, legacyAiSourcesIdentity, installLegacyAiSources, readAiSourceMigration } = createRequire(import.meta.url)(compiled)
const key = 'local-only-historical-unit-fixture'
const url = 'http://127.0.0.1:8077/primary/v1/chat/completions'
const closed = { exitCode: 0, signalCode: null }

async function profile(name) {
  const root = path.join(directory, name)
  await mkdir(path.join(root, '.halo'), { recursive: true })
  const config = path.join(root, '.halo', 'config.json')
  const current = { aiSources: { version: 2, currentId: null, sources: [] }, appearance: { theme: 'dark' }, permissions: { canRead: true }, imChannels: { instances: [] }, unrelated: { keep: 'Preserved configuration' } }
  await writeFile(config, JSON.stringify(current))
  return { root, config, current }
}

test('the independent historical source matches the producer shape without v2 or OAuth fields', () => {
  const fixture = legacyAiSourcesFixture()
  assert.deepEqual(Object.keys(fixture.aiSources).sort(), ['current', 'custom'])
  assert.equal(fixture.aiSources.current, 'custom')
  assert.equal(fixture.aiSources.custom.provider, 'openai')
  assert.equal(fixture.aiSources.custom.name, 'Archived local API account')
  assert.match(fixture.aiSources.custom.id, /^[a-f0-9-]{36}$/)
  assert.equal(fixture.api.model, fixture.aiSources.custom.model)
  assert.equal(fixture.api.apiKey === fixture.aiSources.custom.apiKey, true)
  assert.deepEqual(fixture.aiSources.custom.availableModels, ['gpt-4o-mini', 'gpt-4o'])
  fixture.aiSources.custom.name = 'A caller cannot change the frozen source'
  assert.equal(legacyAiSourcesFixture().aiSources.custom.name, 'Archived local API account')
  assert.match(legacyAiSourcesIdentity().sha256, /^[a-f0-9]{64}$/)
})

test('closed-profile installation preserves unrelated config and never returns the fixture credential in its evidence', async () => {
  for (const identity of [true, false]) {
    const own = await profile(`identity-${identity}`)
    const expected = installLegacyAiSources(own.root, closed, url, key, identity)
    const stored = JSON.parse(await readFile(own.config, 'utf8'))
    assert.equal(Object.hasOwn(stored.aiSources, 'version'), false)
    assert.equal(Object.hasOwn(stored.aiSources.custom, 'id'), identity)
    assert.equal(stored.api.apiKey === key && stored.aiSources.custom.apiKey === key, true)
    assert.equal(stored.api.apiUrl, url)
    assert.equal(stored.aiSources.custom.apiUrl, url)
    assert.deepEqual(stored.unrelated, own.current.unrelated)
    assert.deepEqual(expected.control, { appearance: own.current.appearance, permissions: own.current.permissions, imChannels: own.current.imChannels })
    assert.equal(JSON.stringify(expected).includes(key), false)
    assert.equal(Object.hasOwn(expected.account, 'apiKey'), false)
  }
})

test('a live process, external endpoint or non-fixture credential cannot rewrite the profile', async () => {
  const own = await profile('rejected')
  const before = await readFile(own.config)
  for (const child of [{ exitCode: null, signalCode: null }, {}]) {
    assert.throws(() => installLegacyAiSources(own.root, child, url, key, true), /application to have exited/)
  }
  assert.throws(() => installLegacyAiSources(own.root, closed, 'https://example.com/v1', key, true), /loopback URL/)
  assert.throws(() => installLegacyAiSources(own.root, closed, url, 'unowned-credential', true), /local fixture credentials/)
  assert.deepEqual(await readFile(own.config), before)
})

test('config links are refused and current-state observations expose only credential presence', async () => {
  const own = await profile('symlink')
  const target = path.join(directory, 'outside-config.json')
  await writeFile(target, JSON.stringify(own.current))
  await rm(own.config)
  await symlink(target, own.config)
  const before = await readFile(target)
  assert.throws(() => installLegacyAiSources(own.root, closed, url, key, true), /real owned config file/)
  assert.deepEqual(await readFile(target), before)
  const readable = await profile('readable')
  await writeFile(readable.config, JSON.stringify({ ...readable.current, aiSources: { version: 2, currentId: 'existing', sources: [{ id: 'existing', name: 'Account', provider: 'openai', authType: 'api-key', apiUrl: url, apiKey: key, model: 'gpt-4o-mini', availableModels: [{ id: 'gpt-4o-mini', name: 'Model' }], createdAt: '2026-01-01T00:00:00.000Z' }] } }))
  const observation = readAiSourceMigration(readable.root)
  assert.equal(observation.sources[0].hasCredential, true)
  assert.equal(Object.hasOwn(observation.sources[0], 'apiKey'), false)
  assert.equal(JSON.stringify(observation).includes(key), false)
})
