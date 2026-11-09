import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { build } from 'esbuild'
import { parseOptions, isolatedEnvironment, rosterConfiguration, sharedMembers, stopHeldSend, verifyBuildPair } from '../../decentralized/checklist-mixed-version.mjs'

const directory = await mkdtemp(path.join(tmpdir(), 'mixed-version-harness-'))
after(() => rm(directory, { recursive: true, force: true }))
const output = path.join(directory, 'model.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../../decentralized/fixtures/mixed-version-model.ts', import.meta.url))],
  outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { startMixedVersionModel } = await import(pathToFileURL(output).href)

test('driver import is inert and options require explicit independent inputs', () => {
  assert.deepEqual(parseOptions(['--help']), { help: true })
  assert.deepEqual(parseOptions(['--results', 'evidence.json', '--legacy-root', 'older']), {
    legacyRoot: path.resolve('older'), results: path.resolve('evidence.json'),
  })
  for (const args of [[], ['--legacy-root', 'older'], ['--results', 'evidence.json'], ['--unknown', 'x'],
    ['--legacy-root', '--results'], ['--legacy-root', 'older', '--results', 'a', '--results', 'b'], ['--help', '--results', 'a']]) {
    assert.throws(() => parseOptions(args))
  }
})

test('isolated environment excludes host credentials, proxies and engine state', () => {
  const inherited = { PATH: '/controlled/bin', Path: '/windows/bin', DISPLAY: ':99', LANG: 'en_US.UTF-8',
    HOME: '/real/home', USERPROFILE: '/real/profile', HALO_DATA_DIR: '/real/data',
    ANTHROPIC_API_KEY: 'host-secret', OPENAI_API_KEY: 'host-secret', HALO_TEST_API_KEY: 'host-secret',
    HTTPS_PROXY: 'http://host-proxy', http_proxy: 'http://host-proxy', ELECTRON_RUN_AS_NODE: '1',
    CLAUDE_CONFIG_DIR: '/real/claude', NODE_OPTIONS: '--require host-hook', CODEX_HOME: '/real/codex' }
  const original = structuredClone(inherited)
  const profile = path.join(directory, 'isolated')
  const env = isolatedEnvironment(profile, inherited)
  assert.deepEqual(inherited, original)
  for (const name of ['PATH', 'Path', 'DISPLAY', 'LANG']) assert.equal(env[name], inherited[name])
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HALO_TEST_API_KEY', 'HTTPS_PROXY', 'http_proxy',
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CODEX_HOME']) assert.equal(Object.hasOwn(env, name), false)
  assert.equal(env.HOME, profile)
  assert.equal(env.USERPROFILE, profile)
  assert.equal(env.HALO_DATA_DIR, path.join(profile, '.halo'))
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(profile, 'engine-state'))
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(env[name], path.join(profile, 'tmp'))
  for (const name of ['XDG_CONFIG_HOME', 'APPDATA']) assert.equal(env[name], path.join(profile, 'config'))
  for (const name of ['XDG_CACHE_HOME', 'LOCALAPPDATA']) assert.equal(env[name], path.join(profile, 'cache'))
  assert.equal(env.XDG_DATA_HOME, path.join(profile, 'data'))
  assert.equal(env.HALO_E2E_TEST, '1')
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost')
  assert.equal(env.no_proxy, env.NO_PROXY)
})

test('roster comparison preserves ordinary configuration but ignores presence and ordering', () => {
  const detail = { team: { leadAppId: 'a' }, members: [
    { appId: 'b', memberName: 'Worker', role: 'Reviewer', isLead: false, duty: 'idle', aiProvisioned: true, ownerNodeId: 'first' },
    { appId: 'a', memberName: 'Lead', role: 'Lead', isLead: true, isSystemCoordinator: false },
  ], edges: [{ from: 'b', to: 'a' }, { fromAppId: 'a', toAppId: 'b' }] }
  const original = structuredClone(detail)
  const configuration = rosterConfiguration(detail)
  assert.deepEqual(detail, original)
  assert.deepEqual(configuration.edges, ['a->b', 'b->a'])
  assert.deepEqual(configuration.members.map(member => member.appId), ['a', 'b'])
  assert.equal(configuration.members[0].duty, null)
  const reordered = structuredClone(detail)
  reordered.members.reverse()
  reordered.members[0].ownerNodeId = 'second'
  reordered.members[0].presence = 'offline'
  reordered.edges.reverse()
  assert.deepEqual(rosterConfiguration(reordered), configuration)
  for (const key of ['memberName', 'role', 'isLead', 'duty', 'aiProvisioned', 'isSystemCoordinator']) {
    const changed = structuredClone(detail)
    changed.members[0][key] = key
    assert.notDeepEqual(rosterConfiguration(changed), configuration)
  }
  assert.deepEqual(rosterConfiguration({ ...detail, edges: undefined }).edges, [])
})

test('shared roster excludes only owner-local provisioning flags and retains all shared configuration', () => {
  const detail = { team: { leadAppId: 'lead' }, members: [
    { appId: 'worker', memberName: 'Worker', role: 'Reviewer', isLead: false, duty: 'Review', aiProvisioned: true, isSystemCoordinator: false },
  ], edges: [] }
  const owner = rosterConfiguration(detail)
  const remote = structuredClone(detail)
  delete remote.members[0].aiProvisioned
  delete remote.members[0].isSystemCoordinator
  assert.notDeepEqual(rosterConfiguration(remote), owner, 'Full owner comparison must retain provisioning flags')
  const shared = sharedMembers(owner.members)
  assert.deepEqual(sharedMembers(rosterConfiguration(remote).members), shared)
  assert.deepEqual(Object.keys(shared[0]), ['appId', 'memberName', 'role', 'isLead', 'duty'])
  for (const key of ['appId', 'memberName', 'role', 'isLead', 'duty']) {
    const changed = structuredClone(detail)
    changed.members[0][key] = key === 'isLead' ? true : `${key}-changed`
    assert.notDeepEqual(sharedMembers(rosterConfiguration(changed).members), shared)
  }
  assert.notDeepEqual(rosterConfiguration({ ...detail, team: { leadAppId: 'other' } }), owner)
  assert.deepEqual(detail.members[0], { appId: 'worker', memberName: 'Worker', role: 'Reviewer', isLead: false,
    duty: 'Review', aiProvisioned: true, isSystemCoordinator: false })
})

function heldSendFixture(result = { ok: true, finalMessage: null }) {
  const events = []
  let resolveSend, rejectSend, signal
  const pending = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject })
  const callbacks = {
    send: value => {
      events.push('send')
      signal = value
      value.addEventListener('abort', () => { events.push('abort'); rejectSend(value.reason) }, { once: true })
      return pending
    },
    waitActive: async () => { await Promise.resolve(); events.push('active') },
    stop: async () => { events.push('stop'); return { ok: true, stopped: true } },
    waitCancelled: async () => { events.push('cancelled'); resolveSend(result) },
  }
  return { callbacks, events, rejectSend, get signal() { return signal } }
}

test('held send stays pending until active stream is stopped, cancelled and settled', { timeout: 2000 }, async () => {
  const fixture = heldSendFixture()
  assert.deepEqual(await stopHeldSend(fixture.callbacks), { ok: true, finalMessage: null })
  assert.deepEqual(fixture.events, ['send', 'active', 'stop', 'cancelled', 'abort'])
  assert.equal(fixture.signal.aborted, true)
})

test('held send rejection before stream activation is observed and propagated', { timeout: 2000 }, async () => {
  const fixture = heldSendFixture()
  const failure = new Error('Synthetic send failure')
  fixture.callbacks.waitActive = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  fixture.rejectSend(failure)
  await assert.rejects(stopHeldSend(fixture.callbacks), error => error === failure)
  assert.deepEqual(fixture.events, ['send', 'abort'])
})

test('held send failure while stopping is observed rather than swallowed', { timeout: 2000 }, async () => {
  const fixture = heldSendFixture()
  const failure = new Error('Synthetic stop settlement failure')
  fixture.callbacks.waitCancelled = async () => { fixture.events.push('cancelled'); fixture.rejectSend(failure) }
  await assert.rejects(stopHeldSend(fixture.callbacks), error => error === failure)
  assert.equal(fixture.signal.aborted, true)
})

test('held send observer failure aborts and drains the pending request', { timeout: 2000 }, async () => {
  const fixture = heldSendFixture()
  const failure = new Error('Synthetic stream observation failure')
  fixture.callbacks.waitActive = async () => { throw failure }
  await assert.rejects(stopHeldSend(fixture.callbacks), error => error === failure)
  assert.deepEqual(fixture.events, ['send', 'abort'])
  assert.equal(fixture.signal.aborted, true)
})

test('held send rejects an early reply and invalid stop or send settlements', { timeout: 2000 }, async () => {
  const early = heldSendFixture()
  early.callbacks.send = async () => ({ ok: true, finalMessage: 'premature' })
  early.callbacks.waitActive = () => new Promise(() => {})
  await assert.rejects(stopHeldSend(early.callbacks), /before its active stream/)
  for (const result of [{ ok: false, stopped: false }, { ok: true, stopped: false }]) {
    const fixture = heldSendFixture()
    fixture.callbacks.stop = async () => result
    await assert.rejects(stopHeldSend(fixture.callbacks), /Owner stop/)
    assert.equal(fixture.signal.aborted, true)
  }
  for (const result of [{ ok: false, finalMessage: null, reason: 'TIMEOUT' },
    { ok: true, finalMessage: null, delivery: 'queued' }, { ok: true, finalMessage: null, reason: 'UNDELIVERED' },
    { ok: true, finalMessage: {} }]) {
    const fixture = heldSendFixture(result)
    await assert.rejects(stopHeldSend(fixture.callbacks), /Stopped send|Held send/)
    assert.equal(fixture.signal.aborted, true)
  }
})

test('build identity requires older actual application source, not just a protocol declaration or another binary', () => {
  const make = (label, source) => ({ directory: path.join(directory, label), revision: `${label}-revision`, entrySha256: `${label}-binary`,
    build: { inputs: { files: [{ path: 'src/main/index.ts', sha256: source },
      { path: 'src/shared/federation/protocol-version.ts', sha256: `${label}-protocol` }] } } })
  const current = make('current', 'new-source')
  const legacy = make('legacy', 'old-source')
  const calls = []
  verifyBuildPair(current, legacy, (...args) => { calls.push(args); return '' })
  assert.deepEqual(calls, [
    [current.directory, 'merge-base', '--is-ancestor', legacy.revision, current.revision],
    [legacy.directory, 'diff', '--name-only', 'HEAD', '--', 'src', ':(exclude)src/sdk'],
    [legacy.directory, 'ls-files', '--others', '--exclude-standard', '--', 'src', ':(exclude)src/sdk'],
  ])
  assert.throws(() => verifyBuildPair(current, { ...legacy, directory: current.directory }, () => ''), /separate checkout/)
  assert.throws(() => verifyBuildPair(current, { ...legacy, revision: current.revision }, () => ''), /different actual revision/)
  assert.throws(() => verifyBuildPair(current, legacy, () => { throw new Error('not an ancestor') }), /not an ancestor/)
  assert.throws(() => verifyBuildPair(current, legacy, (_root, command) => command === 'diff' ? 'src/main/index.ts' : ''), /match its actual older revision/)
  assert.throws(() => verifyBuildPair(current, legacy, (_root, command) => command === 'ls-files' ? 'src/main/extra.ts' : ''), /uncommitted additions/)
  assert.throws(() => verifyBuildPair(current, make('legacy', 'new-source'), () => ''), /differ beyond the protocol/)
  assert.throws(() => verifyBuildPair(current, { ...legacy, build: { inputs: { files: [] } } }, () => ''), /actual application source/)
  assert.throws(() => verifyBuildPair(current, { ...legacy, entrySha256: current.entrySha256 }, () => ''), /same application binary/)
})

const user = content => ({ role: 'user', content })
const receipt = (protocol, id, text, error = false) => protocol === 'openai'
  ? { role: 'tool', tool_call_id: id, content: text }
  : user([{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }])

async function request(model, protocol, messages, names = [], options = {}) {
  const tools = names.map(name => protocol === 'openai'
    ? { type: 'function', function: { name, parameters: { type: 'object' } } }
    : { name, description: name, input_schema: { type: 'object' } })
  const response = await fetch(`${model.url}/v1/${protocol === 'openai' ? 'chat/completions' : 'messages'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: options.signal,
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 128, stream: options.stream ?? false, messages, tools }),
  })
  assert.equal(response.status, 200)
  if (options.stream) return response
  const body = await response.json()
  return protocol === 'openai' ? {
    text: body.choices[0].message.content,
    calls: (body.choices[0].message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
  } : {
    text: body.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    calls: body.content.filter(block => block.type === 'tool_use').map(({ id, name, input }) => ({ id, name, input })),
  }
}

for (const protocol of ['openai', 'anthropic']) {
  test(`${protocol}: answers use the latest instruction and direct tools retain their actual address`, async () => {
    const model = await startMixedVersionModel()
    try {
      model.register('OLD_INPUT', { kind: 'answer' })
      model.register('DISPATCH_TEST', { kind: 'send', target: 'remote-member', delivery: 'DELIVERY_TEST' })
      model.register('DELIVERY_TEST', { kind: 'answer' })
      assert.throws(() => model.register('DELIVERY_TEST', { kind: 'hold' }), /Duplicate/)
      const messages = [user('OLD_INPUT'), user('<system-reminder>DELIVERY_TEST</system-reminder>\nDISPATCH_TEST')]
      const reply = await request(model, protocol, messages, ['mcp__halo-team__team_send'])
      assert.deepEqual(reply.calls, [{ id: 'send-DISPATCH_TEST', name: 'mcp__halo-team__team_send',
        input: { to: 'remote-member', message: 'DELIVERY_TEST' } }])
      const completed = await request(model, protocol, [...messages, receipt(protocol, 'send-DISPATCH_TEST', 'Message delivered to "remote-member".')])
      assert.equal(completed.text, 'SENT_DISPATCH_TEST')
      assert.equal((await request(model, protocol, [user('[Team message from sender]\nDELIVERY_TEST')])).text, 'RECEIVED_DELIVERY_TEST')
      assert.equal(model.exchangesFor('OLD_INPUT').length, 0)
      assert.equal(model.exchangesFor('DISPATCH_TEST').length, 2)
      assert.equal(model.exchangesFor('DELIVERY_TEST').length, 1)
      assert.ok(model.evidence().every(exchange => exchange.protocol === protocol && exchange.completed && !exchange.cancelled))
      assert.deepEqual(model.errors, [])
      assert.deepEqual(model.issues, [])
    } finally { await model.close() }
  })

  test(`${protocol}: discovery must return a complete definition before CallTool`, async () => {
    const model = await startMixedVersionModel()
    try {
      model.register('SEARCH_TEST', { kind: 'send', target: 'remote-member', delivery: 'DELIVERY' })
      const messages = [user('SEARCH_TEST')]
      const names = ['ToolSearch', 'CallTool']
      const first = await request(model, protocol, messages, names)
      assert.deepEqual(first.calls, [{ id: 'send-SEARCH_TEST-search', name: 'ToolSearch', input: { query: 'team_send', max_results: 10 } }])
      messages.push(receipt(protocol, first.calls[0].id, JSON.stringify({ tools: [{ name: 'mcp__halo-team__team_send', already_loaded: true }] })))
      const definition = await request(model, protocol, messages, names)
      assert.deepEqual(definition.calls, [{ id: 'send-SEARCH_TEST-definition', name: 'ToolSearch', input: { query: 'select:mcp__halo-team__team_send' } }])
      messages.push(receipt(protocol, definition.calls[0].id, JSON.stringify({ tools: [{ name: 'mcp__halo-team__team_send',
        version: '1', description: 'Send a directed message.', input_schema: { type: 'object' } }] })))
      const called = await request(model, protocol, messages, names)
      assert.deepEqual(called.calls, [{ id: 'send-SEARCH_TEST', name: 'CallTool', input: {
        tool: 'mcp__halo-team__team_send', arguments: JSON.stringify({ to: 'remote-member', message: 'DELIVERY' }),
      } }])
      messages.push(receipt(protocol, called.calls[0].id, 'Message delivered to "remote-member".'))
      assert.equal((await request(model, protocol, messages, names)).text, 'SENT_SEARCH_TEST')
      assert.deepEqual(model.errors, [])
      assert.deepEqual(model.issues, [])
    } finally { await model.close() }
  })

  test(`${protocol}: unavailable tools remain a recorded issue, not HTTP failure or a sent receipt`, async () => {
    const model = await startMixedVersionModel()
    try {
      model.register('MISSING_TEST', { kind: 'send', target: 'member', delivery: 'DELIVERY' })
      const reply = await request(model, protocol, [user('MISSING_TEST')])
      assert.equal(reply.text, 'UNAVAILABLE_MISSING_TEST')
      assert.deepEqual(reply.calls, [])
      assert.deepEqual(model.issues, ['Tool discovery failed for MISSING_TEST'])
      assert.deepEqual(model.errors, [])
      assert.equal(model.exchangesFor('MISSING_TEST')[0].completed, true)
    } finally { await model.close() }
  })

  test(`${protocol}: aborting an actual held HTTP stream records cancellation and fresh input completes`, { timeout: 5000 }, async () => {
    const model = await startMixedVersionModel()
    const controller = new AbortController()
    try {
      model.register('HOLD_TEST', { kind: 'hold' })
      model.register('FRESH_TEST', { kind: 'answer' })
      const response = await request(model, protocol, [user('HOLD_TEST')], [], { stream: true, signal: controller.signal })
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      const reader = response.body.getReader()
      const first = await reader.read()
      assert.equal(first.done, false)
      assert.match(new TextDecoder().decode(first.value), protocol === 'openai' ? /STREAM_HOLD_TEST/ : /message_start/)
      assert.equal(model.exchangesFor('HOLD_TEST')[0].completed, false)
      assert.equal(model.exchangesFor('HOLD_TEST')[0].cancelled, false)
      controller.abort()
      await assert.rejects(reader.read(), error => error.name === 'AbortError')
      const deadline = Date.now() + 2000
      while (!model.exchangesFor('HOLD_TEST')[0].cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(model.exchangesFor('HOLD_TEST')[0].cancelled, true)
      assert.equal(model.exchangesFor('HOLD_TEST')[0].completed, false)
      assert.equal((await request(model, protocol, [user('HOLD_TEST'), user('FRESH_TEST')])).text, 'RECEIVED_FRESH_TEST')
      assert.equal(model.exchangesFor('FRESH_TEST')[0].completed, true)
      assert.deepEqual(model.evidence().map(({ marker, completed, cancelled }) => ({ marker, completed, cancelled })), [
        { marker: 'HOLD_TEST', completed: false, cancelled: true }, { marker: 'FRESH_TEST', completed: true, cancelled: false },
      ])
      assert.deepEqual(model.errors, [])
      assert.deepEqual(model.issues, [])
    } finally { controller.abort(); await model.close() }
    assert.equal(model.exchangesFor('HOLD_TEST')[0].completed, false, 'Cleanup must not turn cancellation into completion')
  })
}

test('failed tool receipts are retained as fixture issues under native Anthropic normalization', async () => {
  const model = await startMixedVersionModel()
  try {
    model.register('REFUSED_TEST', { kind: 'send', target: 'member', delivery: 'DELIVERY' })
    await request(model, 'anthropic', [user('REFUSED_TEST'), receipt('anthropic', 'send-REFUSED_TEST', 'Permission denied', true)])
    assert.equal(model.issues.length, 1)
    assert.match(model.issues[0], /^Tool execution failed for REFUSED_TEST: contact-refused;/)
    assert.deepEqual(model.errors, [])
  } finally { await model.close() }
})
