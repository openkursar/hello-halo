import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const source = fs.readFileSync(new URL('../../../scripts/acceptance/ci-dispatch.mjs', import.meta.url), 'utf8')
const requestId = '12345678-1234-1234-1234-123456789abc'
const requestedAt = '2026-01-02T03:04:05.000Z'
const record = () => ({ version: 1, requestId, repository: 'example/controller', workflow: 'acceptance.yml', requestedAt, status: 'unknown', request: { ref: 'main', inputs: { request_id: requestId, source_ref: 'feature', profile: 'fast', cases: 'app.example' } } })
const run = (id, changes = {}) => ({ id, event: 'workflow_dispatch', path: '.github/workflows/acceptance.yml', display_title: `Acceptance ${requestId} · fast`, created_at: requestedAt, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: 'controller-revision', ...changes })
const response = (workflowRuns, total = workflowRuns.length) => ({ http: 200, body: { workflow_runs: workflowRuns, total_count: total } })

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-dispatch-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const script = path.join(root, 'scripts/acceptance/ci-dispatch.mjs')
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.writeFileSync(script, source)
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ now: Date.parse(requestedAt) + 60000, responses: [{ http: 204 }], ...options }))
  const preload = path.join(root, 'preload.mjs')
  fs.writeFileSync(preload, String.raw`
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fixture = JSON.parse(fs.readFileSync('fixture.json', 'utf8'));
let cursor = 0, now = fixture.now;
Date.now = () => now;
const log = item => fs.appendFileSync('calls.jsonl', JSON.stringify(item) + '\n');
childProcess.spawnSync = (command, args, options = {}) => {
  if (command === 'git' && args.length === 4 && args.slice(0, 3).join(' ') === 'config --local --get') {
    const value = fixture.settings?.[args[3]];
    log({ command: 'git', setting: args[3] });
    return { status: value === undefined ? 1 : 0, stdout: value === undefined ? '' : value + '\n', stderr: '' };
  }
  if (command !== 'gh') throw new Error('Unexpected external process in isolated test.');
  const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
  const environment = {
    proxyMatches: proxyNames.every(name => options.env[name] === fixture.expectedProxy),
    proxyAbsent: proxyNames.every(name => options.env[name] === undefined),
    bypassCleared: options.env.NO_PROXY === '' && options.env.no_proxy === '',
    tokenMatches: options.env.GH_TOKEN === fixture.expectedToken,
    debugRemoved: options.env.GH_DEBUG === undefined && options.env.GH_FORCE_TTY === undefined,
  };
  if (args.slice(0, 5).join(' ') === 'auth token --hostname github.com --user') {
    log({ command: 'auth', account: args[5], timeout: options.timeout, environment });
    return { status: 0, stdout: fixture.authToken + '\n', stderr: '' };
  }
  if (args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'github.com' || args[3] !== '--method' || args[5] !== '--include') throw new Error('Unexpected GitHub request format.');
  const entry = fixture.responses[Math.min(cursor++, fixture.responses.length - 1)];
  log({ command: 'api', method: args[4], endpoint: args[6], timeout: options.timeout, killSignal: options.killSignal, input: options.input ? JSON.parse(options.input) : null, environment });
  if (fixture.mutateReceipt) fs.appendFileSync('receipt.json', ' ');
  now += entry.advanceMs ?? 0;
  return {
    status: entry.exitCode ?? (entry.http >= 400 ? 1 : 0),
    stdout: entry.stdout ?? (entry.http ? 'HTTP/2.0 ' + entry.http + ' Status\r\nContent-Type: application/json\r\n\r\n' + (entry.rawBody ?? JSON.stringify(entry.body ?? {})) : ''),
    stderr: entry.stderr ?? '',
    error: entry.errorCode ? { code: entry.errorCode } : undefined,
    signal: entry.signal,
  };
};
syncBuiltinESMExports();
`)
  return {
    root,
    receipt(value = record()) { fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(value, null, 2) + '\n'); return path.join(root, 'receipt.json') },
    calls() { const filename = path.join(root, 'calls.jsonl'); return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] },
    read() { return JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'), 'utf8')) },
    execute(args, overrides = {}) {
      const env = { ...process.env, PATH: '', GH_DEBUG: 'api', GH_FORCE_TTY: '100', ...overrides }
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'HALO_ACCEPTANCE_CI_PROXY', 'HALO_ACCEPTANCE_CI_REPOSITORY']) if (!Object.hasOwn(overrides, name)) delete env[name]
      return spawnSync(process.execPath, ['--import', preload, script, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
    },
    dispatchRecord(result) { const { receipt } = JSON.parse(result.stdout.split('\n')[0]); return { receipt, value: JSON.parse(fs.readFileSync(receipt, 'utf8')) } },
  }
}

function assertPrivate(result, value, secrets) {
  const serialized = result.stdout + result.stderr + JSON.stringify(value)
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'Sensitive transport data escaped its process environment')
}

test('dispatch preview performs no authenticated request and preserves the controller default source ref', context => {
  const selected = fixture(context)
  const result = selected.execute(['--repository', 'example/controller', '--case', 'app.example'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Preview only/)
  assert.doesNotMatch(result.stdout, /source_ref/)
  assert.equal(selected.calls().some(call => call.command === 'api' || call.command === 'auth'), false)
  assert.equal(fs.existsSync(path.join(selected.root, 'tests/acceptance/output')), false)
})

test('a local proxy applies only to authenticated child processes and records no credential or URL', context => {
  const proxy = 'http://proxy-user:proxy-password@proxy.invalid:8080'
  const token = 'private-fixture-token'
  const selected = fixture(context, { settings: { 'halo.acceptanceProxy': proxy, 'halo.acceptanceAccount': 'example-user' }, authToken: token, expectedProxy: proxy, expectedToken: token })
  const result = selected.execute(['--repository', 'example/controller', '--execute'])
  assert.equal(result.status, 0, result.stderr)
  const { receipt, value } = selected.dispatchRecord(result)
  assert.equal(value.status, 'accepted')
  assert.equal(value.transport.proxyConfiguration, 'git-override')
  const calls = selected.calls().filter(call => call.command !== 'git')
  assert.deepEqual(calls.map(call => call.command), ['auth', 'api'])
  assert(calls.every(call => call.environment.proxyMatches && call.environment.bypassCleared && call.environment.debugRemoved))
  assert.equal(calls[1].environment.tokenMatches, true)
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].timeout, 30000)
  assert.equal(calls[1].killSignal, 'SIGKILL')
  assert.equal(calls[1].input.inputs.request_id, value.requestId)
  if (process.platform !== 'win32') assert.equal(fs.statSync(receipt).mode & 0o777, 0o600)
  assertPrivate(result, value, [proxy, 'proxy-password', token])
})

test('explicit proxy settings override local configuration and an empty override clears inherited proxies', context => {
  for (const proxy of ['https://override.invalid:8443', '']) {
    const selected = fixture(context, { settings: { 'halo.acceptanceProxy': 'http://unused.invalid:8888', 'halo.acceptanceAccount': 'unused-account' }, expectedProxy: proxy || undefined, expectedToken: 'existing-process-token' })
    const result = selected.execute(['--repository', 'example/controller', '--execute'], { HALO_ACCEPTANCE_CI_PROXY: proxy, GH_TOKEN: 'existing-process-token', HTTP_PROXY: 'http://inherited.invalid:80', NO_PROXY: '*' })
    assert.equal(result.status, 0, result.stderr)
    const call = selected.calls().find(call => call.command === 'api')
    assert.equal(call.environment.proxyMatches, true)
    assert.equal(call.environment.bypassCleared, true)
    assert.equal(call.environment.proxyAbsent, proxy === '')
    assert.equal(selected.calls().some(call => call.command === 'auth' || call.setting === 'halo.acceptanceProxy'), false)
    assert.equal(selected.dispatchRecord(result).value.transport.proxyConfiguration, 'environment-override')
  }
})

test('invalid proxy endpoints fail without exposing values or attempting an authenticated request', context => {
  for (const proxy of ['socks5://private-password@proxy.invalid:1080', 'http://proxy.invalid/path-secret', 'http://proxy.invalid/?key=secret', 'http://proxy.invalid/\nsecret', 'http:proxy.invalid', 'http:/proxy.invalid', 'http:///proxy.invalid', ' http://proxy.invalid', 'http://proxy.invalid\\bad']) {
    const selected = fixture(context)
    const result = selected.execute(['--repository', 'example/controller', '--execute'], { HALO_ACCEPTANCE_CI_PROXY: proxy })
    assert.equal(result.status, 1)
    assert.equal(selected.calls().some(call => call.command === 'api' || call.command === 'auth'), false)
    assert.equal(fs.existsSync(path.join(selected.root, 'tests/acceptance/output/dispatches')), false)
    assertPrivate(result, {}, [proxy, 'private-password', 'path-secret', 'key=secret'])
  }
})

test('ambiguous transport failures remain unknown while a received explicit client rejection is rejected', context => {
  for (const [entry, status, category, errorCode] of [
    [{ exitCode: 1, stderr: 'Post https://private-fixture-token@host.invalid: unexpected EOF' }, 'unknown', 'eof', 'EOF'],
    [{ exitCode: 1, stderr: 'tls: certificate private-fixture-token invalid' }, 'unknown', 'tls', 'TLS_ERROR'],
    [{ http: 502, stderr: 'HTTP 502 private-fixture-token' }, 'unknown', 'http', 'HTTP_502'],
    [{ http: 408 }, 'unknown', 'http', 'HTTP_408'],
    [{ errorCode: 'ETIMEDOUT', exitCode: null, signal: 'SIGKILL' }, 'unknown', 'timeout', 'ETIMEDOUT'],
    [{ stdout: 'untrusted response body\nHTTP/2.0 204 spoofed', stderr: 'EOF', exitCode: 1 }, 'unknown', 'eof', 'EOF'],
    [{ http: 403 }, 'rejected', 'http', 'HTTP_403'],
  ]) {
    const selected = fixture(context, { responses: [entry] })
    const result = selected.execute(['--repository', 'example/controller', '--execute'])
    assert.equal(result.status, 1)
    const { value } = selected.dispatchRecord(result)
    assert.equal(value.status, status)
    assert.equal(value.transport.category, category)
    assert.equal(value.transport.errorCode, errorCode)
    assert.equal(selected.calls().filter(call => call.command === 'api').length, 1)
    assertPrivate(result, value, ['private-fixture-token', 'untrusted response body'])
  }
})

test('receipt lookup is GET-only and zero matches neither rewrites the receipt nor declares rejection', context => {
  const selected = fixture(context, { responses: [response([])] })
  const filename = selected.receipt()
  const before = fs.readFileSync(filename, 'utf8')
  const result = selected.execute(['--receipt', filename])
  assert.equal(result.status, 0, result.stderr)
  const observation = JSON.parse(result.stdout)
  assert.equal(observation.outcome, 'no-match-yet')
  assert.equal(observation.complete, true)
  assert.equal(observation.matchCount, 0)
  assert.equal(fs.readFileSync(filename, 'utf8'), before)
  const calls = selected.calls().filter(call => call.command === 'api')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].input, null)
  const endpoint = new URL('https://api.github.com/' + calls[0].endpoint)
  assert.equal(endpoint.pathname, '/repos/example/controller/actions/workflows/acceptance.yml/runs')
  assert.deepEqual([...endpoint.searchParams.keys()].sort(), ['created', 'event', 'exclude_pull_requests', 'page', 'per_page'])
  assert.equal(endpoint.searchParams.get('event'), 'workflow_dispatch')
  assert.equal(endpoint.searchParams.get('per_page'), '100')
  assert.equal(endpoint.searchParams.get('exclude_pull_requests'), 'true')
})

test('reconciliation scans all pages, deduplicates run ids and preserves the original request and dispatch result', context => {
  const selected = fixture(context, { responses: [response([run(1), run(2, { display_title: `Acceptance ${requestId}x · fast` })], 3), response([run(1, { status: 'in_progress', conclusion: null }), run(3, { event: 'schedule' })], 3)] })
  const original = record()
  const filename = selected.receipt(original)
  const result = selected.execute(['--receipt', filename, '--reconcile'])
  assert.equal(result.status, 0, result.stderr)
  const observation = JSON.parse(result.stdout)
  assert.equal(observation.outcome, 'one-match')
  assert.equal(observation.matchCount, 1)
  assert.equal(observation.search.pages, 2)
  assert.deepEqual(observation.runs.map(item => item.id), [1])
  assert.equal(observation.runs[0].status, 'in_progress')
  assert.equal(Object.hasOwn(observation.runs[0], 'head_sha'), false)
  const { reconciliation, ...unchanged } = selected.read()
  assert.deepEqual(unchanged, original)
  assert.deepEqual(reconciliation, observation)
  const calls = selected.calls().filter(call => call.command === 'api')
  assert(calls.every(call => call.method === 'GET' && call.timeout <= 15000))
  assert.equal(new Set(calls.map(call => new URL('https://api.github.com/' + call.endpoint).searchParams.get('created'))).size, 1)
})

test('multiple matching workflow runs are reported without selecting one or resending', context => {
  const selected = fixture(context, { responses: [response([run(2), run(1)])] })
  const result = selected.execute(['--receipt', selected.receipt(), '--reconcile'])
  assert.equal(result.status, 0, result.stderr)
  const observation = JSON.parse(result.stdout)
  assert.equal(observation.outcome, 'multiple-matches')
  assert.deepEqual(observation.runs.map(item => item.id), [1, 2])
  assert.equal(selected.read().status, 'unknown')
  assert(selected.calls().filter(call => call.command === 'api').every(call => call.method === 'GET'))
})

test('a later page failure or malformed response cannot establish a unique matching run', context => {
  for (const entry of [
    { exitCode: 1, stderr: 'unexpected EOF private-fixture-token' },
    { http: 200, rawBody: 'invalid private-fixture-token' },
    { http: 200, body: null },
    { http: 200, body: { total_count: 2, workflow_runs: [null] } },
    { http: 200, body: { total_count: 0, workflow_runs: [run(2)] } },
    response([], 2),
  ]) {
    const selected = fixture(context, { responses: [response([run(1)], 2), entry] })
    const result = selected.execute(['--receipt', selected.receipt(), '--reconcile'])
    assert.equal(result.status, 2, result.stderr)
    const observation = JSON.parse(result.stdout)
    assert.equal(observation.outcome, 'incomplete')
    assert.equal(observation.complete, false)
    assert.equal(observation.matchCount, 1)
    assert.equal(selected.read().status, 'unknown')
    assertPrivate(result, selected.read(), ['private-fixture-token'])
  }
})

test('lookup caps pagination and uses the remaining total deadline for each request', context => {
  const capped = fixture(context, { responses: [response([run(1)], 1001)] })
  const result = capped.execute(['--receipt', capped.receipt()])
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).search.failure, 'page-limit')
  assert.equal(capped.calls().filter(call => call.command === 'api').length, 10)
  const deadline = fixture(context, { responses: [{ ...response([run(1)], 2), advanceMs: 55000 }, { ...response([run(1)], 2), advanceMs: 5000 }] })
  const exhausted = deadline.execute(['--receipt', deadline.receipt()])
  assert.equal(exhausted.status, 2)
  assert.equal(JSON.parse(exhausted.stdout).search.failure, 'lookup-deadline')
  assert.deepEqual(deadline.calls().filter(call => call.command === 'api').map(call => call.timeout), [15000, 5000])
})

test('unsafe or unsupported receipt identity and ambiguous CLI modes are rejected before authentication', context => {
  for (const invalid of [null, [], { ...record(), version: 2 }, { ...record(), repository: '../controller' }, { ...record(), repository: 'https://attacker.invalid/repo' }, { ...record(), workflow: '../acceptance.yml' }, { ...record(), requestId: 'not-a-uuid' }, { ...record(), requestedAt: null }, { ...record(), request: { inputs: { request_id: 'different' } } }]) {
    const selected = fixture(context)
    const result = selected.execute(['--receipt', selected.receipt(invalid)])
    assert.equal(result.status, 1)
    assert.equal(selected.calls().length, 0)
  }
  for (const args of [['--reconcile'], ['--receipt', 'receipt.json', '--execute'], ['--receipt', 'receipt.json', '--source-ref', 'feature']]) {
    const selected = fixture(context)
    selected.receipt()
    assert.equal(selected.execute(args).status, 1)
    assert.equal(selected.calls().length, 0)
  }
})

test('receipt reconciliation refuses to overwrite a concurrent change', context => {
  const selected = fixture(context, { responses: [response([])], mutateReceipt: true })
  const filename = selected.receipt()
  const result = selected.execute(['--receipt', filename, '--reconcile'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /changed during lookup/)
  assert.equal(selected.read().reconciliation, undefined)
  assert.equal(fs.readFileSync(filename, 'utf8').endsWith(' '), true)
})
