import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { AcceptanceApp } from '../fixtures/acceptance-app'
import {
  test, expect, knowledgeAcceptance, knowledgeFileRow, readKnowledgeBases, readKnowledgeFiles,
} from '../fixtures/acceptance-knowledge'
import {
  assertUpgradeSourcesRetained, assertUpgradeVisible, openUpgradeKnowledge, prepareUpgradeKnowledge,
  readUpgradeRecord, seedOldKnowledge, setKnowledgeLearning, upgradeSnapshot, waitForKnowledgeUpgrade,
  type UpgradeKnowledge,
} from '../fixtures/acceptance-knowledge-upgrade'

test.setTimeout(180000)

async function preparePair(app: AcceptanceApp, page: Page, strings: 'shared' | 'cell' = 'shared') {
  const control = await prepareUpgradeKnowledge(app, page, 'control')
  const target = await prepareUpgradeKnowledge(app, page, 'target', strings)
  const order = (await readKnowledgeBases(page)).map(kb => kb.id)
  expect(order.indexOf(target.kb.id)).toBeLessThan(order.indexOf(control.kb.id))
  return { control, target }
}

async function restartWithControl(app: AcceptanceApp, control: UpgradeKnowledge, target: UpgradeKnowledge) {
  let before!: ReturnType<typeof upgradeSnapshot>
  const page = await app.restart(profile => {
    before = upgradeSnapshot(target)
    seedOldKnowledge(profile, control, 'learned')
  })
  // The older control is processed after the target by the real startup sweep.
  await waitForKnowledgeUpgrade(page, control)
  return { page, before }
}

for (const previousState of ['learned', 'no-text'] as const) {
  test(`startup repairs an active ${previousState} spreadsheet cache without changing original or curated files`, knowledgeAcceptance('knowledge.sources.upgrade', 'none', { state: previousState }), async ({ acceptanceApp, model, window }, info) => {
    const { control, target } = await preparePair(acceptanceApp, window, previousState === 'no-text' ? 'cell' : 'shared')
    let seeded!: ReturnType<typeof upgradeSnapshot>
    const page = await acceptanceApp.restart(profile => {
      seedOldKnowledge(profile, control, 'learned')
      seedOldKnowledge(profile, target, previousState)
      seeded = upgradeSnapshot(target)
    })
    await waitForKnowledgeUpgrade(page, control)
    await waitForKnowledgeUpgrade(page, target)
    await assertUpgradeVisible(page, target)
    expect(upgradeSnapshot(target).text).toBe(target.currentText)
    expect(upgradeSnapshot(target).text).not.toBe(seeded.text)
    const { page: reopened, before } = await restartWithControl(acceptanceApp, control, target)
    await waitForKnowledgeUpgrade(reopened, target)
    await assertUpgradeVisible(reopened, target)
    expect(upgradeSnapshot(target)).toEqual(before)
    expect(model.exchanges).toEqual([])
    await info.attach('knowledge-cache-upgrade', { body: JSON.stringify({ previousState, target: target.kb.id, seeded, restored: upgradeSnapshot(target), record: readUpgradeRecord(target) }, null, 2), contentType: 'application/json' })
  })
}

test('startup preserves owner-edited extraction and does not rewrite its protection record on a second launch', knowledgeAcceptance('knowledge.sources.upgrade-preserve', 'none'), async ({ acceptanceApp, model, window }, info) => {
  const { control, target } = await preparePair(acceptanceApp, window)
  let seeded!: ReturnType<typeof upgradeSnapshot>
  const page = await acceptanceApp.restart(profile => {
    seedOldKnowledge(profile, control, 'learned')
    seedOldKnowledge(profile, target, 'edited')
    seeded = upgradeSnapshot(target)
  })
  await waitForKnowledgeUpgrade(page, control)
  await openUpgradeKnowledge(page, target)
  await expect.poll(async () => (await readKnowledgeFiles(page, target.kb.id)).find(file => file.path === target.copied.path)?.state).toBe('failed')
  await expect(knowledgeFileRow(page, target.document.name)).toContainText('preserved')
  const protection = readUpgradeRecord(target)
  expect(protection.extractorRevision).toBeUndefined()
  expect(protection.protection).toMatchObject({
    revision: target.expectedRevision,
    sourceHash: createHash('sha256').update(target.document.bytes).digest('hex'),
    textPath: target.textRelativePath,
    textHash: createHash('sha256').update(seeded.text!).digest('hex'),
  })
  expect(upgradeSnapshot(target)).toMatchObject({ text: seeded.text, textMtime: seeded.textMtime, textIno: seeded.textIno })
  assertUpgradeSourcesRetained(target)
  const { page: reopened, before } = await restartWithControl(acceptanceApp, control, target)
  await openUpgradeKnowledge(reopened, target)
  await expect(knowledgeFileRow(reopened, target.document.name)).toContainText('preserved')
  expect(upgradeSnapshot(target)).toEqual(before)
  expect(readUpgradeRecord(target).extractorRevision).toBeUndefined()
  assertUpgradeSourcesRetained(target)
  expect(model.exchanges).toEqual([])
  await info.attach('knowledge-cache-protection', { body: JSON.stringify({ seeded, protection, secondLaunch: upgradeSnapshot(target) }, null, 2), contentType: 'application/json' })
})

test('a paused knowledge base keeps old extraction until the user enables learning in its settings', knowledgeAcceptance('knowledge.sources.upgrade-paused', 'none'), async ({ acceptanceApp, model, window }, info) => {
  const { control, target } = await preparePair(acceptanceApp, window)
  await setKnowledgeLearning(window, target, false)
  let seeded!: ReturnType<typeof upgradeSnapshot>
  const page = await acceptanceApp.restart(profile => {
    seedOldKnowledge(profile, control, 'learned')
    seedOldKnowledge(profile, target, 'learned')
    seeded = upgradeSnapshot(target)
  })
  await waitForKnowledgeUpgrade(page, control)
  expect((await readKnowledgeBases(page)).find(kb => kb.id === target.kb.id)?.status).toBe('paused')
  expect(upgradeSnapshot(target)).toEqual(seeded)
  expect(readUpgradeRecord(target).extractorRevision).toBeUndefined()
  await openUpgradeKnowledge(page, target)
  await expect(page.getByRole('heading', { name: target.kb.name, exact: true }).locator('../..').getByText('Paused', { exact: true })).toBeVisible()
  await setKnowledgeLearning(page, target, true)
  await waitForKnowledgeUpgrade(page, target)
  await assertUpgradeVisible(page, target)
  expect(upgradeSnapshot(target).text).toBe(target.currentText)
  const { page: reopened, before } = await restartWithControl(acceptanceApp, control, target)
  await waitForKnowledgeUpgrade(reopened, target)
  expect(upgradeSnapshot(target)).toEqual(before)
  expect(model.exchanges).toEqual([])
  await info.attach('knowledge-cache-pause-resume', { body: JSON.stringify({ paused: seeded, resumed: before, secondLaunch: upgradeSnapshot(target) }, null, 2), contentType: 'application/json' })
})

test('a current extraction without a revision receives metadata without rewriting its text', knowledgeAcceptance('knowledge.sources.upgrade-current', 'none'), async ({ acceptanceApp, model, window }, info) => {
  const { control, target } = await preparePair(acceptanceApp, window)
  let seeded!: ReturnType<typeof upgradeSnapshot>
  const page = await acceptanceApp.restart(profile => {
    seedOldKnowledge(profile, control, 'learned')
    seedOldKnowledge(profile, target, 'current')
    seeded = upgradeSnapshot(target)
  })
  await waitForKnowledgeUpgrade(page, control)
  await waitForKnowledgeUpgrade(page, target)
  await assertUpgradeVisible(page, target)
  expect(upgradeSnapshot(target)).toMatchObject({ text: seeded.text, textMtime: seeded.textMtime, textIno: seeded.textIno })
  const { page: reopened, before } = await restartWithControl(acceptanceApp, control, target)
  await waitForKnowledgeUpgrade(reopened, target)
  expect(upgradeSnapshot(target)).toEqual(before)
  expect(model.exchanges).toEqual([])
  await info.attach('knowledge-cache-metadata-only', { body: JSON.stringify({ seeded, upgraded: before, secondLaunch: upgradeSnapshot(target) }, null, 2), contentType: 'application/json' })
})
