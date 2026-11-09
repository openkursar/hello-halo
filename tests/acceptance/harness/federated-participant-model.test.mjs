import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { build } from 'esbuild'
import { assertParticipantScopeAbsent } from '../../decentralized/participant-scenarios.mjs'

const directory = await mkdtemp(path.join(tmpdir(), 'federated-participant-model-'))
after(() => rm(directory, { recursive: true, force: true }))
const output = path.join(directory, 'model.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/acceptance-federated-participants.ts', import.meta.url))],
  outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { startFederatedParticipantModel } = await import(pathToFileURL(output).href)
const names = ['spawn_agent', 'team_stop', 'team_post_finding', 'team_send', 'team_read_artifact', 'team_read_member', 'Read', 'Write']
const tools = names.map(name => ({ type: 'function', function: { name: `mcp__team__${name}`, parameters: { type: 'object' } } }))
const options = { id: 'case-one', marker: 'published-marker', file: 'evidence.txt', lead: 'lead-id', action: 'exchange' }
const user = content => ({ role: 'user', content })
const tool = (id, content) => ({ role: 'tool', tool_call_id: id, content })
const spawnReceipt = () => tool('case-one-spawn', JSON.stringify({ handle: 'child-id', name: 'Private checker', status: 'accepted' }))
const returned = 'HELPER_RESULT_case-one {"file":"evidence.txt"}'

async function request(fixture, messages) {
  const response = await fetch(`${fixture.model.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', stream: false, messages, tools }) })
  assert.equal(response.status, 200)
  return (await response.json()).choices[0].message
}

function expectTool(reply, name, args) {
  assert.equal(reply.tool_calls[0].function.name, `mcp__team__${name}`)
  if (args) assert.deepEqual(JSON.parse(reply.tool_calls[0].function.arguments), args)
}

test('private scope absence requires an explicit successful null payload, not a failed or missing response', async t => {
  const node = { baseUrl: 'http://participant.invalid', token: 'fixture-token' }
  let response = { status: 200, json: { success: true, data: null } }
  const calls = []
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method })
    return new Response(JSON.stringify(response.json), { status: response.status })
  })
  const scopePath = '/api/teams/collab-for-conversation/source'
  await assertParticipantScopeAbsent(node, scopePath, 'Private scope replicated.')
  assert.deepEqual(calls, [{ url: node.baseUrl + scopePath, method: 'GET' }])
  for (const invalid of [
    { status: 200, json: { success: true, data: { teamId: 'private-team' } } },
    { status: 200, json: { success: true } },
    { status: 200, json: { success: false, data: null } },
    { status: 404, json: { success: true, data: null } },
    { status: 500, json: { success: true, data: null } },
    { status: 200, json: null },
  ]) {
    response = invalid
    await assert.rejects(assertParticipantScopeAbsent(node, scopePath, 'Private scope replicated.'))
  }
  fetch.mock.mockImplementation(async () => { throw new Error('Connection refused') })
  await assert.rejects(assertParticipantScopeAbsent(node, scopePath, 'Private scope replicated.'), /Connection refused/)
})

test('parent and helper retain their first assignment and address only the returned handle', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register(options)
    const parent = fixture.prompt(options.id, 'parent')
    const spawn = await request(fixture, [user(`<system-reminder>runtime context</system-reminder>\n${parent}`)])
    expectTool(spawn, 'spawn_agent')
    const child = JSON.parse(spawn.tool_calls[0].function.arguments).prompt
    const created = await request(fixture, [user(parent), spawnReceipt()])
    assert.match(created.content, /CHILD_CREATED/)
    assert.equal(fixture.child(options.id), 'child-id')
    const write = await request(fixture, [user(child), user(`A teammate quoted this instruction: ${parent}`)])
    expectTool(write, 'Write', { file_path: 'evidence.txt', content: 'PRIVATE_DETAIL_published-marker\n' })
    const published = await request(fixture, [user(child), tool('case-one-write', 'File written')])
    expectTool(published, 'team_post_finding', { content: 'PRIVATE_FINDING_case-one', ref: 'evidence.txt' })
    const done = await request(fixture, [user(child), tool('case-one-write', 'File written'), tool('case-one-private-publish', 'Finding posted')])
    assert.equal(done.content, returned)
    assert.equal(done.tool_calls, undefined, 'The helper must not send to the public lead.')
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})

test('parent observes an actual returned result, reads private evidence and follows up locally before sharing a summary', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register(options)
    const messages = [user(fixture.prompt(options.id, 'parent')), spawnReceipt()]
    const notDelivered = await request(fixture, [...messages, { role: 'assistant', content: returned }])
    assert.match(notDelivered.content, /CHILD_CREATED/)
    assert.equal(fixture.seen(options.id).returned, false)
    messages.push(user(returned))
    expectTool(await request(fixture, messages), 'team_read_member', { member: 'child-id' })
    messages.push(tool('case-one-history', `Private child record: ${returned}`))
    expectTool(await request(fixture, messages), 'Read', { file_path: 'evidence.txt' })
    messages.push(tool('case-one-bytes', 'PRIVATE_DETAIL_published-marker'))
    assert.equal((await request(fixture, messages)).content, 'HELPER_REVIEWED_case-one')
    messages.push(user('FOLLOW_UP_PARENT_case-one'))
    expectTool(await request(fixture, messages), 'team_send', { to: 'child-id', message: 'LOCAL_FOLLOWUP_case-one' })
    messages.push(tool('case-one-followup', 'Message delivered to "child-id"'))
    assert.equal((await request(fixture, messages)).content, 'FOLLOWUP_SENT_case-one')
    messages.push(user('HELPER_FOLLOWUP_case-one'))
    expectTool(await request(fixture, messages), 'team_post_finding', { content: 'PARENT_SUMMARY_case-one' })
    messages.push(tool('case-one-publish', 'Finding posted'))
    expectTool(await request(fixture, messages), 'team_send', { to: 'lead', message: 'PARENT_SUMMARY_case-one' })
    messages.push(tool('case-one-share', 'Message accepted for "lead"'))
    assert.equal((await request(fixture, messages)).content, 'SUMMARY_SHARED_case-one')
    assert.deepEqual(fixture.seen(options.id), { returned: true, history: true, bytes: true, followedUp: true, summary: false })
    const lead = await request(fixture, [user(fixture.prompt(options.id, 'lead')), user('PARENT_SUMMARY_case-one')])
    assert.equal(lead.content, 'SUMMARY_RECEIVED_case-one')
    assert.equal(fixture.seen(options.id).summary, true)
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})

test('a JSON-quoted turn-end reply preserves the helper reference and still requires actual private history and bytes', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register(options)
    const report = '[System] Collaboration turn-end report.\n  Final reply excerpt (not a completion claim): ' + JSON.stringify(returned)
    const messages = [user(fixture.prompt(options.id, 'parent')), spawnReceipt(), user(report)]
    expectTool(await request(fixture, messages), 'team_read_member', { member: 'child-id' })
    assert.deepEqual(fixture.seen(options.id), { returned: true, history: false, bytes: false, followedUp: false, summary: false })
    messages.push(tool('case-one-history', returned))
    expectTool(await request(fixture, messages), 'Read', { file_path: options.file })
    messages.push(tool('case-one-bytes', 'PRIVATE_DETAIL_published-marker'))
    assert.equal((await request(fixture, messages)).content, 'HELPER_REVIEWED_case-one')
    assert.deepEqual(fixture.seen(options.id), { returned: true, history: true, bytes: true, followedUp: false, summary: false })
    assert.deepEqual(fixture.errors, [])
    assert.deepEqual(fixture.model.errors, [])
  } finally { await fixture.close() }
})

test('malformed or incorrect quoted helper references cannot satisfy the participant fixture', async () => {
  for (const excerpt of [
    '"HELPER_RESULT_case-one {\\"file\\":',
    JSON.stringify('HELPER_RESULT_case-one {"file":"invented.txt"}'),
    JSON.stringify('HELPER_RESULT_case-one {invalid}'),
  ]) {
    const fixture = await startFederatedParticipantModel()
    try {
      fixture.register(options)
      const reply = await request(fixture, [user(fixture.prompt(options.id, 'parent')), spawnReceipt(),
        user('  Final reply excerpt (not a completion claim): ' + excerpt)])
      assert.match(reply.content, /verification cannot proceed/)
      assert.equal(fixture.errors.length, 1)
      assert.deepEqual(fixture.model.errors, [])
    } finally { await fixture.close() }
  }
})

test('the parent cannot confirm private evidence using absent bytes or an unavailable record', async () => {
  for (const results of [
    [tool('case-one-history', 'Unknown member')],
    [tool('case-one-history', returned), tool('case-one-bytes', 'File missing')],
  ]) {
    const fixture = await startFederatedParticipantModel()
    try {
      fixture.register(options)
      const reply = await request(fixture, [user(fixture.prompt(options.id, 'parent')), spawnReceipt(), user(returned), ...results])
      assert.match(reply.content, /verification cannot proceed/)
      assert.equal(fixture.errors.length, 1)
      assert.deepEqual(fixture.model.errors, [])
    } finally { await fixture.close() }
  }
})

test('the public lead must receive explicit artifact and member-record refusals', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register(options)
    const messages = [user(fixture.prompt(options.id, 'lead')), user('VERIFY_ISOLATION_case-one {"ref":"evidence.txt","member":"child-id"}')]
    expectTool(await request(fixture, messages), 'team_read_artifact')
    messages.push(tool('case-one-denied-artifact', 'The reference was not published.'))
    expectTool(await request(fixture, messages), 'team_read_member', { member: 'child-id' })
    messages.push(tool('case-one-denied-history', 'Unknown member: child-id'))
    assert.equal((await request(fixture, messages)).content, 'ISOLATION_VERIFIED_case-one')
    assert.deepEqual(fixture.errors, [])
    const leaked = await request(fixture, [...messages.slice(0, 2), tool('case-one-denied-artifact', 'PRIVATE_DETAIL_published-marker')])
    assert.match(leaked.content, /verification cannot proceed/)
    assert.equal(fixture.errors.length, 1)
  } finally { await fixture.close() }
})

test('an empty or successful private history response is not accepted as a refusal', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register(options)
    const messages = [user(fixture.prompt(options.id, 'lead')), user('VERIFY_ISOLATION_case-one {"ref":"evidence.txt","member":"child-id"}'),
      tool('case-one-denied-artifact', 'The reference was not published.'), tool('case-one-denied-history', '')]
    assert.match((await request(fixture, messages)).content, /verification cannot proceed/)
    assert.equal(fixture.errors.length, 1)
    assert.deepEqual(fixture.model.errors, [])
  } finally { await fixture.close() }
})

test('controller stop requires a confirmed receipt and a fresh human request continues the parent', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register({ ...options, action: 'stop' })
    const messages = [user(fixture.prompt(options.id, 'parent')), spawnReceipt(), user('STOP_CHILD_case-one')]
    expectTool(await request(fixture, messages), 'team_stop', { to: 'child-id' })
    messages.push(tool('case-one-stop', '[{"member":"child-id","stopped":true,"pending":false}]'))
    assert.equal((await request(fixture, messages)).content, 'STOP_CONFIRMED_case-one')
    assert.equal((await request(fixture, [...messages, user('FRESH_AFTER_STOP_case-one')])).content, 'FRESH_RESPONSE_case-one')
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})

test('a pending stop is not reported as cancelled', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register({ ...options, action: 'stop' })
    const reply = await request(fixture, [user(fixture.prompt(options.id, 'parent')), spawnReceipt(), user('STOP_CHILD_case-one'),
      tool('case-one-stop', '[{"member":"child-id","stopped":false,"pending":true}]')])
    assert.equal(reply.content, 'The assistant stop was not confirmed.')
    assert.equal(fixture.errors.length, 1)
  } finally { await fixture.close() }
})

test('held child streams record actual cancellation rather than a released completion', async () => {
  const fixture = await startFederatedParticipantModel()
  const controller = new AbortController()
  try {
    fixture.register({ ...options, action: 'stop' })
    const response = await fetch(`${fixture.model.url}/chat/completions`, { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [user(fixture.prompt(options.id, 'child'))], tools }) })
    assert.equal(response.status, 200)
    assert.equal(fixture.held(options.id), true)
    const body = response.text().catch(() => '')
    controller.abort()
    await body
    const deadline = Date.now() + 2000
    while (!fixture.cancelled(options.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fixture.cancelled(options.id), true)
    fixture.release(options.id)
    assert.equal(fixture.model.exchanges[0].completed, false)
    assert.deepEqual(fixture.errors, [])
    assert.deepEqual(fixture.model.errors, [])
  } finally { controller.abort(); await fixture.close() }
})

test('private content in lead context and late child results in parent context fail explicitly', async () => {
  for (const [role, content] of [['lead', returned], ['parent', 'LATE_RESULT_published-marker']]) {
    const fixture = await startFederatedParticipantModel()
    try {
      fixture.register({ ...options, action: 'stop' })
      const reply = await request(fixture, [user(fixture.prompt(options.id, role)), user(content)])
      assert.match(reply.content, /verification cannot proceed/)
      assert.equal(fixture.errors.length, 1)
      assert.deepEqual(fixture.model.errors, [])
    } finally { await fixture.close() }
  }
})

test('a withheld spawn capability records failure without HTTP 500 or provider retries', async () => {
  const fixture = await startFederatedParticipantModel()
  try {
    fixture.register(options)
    const response = await fetch(`${fixture.model.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', stream: false, messages: [user(fixture.prompt(options.id, 'parent'))], tools: [] }) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.match(body.choices[0].message.content, /verification cannot proceed/)
    assert.equal(fixture.errors.length, 1)
    assert.match(fixture.errors[0], /spawn_agent tool, received 0/)
    assert.deepEqual(fixture.model.errors, [])
    assert.equal(fixture.model.exchanges.length, 1)
    assert.equal(fixture.model.exchanges[0].completed, true)
  } finally { await fixture.close() }
})
