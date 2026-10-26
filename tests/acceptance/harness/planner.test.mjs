import test from 'node:test'
import assert from 'node:assert/strict'
import { makePlan, matchPath, selectModules, validateManifest } from '../../../scripts/acceptance/lib/planner.mjs'

const scenario = { id: 'teams.members', storyId: 'teams.keep', module: 'teams', title: 'All saved members can talk', verifies: ['reply'], platforms: ['darwin', 'win32'], profiles: ['fast', 'regression'], evidence: 'app-e2e', mode: 'scripted', automation: 'planned', variants: { member: ['lead', 'ordinary'] }, requirements: [] }
const catalog = { hash: 'catalog', modules: [{ id: 'chat', paths: ['src/chat/**'], dependsOn: [] }, { id: 'teams', paths: ['src/teams/**'], dependsOn: ['chat'] }, { id: 'offices', paths: ['src/offices/**'], dependsOn: ['teams'] }], cases: [scenario] }
const binding = { caseId: scenario.id, evidence: 'app-e2e', mode: 'scripted', variant: { member: 'lead' } }
const manifest = { version: 1, tests: [{ id: 'test-a', file: 'tests/e2e/specs/a.spec.ts', title: 'Lead replies', bindings: [binding] }] }

test('every declared variant remains required when only one has a test', () => {
  const plan = makePlan(catalog, manifest, { platform: 'darwin' })
  assert.equal(plan.cases.length, 2)
  assert.deepEqual(plan.cases[0].testIds, ['test-a'])
  assert.match(plan.cases[1].blockedReason, /No executable test/)
})

test('impact analysis includes transitive consumers and expands unknown or deleted paths', () => {
  assert.deepEqual(selectModules(catalog, ['src/chat/send.ts']).modules, ['chat', 'offices', 'teams'])
  assert.equal(selectModules(catalog, ['src/removed/entry.ts']).modules.length, 3)
  assert.equal(selectModules(catalog, ['src/main/services/agent/session.ts']).modules.length, 3)
  assert.match(selectModules(catalog, []).reason, /core scenarios/)
})

test('evidence cannot be relabeled from a rendering stub to an application journey', () => {
  assert.throws(() => validateManifest(catalog, { ...manifest, tests: [{ ...manifest.tests[0], bindings: [{ ...binding, evidence: 'ui' }] }] }), /disagrees with catalog/)
  assert.throws(() => validateManifest(catalog, { ...manifest, tests: [{ ...manifest.tests[0], bindings: [{ ...binding, variant: { member: 'other' } }] }] }), /unsupported bound variant/)
})

test('explicit module and case inputs reject typos rather than produce an empty green plan', () => {
  assert.throws(() => makePlan(catalog, manifest, { modules: ['typo'] }), /Unknown module/)
  assert.throws(() => makePlan(catalog, manifest, { cases: ['typo'] }), /Unknown case/)
})

test('live and external dependencies require separate explicit execution permission', () => {
  const liveCatalog = { ...catalog, cases: [{ ...scenario, variants: {}, mode: 'live', evidence: 'external', profiles: ['external'] }] }
  const liveManifest = { ...manifest, tests: [{ ...manifest.tests[0], bindings: [{ ...binding, mode: 'live', evidence: 'external', variant: {} }] }] }
  const blocked = makePlan(liveCatalog, liveManifest, { platform: 'darwin', profile: 'external', allowLive: true })
  assert.match(blocked.cases[0].blockedReason, /allow-external/)
  const permitted = makePlan(liveCatalog, liveManifest, { platform: 'darwin', profile: 'external', allowLive: true, allowExternal: true })
  assert.equal(permitted.cases[0].blockedReason, undefined)
})

test('change globs distinguish path segments and root files', () => {
  assert.equal(matchPath('src/**/*.ts', 'src/a.ts'), true)
  assert.equal(matchPath('src/**/*.ts', 'src/nested/a.ts'), true)
  assert.equal(matchPath('src/*.ts', 'src/nested/a.ts'), false)
  assert.equal(matchPath('package.json', 'nested/package.json'), false)
})

test('unconfirmed proposals stay outside existing-product regression until a current human decision', () => {
  const proposed = { ...catalog, cases: [{ ...scenario, basis: 'proposed' }] }
  assert.equal(makePlan(proposed, manifest, { platform: 'darwin' }).cases.length, 0)
  assert.equal(makePlan(proposed, manifest, { platform: 'darwin', includeProposed: true }).cases.length, 2)
  const approval = { storyId: scenario.storyId, current: true, decision: 'approved', decidedAt: '2026-01-01T00:00:00Z' }
  assert.equal(makePlan({ ...proposed, approvals: [approval] }, manifest, { platform: 'darwin' }).cases.length, 2)
  assert.equal(makePlan({ ...proposed, approvals: [approval, { ...approval, decision: 'rejected', decidedAt: '2026-01-02T00:00:00Z' }] }, manifest, { platform: 'darwin' }).cases.length, 0)
})
