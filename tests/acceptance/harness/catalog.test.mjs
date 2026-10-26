import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { loadCatalog, variantsFor } from '../../../scripts/acceptance/lib/catalog.mjs'

const module = { version: 1, id: 'chat', title: 'Chat', description: 'Have a conversation', paths: ['src/chat/**'], dependsOn: [], scope: 'Desktop owners' }
const scenario = { id: 'chat.send', title: 'Send a message', verifies: ['reply'], platforms: ['darwin', 'win32'], profiles: ['fast', 'regression'], evidence: 'app-e2e', mode: 'scripted', automation: 'planned' }
const story = { version: 1, id: 'chat.basic', module: 'chat', title: 'Talk', story: 'The owner receives a reply', basis: 'documented', references: [], promises: { reply: 'A message receives a reply' }, scenarios: [scenario] }

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-catalog-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (name, value) => { const file = path.join(root, 'tests/acceptance', name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, stringify(value)) }
  await write('catalog/chat/module.yaml', module)
  await write('catalog/chat/basic.yaml', story)
  return { root, write }
}

test('unimplemented scenarios remain in the catalog and variants expand explicitly', async context => {
  const { root, write } = await fixture(context)
  await write('catalog/chat/basic.yaml', { ...story, scenarios: [{ ...scenario, variants: { member: ['lead', 'member'], state: ['saved', 'reopened'] } }] })
  const catalog = await loadCatalog(root)
  assert.equal(catalog.cases[0].automation, 'planned')
  assert.equal(variantsFor(catalog.cases[0]).length, 4)
  assert.equal(catalog.approvals.length, 0)
})

test('missing promised outcomes and duplicate YAML keys are rejected', async context => {
  const { root, write } = await fixture(context)
  await write('catalog/chat/basic.yaml', { ...story, promises: { ...story.promises, persistence: 'History survives restart' } })
  await assert.rejects(loadCatalog(root), /promises without scenarios: persistence/)
  await fs.writeFile(path.join(root, 'tests/acceptance/catalog/chat/basic.yaml'), 'id: first\nid: second\n')
  await assert.rejects(loadCatalog(root), /Map keys must be unique/)
})

test('shared capability scenarios acquire the consuming context and invalidate approval when conditions change', async context => {
  const { root, write } = await fixture(context)
  const contract = { version: 1, id: 'messaging', title: 'Messaging', promises: { reply: 'A reply is received' }, scenarios: [{ ...scenario, id: 'send', preconditions: ['Every member is available'] }] }
  await write('contracts/messaging.yaml', contract)
  await write('catalog/chat/basic.yaml', { ...story, uses: [{ contract: 'messaging', scenarios: ['send'] }] })
  const before = await loadCatalog(root)
  const imported = before.cases.find(item => item.id === 'chat.basic.send')
  assert.deepEqual(imported.verifies, ['messaging.reply'])
  const approval = { version: 1, storyId: story.id, semanticHash: before.stories[0].semanticHash, decision: 'approved', reviewer: 'maintainer', decidedAt: '2026-01-01T00:00:00.000Z' }
  await fs.mkdir(path.join(root, 'tests/acceptance/approvals'))
  await fs.writeFile(path.join(root, 'tests/acceptance/approvals/chat.json'), JSON.stringify(approval))
  assert.equal((await loadCatalog(root)).approvals[0].current, true)
  await write('contracts/messaging.yaml', { ...contract, scenarios: [{ ...contract.scenarios[0], preconditions: ['Only the lead is available'] }] })
  assert.equal((await loadCatalog(root)).approvals[0].current, false)
})

test('invalid references and unreasoned manual classification fail validation', async context => {
  const { root, write } = await fixture(context)
  await write('catalog/chat/basic.yaml', { ...story, scenarios: [{ ...scenario, verifies: ['unknown'] }] })
  await assert.rejects(loadCatalog(root), /unknown promise/)
  await write('catalog/chat/basic.yaml', { ...story, scenarios: [{ ...scenario, automation: 'manual' }] })
  await assert.rejects(loadCatalog(root), /Manual scenarios require a reason/)
})

test('implementing an unchanged scenario does not ask the owner to approve the same product behavior again', async context => {
  const { root, write } = await fixture(context)
  const original = await loadCatalog(root)
  await write('catalog/chat/basic.yaml', { ...story, scenarios: [{ ...scenario, automation: 'automated', profiles: ['regression'] }] })
  const updated = await loadCatalog(root)
  assert.equal(original.stories[0].semanticHash, updated.stories[0].semanticHash)
  assert.notEqual(original.hash, updated.hash)
})
