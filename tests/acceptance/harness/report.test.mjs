import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generateReport } from '../../../scripts/acceptance/lib/report.mjs'

function catalogFixture() {
  const scenario = { id: 'chat.send.reply', storyId: 'chat.send', module: 'chat', title: { en: 'Receive the reply', zh: '收到回复' }, verifies: ['reply'], platforms: ['darwin', 'win32'], profiles: ['fast'], evidence: 'app-e2e', mode: 'scripted', automation: 'automated', variants: {}, requirements: [], preconditions: [{ en: 'An isolated account', zh: '隔离账户' }], steps: [{ en: 'Send a message', zh: '发送消息' }], expected: [{ en: 'Read the reply', zh: '阅读回复' }] }
  return {
    version: 1, hash: 'a'.repeat(64), contracts: [], approvals: [],
    modules: [{ id: 'chat', title: { en: 'Working with AI', zh: '与 AI 一起工作' }, description: { en: 'Messages and replies', zh: '消息与回复' }, scope: { en: 'Owner desktop chat', zh: '主人的桌面对话' }, paths: [], dependsOn: [] }],
    stories: [{ id: 'chat.send', module: 'chat', title: { en: 'Ask for help', zh: '请求帮助' }, story: { en: 'I can ask the AI to help.', zh: '我能请 AI 帮忙。' }, basis: 'observed', semanticHash: 'b'.repeat(64), promises: { reply: { en: 'The reply is readable.', zh: '回复可读。' } }, resolvedPromises: { reply: { en: 'The reply is readable.', zh: '回复可读。' } }, references: ['src/example.ts'], source: 'tests/acceptance/catalog/chat/send.yaml', questions: [], caseIds: [scenario.id] }],
    cases: [scenario],
  }
}

function runFixture(catalog) {
  return { version: 1, id: 'run-1', catalogHash: catalog.hash, manifestHash: 'c'.repeat(64), revision: { commit: 'd'.repeat(40), dirty: false, worktreeHash: 'e'.repeat(64) }, profile: 'fast', platform: 'darwin', status: 'passed', evidenceIntegrity: { version: 1, valid: true, reasons: [] }, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', selectionReason: 'Explicit scope', selectedCount: 1, errors: [], cases: [{ caseId: 'chat.send.reply', storyId: 'chat.send', module: 'chat', variant: {}, evidence: 'app-e2e', mode: 'scripted', status: 'passed', attempts: [{ id: 'test-1', status: 'passed', duration: 12, retry: 0, attachments: [], errors: [] }] }] }
}

async function readPages(files) {
  const directory = path.join(path.dirname(files.index), 'stories')
  const pages = await fs.readdir(directory)
  return [await fs.readFile(files.index, 'utf8'), ...await Promise.all(pages.filter(file => file.endsWith('.html')).sort().map(file => fs.readFile(path.join(directory, file), 'utf8')))].join('\n')
}

async function workspace(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-handbook-'))
  try { await callback(root) } finally { await fs.rm(root, { recursive: true, force: true }) }
}

test('catalog-only handbook preserves planned, manual and unexecuted variants without inventing a pass', async () => workspace(async root => {
  const catalog = catalogFixture()
  catalog.cases[0].automation = 'planned'
  catalog.cases[0].variants = { layout: ['wide', 'narrow'] }
  catalog.cases.push({ ...catalog.cases[0], id: 'chat.send.scan', automation: 'manual', variants: {}, evidence: 'manual', reason: { en: 'A person scans the code.', zh: '需要人工扫码。' } })
  const files = await generateReport(root, catalog, null, path.join(root, 'report'))
  const html = await readPages(files)
  assert.match(html, /请求帮助/)
  assert.match(html, /Ask for help/)
  assert.match(html, /需要人工扫码/)
  assert.match(html, /待补自动化/)
  assert.equal((html.match(/data-case-status="not-run"/g) ?? []).length, 2)
  assert.match(html, /data-case-status="manual"/)
  assert.doesNotMatch(html, /data-case-status="passed"/)
  assert.match(await fs.readFile(files.summary, 'utf8'), /本记录已通过: 0/)
}))

test('historical catalog results and stale human approvals never verify current expectations', async () => workspace(async root => {
  const catalog = catalogFixture()
  catalog.approvals.push({ storyId: 'chat.send', semanticHash: 'f'.repeat(64), decision: 'approved', reviewer: 'Reviewer', decidedAt: '2026-01-01T00:00:00Z', current: true })
  const run = { ...runFixture(catalog), catalogHash: 'old-catalog' }
  const files = await generateReport(root, catalog, run, path.join(root, 'report'), { locale: 'en' })
  const html = await readPages(files)
  assert.match(html, /data-case-status="historical"/)
  assert.match(html, /Approval no longer applies/)
  assert.match(html, /different catalog/)
  assert.doesNotMatch(html, /data-verification="passed"/)
  assert.match(await fs.readFile(files.summary, 'utf8'), /Passed in this record: 0/)
}))

test('current successful evidence remains independent of product approval', async () => workspace(async root => {
  const catalog = catalogFixture()
  const files = await generateReport(root, catalog, runFixture(catalog), path.join(root, 'report'), { locale: 'en' })
  const html = await readPages(files)
  assert.match(html, /data-verification="passed"/)
  assert.match(html, /data-pending="false"/)
  assert.match(html, /Not individually confirmed/)
  assert.match(html, /Observed/)
  assert.match(html, /Scripted model/)
  assert.match(html, /Application end-to-end/)
  assert.match(html, new RegExp('d'.repeat(40)))
}))

test('one passing variant cannot verify a whole story or another platform', async () => workspace(async root => {
  const catalog = catalogFixture()
  catalog.cases[0].variants = { layout: ['wide', 'narrow'] }
  const run = runFixture(catalog)
  run.cases[0].variant = { layout: 'wide' }
  run.cases.push({ ...run.cases[0], caseId: 'removed.case', variant: {} })
  const current = await generateReport(root, catalog, run, path.join(root, 'current'), { locale: 'en' })
  const html = await readPages(current)
  assert.equal((html.match(/data-case-status="passed"/g) ?? []).length, 1)
  assert.match(html, /data-case-status="not-selected"/)
  assert.match(html, /data-verification="unverified"/)
  assert.match(html, /Additional recorded cases/)
  assert.match(await fs.readFile(current.summary, 'utf8'), /Passed in this record: 1/)
  run.platform = 'linux'
  const other = await generateReport(root, catalog, run, path.join(root, 'other'), { locale: 'en' })
  assert.doesNotMatch(await readPages(other), /data-case-status="passed"/)
  assert.match(await fs.readFile(other.summary, 'utf8'), /Passed in this record: 0/)
}))

test('passing attempts with invalid or absent execution integrity remain diagnostic and never verify a story', async () => workspace(async root => {
  const catalog = catalogFixture()
  for (const [name, mutate] of [
    ['missing', run => { delete run.evidenceIntegrity }],
    ['failed', run => { run.evidenceIntegrity = { version: 1, valid: false, reasons: ['Source changed during execution'] }; run.status = 'failed' }],
    ['contradictory', run => { run.errors = ['Output changed during execution'] }],
  ]) {
    const run = runFixture(catalog)
    mutate(run)
    const files = await generateReport(root, catalog, run, path.join(root, name), { locale: 'en' })
    const html = await readPages(files)
    assert.match(html, /data-case-status="invalid"/, name)
    assert.doesNotMatch(html, /data-verification="passed"/, name)
    assert.match(html, /Attempt 1 · Passed/, 'the raw successful attempt is retained for diagnosis')
    const summary = await fs.readFile(files.summary, 'utf8')
    assert.match(summary, /Passed in this record: 0/, name)
    assert.match(summary, /recorded attempts are diagnostic only/, name)
  }
}))

test('duplicate, contradictory or mismatched result boundaries are not counted as verification', async () => workspace(async root => {
  const catalog = catalogFixture()
  for (const [name, mutate] of [
    ['duplicate', run => run.cases.push({ ...run.cases[0] })],
    ['mode', run => { run.cases[0].mode = 'live' }],
    ['boundary', run => { run.cases[0].evidence = 'ui' }],
    ['empty', run => { run.cases[0].attempts = [] }],
    ['contradictory', run => { run.cases[0].attempts[0].status = 'failed' }],
  ]) {
    const run = runFixture(catalog)
    mutate(run)
    const files = await generateReport(root, catalog, run, path.join(root, name), { locale: 'en' })
    const html = await readPages(files)
    assert.match(html, /data-case-status="invalid"/, name)
    assert.doesNotMatch(html, /data-case-status="passed"/, name)
  }
}))

test('all asset, reviewer, error and path text is escaped without entering executable markup', async () => workspace(async root => {
  const payload = '</script><img src=x onerror="globalThis.pwned=1"><script>alert(1)</script>'
  const catalog = catalogFixture()
  catalog.stories[0].title = payload
  catalog.stories[0].story = payload
  catalog.stories[0].references = [payload]
  catalog.stories[0].source = payload
  catalog.stories[0].resolvedPromises.reply = payload
  catalog.stories[0].questions = [payload]
  catalog.approvals.push({ storyId: 'chat.send', semanticHash: catalog.stories[0].semanticHash, decision: 'approved', reviewer: payload, note: payload, decidedAt: '2026-01-01T00:00:00Z' })
  const run = runFixture(catalog)
  run.errors = [payload]
  run.cases[0].reason = payload
  run.cases[0].attempts[0].errors = [payload]
  run.cases[0].attempts[0].attachments = [{ name: payload, path: 'javascript:alert(1)' }]
  const files = await generateReport(root, catalog, run, path.join(root, 'report'), { locale: 'en' })
  const html = await readPages(files)
  assert.equal((html.match(/<script>/g) ?? []).length, 1)
  assert.doesNotMatch(html, /<img src=x/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /&lt;\/script&gt;&lt;img/)
  assert.match(html, /Content-Security-Policy/)
  assert.doesNotMatch(html, /unsafe-inline/)
  assert.doesNotMatch(await fs.readFile(files.summary, 'utf8'), /<img src=x/)
}))

test('only regular evidence inside the run directory is copied and active documents become text downloads', async () => workspace(async root => {
  const runDirectory = path.join(root, 'run')
  await fs.mkdir(runDirectory)
  await fs.writeFile(path.join(runDirectory, 'trace.zip'), 'trace bytes')
  await fs.writeFile(path.join(runDirectory, 'page.html'), '<script>alert("evidence")</script>')
  await fs.writeFile(path.join(root, 'private.txt'), 'outside secret')
  await fs.symlink(path.join(root, 'private.txt'), path.join(runDirectory, 'escape.txt'))
  const catalog = catalogFixture()
  const run = runFixture(catalog)
  run.cases[0].attempts[0].attachments = [
    { name: 'Trace', path: path.join(runDirectory, 'trace.zip') },
    { name: 'HTML', path: 'page.html' },
    { name: 'Traversal', path: '../private.txt' },
    { name: 'Symlink', path: 'escape.txt' },
    { name: 'Remote', path: 'https://example.invalid/trace.zip' },
  ]
  const files = await generateReport(root, catalog, run, path.join(root, 'report'), { locale: 'en', runDirectory })
  const html = await readPages(files)
  const copied = await fs.readdir(path.join(root, 'report/evidence'))
  assert.equal(copied.length, 2)
  assert.equal(copied.some(file => file.endsWith('.zip')), true)
  assert.equal(copied.some(file => file.endsWith('.txt')), true)
  assert.equal(copied.some(file => file.endsWith('.html')), false)
  assert.match(html, /href="\.\.\/evidence\/[a-f0-9]{64}\.zip" download/)
  assert.match(html, /Evidence unavailable/)
  assert.doesNotMatch(html, /outside secret/)
  assert.doesNotMatch(html, /href="https:/)
}))

test('an output evidence symlink cannot redirect exported files outside the report', async () => workspace(async root => {
  const runDirectory = path.join(root, 'run'), output = path.join(root, 'report'), outside = path.join(root, 'outside')
  await Promise.all([fs.mkdir(runDirectory), fs.mkdir(output), fs.mkdir(outside)])
  await fs.writeFile(path.join(runDirectory, 'trace.zip'), 'trace bytes')
  await fs.symlink(outside, path.join(output, 'evidence'))
  const catalog = catalogFixture(), run = runFixture(catalog)
  run.cases[0].attempts[0].attachments = [{ name: 'Trace', path: 'trace.zip' }]
  const files = await generateReport(root, catalog, run, output, { locale: 'en', runDirectory })
  assert.deepEqual(await fs.readdir(outside), [])
  assert.match(await readPages(files), /Evidence unavailable/)
}))

test('the searchable index keeps detailed scenarios off its DOM and links to stable offline story pages', async () => workspace(async root => {
  const catalog = catalogFixture()
  catalog.cases[0].steps = ['A detailed step that belongs only on the story page']
  const files = await generateReport(root, catalog, null, path.join(root, 'report'), { locale: 'en' })
  const index = await fs.readFile(files.index, 'utf8')
  const story = await fs.readFile(path.join(root, 'report/stories/chat.send.html'), 'utf8')
  assert.match(index, /href="stories\/chat\.send\.html"/)
  assert.doesNotMatch(index, /A detailed step that belongs only on the story page/)
  assert.doesNotMatch(index, /class="scenario"/)
  assert.match(index, /data-search=/)
  assert.match(story, /A detailed step that belongs only on the story page/)
  assert.match(story, /href="\.\.\/index\.html#story-chat\.send"/)
  assert.doesNotMatch(story, /<script/)
  assert.doesNotMatch(index, /\bfetch\(/)
}))

test('existing observed behavior without an individual approval is not turned into a confirmation task', async () => workspace(async root => {
  const catalog = catalogFixture()
  const normal = await generateReport(root, catalog, null, path.join(root, 'normal'), { locale: 'en' })
  const normalIndex = await fs.readFile(normal.index, 'utf8')
  assert.match(normalIndex, /data-pending="false"/)
  assert.match(normalIndex, /Not individually confirmed/)
  catalog.stories[0].questions = ['Should guests have this ability?']
  const question = await generateReport(root, catalog, null, path.join(root, 'question'), { locale: 'en' })
  assert.match(await fs.readFile(question.index, 'utf8'), /data-pending="true"/)
  catalog.stories[0].questions = []
  catalog.stories[0].basis = 'proposed'
  const proposal = await generateReport(root, catalog, null, path.join(root, 'proposal'), { locale: 'en' })
  assert.match(await fs.readFile(proposal.index, 'utf8'), /data-pending="true"/)
}))
