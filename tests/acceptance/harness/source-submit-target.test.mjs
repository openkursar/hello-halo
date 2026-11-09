import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-source-submit-'))
after(() => fs.rm(directory, { recursive: true, force: true }))
const entry = fileURLToPath(new URL('../../e2e/fixtures/acceptance-app.ts', import.meta.url))
const compiled = path.join(directory, 'fixture.mjs')
await build({ entryPoints: [entry], outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{
  name: 'no-application-launch', setup(builder) {
    builder.onResolve({ filter: /^(@playwright\/test|\.\/electron|\.\/acceptance-model)$/ }, args => ({ path: args.path, namespace: 'submission-boundary' }))
    builder.onLoad({ filter: /.*/, namespace: 'submission-boundary' }, args => ({ loader: 'js', contents: args.path === '@playwright/test'
      ? `import assert from 'node:assert/strict'; export const test={extend:value=>value}; export const expect={poll: callback=>({async toBe(expected){for(let i=0;i<3;i++){const actual=await callback();if(actual===expected)return;}throw new Error('No matching polled value');}})};`
      : args.path === './electron'
        ? `export function createTestConfigDir(){throw new Error('No profile launch');}export function getAppEntryPath(){throw new Error('No app entry');}export function launchElectronApp(){throw new Error('No Electron');}export function cleanupTestConfigDir(){throw new Error('No profile cleanup');}`
        : `export function startAcceptanceModel(){throw new Error('No model launch');}` }))
  },
}] })
const { attachProbe, sendAcceptanceMessage } = await import(pathToFileURL(compiled).href)

async function pageFor(context, onSend) {
  const listeners = new Map(), histories = new Map(), reads = []
  let text = ''
  const subscribe = name => callback => { listeners.set(name, callback); return () => listeners.delete(name) }
  globalThis.halo = {
    onAgentTurnStart: subscribe('start'), onAgentComplete: subscribe('complete'),
    onAgentError: subscribe('error'), onAgentThought: subscribe('thought'),
    async getConversation(spaceId, conversationId) {
      reads.push({ kind: 'space', spaceId, conversationId })
      if (!histories.has(conversationId)) return { success: false, error: 'Unknown source' }
      return { success: true, data: { messages: histories.get(conversationId) } }
    },
    async appChatTranscript(input) {
      reads.push({ kind: 'person', ...input })
      if (!histories.has(input.conversationId)) return { success: false, error: 'Unknown person chat' }
      return { success: true, data: { messages: histories.get(input.conversationId) } }
    },
  }
  const emit = (name, conversationId) => listeners.get(name)?.({ type: name === 'start' ? 'turn-start' : 'complete', conversationId, spaceId: 'space' })
  const persist = (conversationId, changes = {}) => histories.set(conversationId, [{ role: 'user', content: text.trim(), timestamp: new Date().toISOString(), ...changes }])
  const page = {
    evaluate: async (callback, value) => callback(value),
    locator: () => ({ first() { return this }, fill: async value => { text = value }, click: async () => onSend({ emit, persist, histories }) }),
  }
  await attachProbe(page)
  context.after(() => { globalThis.acceptanceProbe?.dispose(); delete globalThis.acceptanceProbe; delete globalThis.halo })
  return { page, reads }
}
const child = 'app-chat:worker:team:group:work'

for (const order of ['source-first', 'child-first']) test(`the actual probe and send helper keep the UI source when a collaborator starts before observation (${order})`, async context => {
  const source = 'opaque-source-without-a-uuid-shape'
  const { page, reads } = await pageFor(context, ({ emit, persist }) => {
    persist(source)
    for (const id of order === 'source-first' ? [source, child] : [child, source]) emit('start', id)
    emit('complete', child)
  })
  const result = await sendAcceptanceMessage(page, '  Requested source work  ')
  assert.equal(result.conversationId, source)
  assert.equal(result.spaceId, 'space')
  assert.equal(globalThis.acceptanceProbe.turns.at(-1).conversationId, order === 'source-first' ? child : source)
  assert.deepEqual(reads, [{ kind: 'space', spaceId: 'space', conversationId: source }])
})

for (const source of ['app-chat:person', 'app-chat:person:local:direct:chosen-chat']) test(`native source ${source} is not mistaken for its temporary member`, async context => {
  const { page, reads } = await pageFor(context, ({ emit, persist }) => { persist(source); emit('start', source); emit('start', child) })
  assert.equal((await sendAcceptanceMessage(page, 'Native person request')).conversationId, source)
  assert.deepEqual(reads, [{ kind: 'person', appId: 'person', spaceId: 'space', conversationId: source, limit: 50 }])
})

test('an expected source still requires its own event and new human input', async context => {
  const target = { spaceId: 'space', conversationId: 'expected-source' }
  const { page } = await pageFor(context, ({ emit, persist }) => {
    persist('other-source'); emit('start', 'other-source'); emit('start', target.conversationId)
  })
  await assert.rejects(sendAcceptanceMessage(page, 'Owner request', { expectedTarget: target }), /No verified source/)
})

test('an explicit source disambiguates two real source starts without dropping its input check', async context => {
  const target = { spaceId: 'space', conversationId: 'expected-source' }
  const { page } = await pageFor(context, ({ emit, persist }) => {
    for (const id of ['other-source', target.conversationId]) { persist(id); emit('start', id) }
    emit('start', child)
  })
  assert.equal((await sendAcceptanceMessage(page, 'Owner request', { expectedTarget: target })).conversationId, target.conversationId)
})

test('multiple verified source identities fail instead of selecting an arbitrary event', async context => {
  const { page } = await pageFor(context, ({ emit, persist }) => {
    for (const id of ['one-source', 'another-source']) { persist(id); emit('start', id) }
  })
  await assert.rejects(sendAcceptanceMessage(page, 'The same text'), /multiple source conversations/)
})

for (const change of [
  { timestamp: '2000-01-01T00:00:00.000Z' },
  { source: 'team-message' },
  { metadata: { teamTriggerKind: 'member_stopped' } },
  { content: 'A different input' },
]) test(`a source event without this new human submission is not accepted: ${JSON.stringify(change)}`, async context => {
  const { page } = await pageFor(context, ({ emit, persist }) => { persist('source', change); emit('start', 'source'); emit('start', child) })
  await assert.rejects(sendAcceptanceMessage(page, 'Owner request'), /No verified source/)
})

test('only child, IM or automation starts cannot satisfy a workspace submission', async context => {
  const { page, reads } = await pageFor(context, ({ emit }) => {
    for (const id of [child, 'app-chat:person:wecom-bot:group:room', 'app-run:person:scheduled']) emit('start', id)
  })
  await assert.rejects(sendAcceptanceMessage(page, 'Owner request'), /No verified source/)
  assert.deepEqual(reads, [])
})

test('several events for the verified source do not create identity ambiguity', async context => {
  const { page } = await pageFor(context, ({ emit, persist }) => {
    persist('source'); emit('start', 'source'); emit('complete', 'source'); emit('start', child); emit('start', 'source')
  })
  assert.equal((await sendAcceptanceMessage(page, 'Owner request')).conversationId, 'source')
})
