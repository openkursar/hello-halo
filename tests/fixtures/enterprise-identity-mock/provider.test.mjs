import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createMockIdentity } from './provider.mjs'

async function fixture(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'halo-org-mock-test-'))
  const controlFile = join(directory, 'control.json')
  const mock = createMockIdentity({ env, controlFile })
  t.after(async () => {
    await mock.close()
    await rm(directory, { recursive: true })
  })
  await mock.ready

  const connection = async () => JSON.parse(await readFile(controlFile, 'utf8'))
  const request = async (path, { token, body, ...extra } = {}) => {
    const current = await connection()
    return fetch(`http://127.0.0.1:${current.port}${path}`, {
      ...extra,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { Authorization: `Bearer ${token ?? current.token}`, 'Content-Type': 'application/json', ...extra.headers }
    })
  }
  return { provider: mock.provider, controlFile, connection, request, control: body => request('/control', { body }) }
}

const confirm = method => ({ action: 'confirm', method })
const phoneCapabilities = ['intranet', 'mail', 'model']

test('offers the v2 catalog without granting capabilities up front', async t => {
  const { provider, controlFile } = await fixture(t)
  assert.equal(provider.contractVersion, 2)
  assert.deepEqual(provider.capabilityCatalog(), [
    { id: 'model', label: 'Models' }, { id: 'intranet', label: 'Internal systems' }, { id: 'mail', label: 'Mail' }
  ])
  assert.deepEqual(provider.snapshot(), { phase: 'settled', capabilities: {} })
  if (process.platform !== 'win32') assert.equal((await stat(controlFile)).mode & 0o777, 0o600)
  await assert.rejects(provider.issueCredential('mail-example'), /not ready: mail/)
})

test('serves the three tabs and confirms a flow once for all current and late waiters', async t => {
  const { provider, request, connection, control } = await fixture(t)
  const before = await connection()
  const { flowId, url } = await provider.beginSignIn()
  const after = await connection()
  assert.notEqual(before.token, after.token)
  assert.equal(new URL(url).searchParams.get('token'), after.token)
  assert.equal((await request('/status', { token: before.token })).status, 403)
  assert.equal((await request('/status', { headers: { Origin: 'https://example.invalid' } })).status, 403)
  const page = await fetch(url)
  assert.equal(page.status, 200)
  const markup = await page.text()
  for (const label of ['Phone app', 'Web', 'Account']) assert.ok(markup.includes(label))
  assert.equal((markup.match(/Confirm \(mock\)/g) ?? []).length, 3)
  assert.match(markup, /data:image\/png;base64,|class="qr-text"/)

  let updates = 0
  const listener = provider.onDidChange(() => updates++)
  const first = provider.awaitSignIn(flowId)
  const second = provider.awaitSignIn(flowId)
  assert.equal((await control({ action: 'scan' })).status, 200)
  assert.deepEqual(await (await request('/status')).json(), { scanned: true, outcome: null })
  assert.equal((await control(confirm('phone'))).status, 200)
  assert.deepEqual(await Promise.all([first, second, provider.awaitSignIn(flowId)]), ['succeeded', 'succeeded', 'succeeded'])
  assert.equal((await control(confirm('web'))).status, 409)
  await provider.cancelSignIn(flowId)
  assert.equal(await provider.awaitSignIn(flowId), 'succeeded')
  assert.deepEqual(Object.keys(provider.snapshot().capabilities).sort(), phoneCapabilities)
  assert.equal(updates, 1)
  listener.dispose()
  await provider.signOut('session')
  assert.equal(updates, 1)
})

test('expires one capability, switches subject without changing the display name, and fails issuance on demand', async t => {
  const { provider, control } = await fixture(t, { HALO_ORG_MOCK_TTL_MS: '60000' })
  await provider.beginSignIn()
  assert.equal((await control(confirm('phone'))).status, 200)
  const initial = provider.snapshot()
  const credential = await provider.issueCredential('mail-example')
  assert.match(credential.token, /^mock-/)
  assert.ok(credential.expiresAt > Date.now() && credential.expiresAt <= initial.capabilities.mail.expiresAt)
  assert.notEqual(credential.token, (await provider.issueCredential('mail-example')).token)

  assert.equal((await control({ action: 'expire', capability: 'mail' })).status, 200)
  await assert.rejects(provider.issueCredential('mail-example'), /not ready: mail/)
  assert.equal(provider.snapshot().capabilities.mail.status, 'expired')
  assert.deepEqual(provider.snapshot().capabilities.intranet, initial.capabilities.intranet)
  assert.deepEqual(provider.snapshot().capabilities.model, initial.capabilities.model)

  assert.equal((await control({ action: 'credential', mode: 'fail' })).status, 200)
  await assert.rejects(provider.issueCredential('example'), /issuance failed/)
  assert.equal((await control({ action: 'credential', mode: 'slow' })).status, 200)
  const capabilitiesBeforeSwitch = provider.snapshot().capabilities
  const delayed = assert.rejects(provider.issueCredential('example'), /subject changed/)
  assert.equal((await control({ action: 'switch-subject' })).status, 200)
  const switched = provider.snapshot()
  assert.notEqual(switched.subject, initial.subject)
  assert.deepEqual(switched.account, initial.account)
  assert.deepEqual(switched.capabilities, capabilitiesBeforeSwitch)
  await delayed
  assert.equal((await control({ action: 'credential', mode: 'normal' })).status, 200)
  assert.equal((await provider.issueCredential('example')).expiresAt, switched.capabilities.intranet.expiresAt)
  assert.equal(provider.supportsDeviceUnbind, true)
  await provider.signOut('device')
  assert.deepEqual(provider.snapshot(), { phase: 'settled', capabilities: {} })
})

test('starts restoring with no principal, then notifies when signed in', async t => {
  const { provider } = await fixture(t, { HALO_ORG_MOCK_RESTORE: '1' })
  assert.deepEqual(provider.snapshot(), { phase: 'restoring', capabilities: {} })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Restore did not settle')) }, 3000)
    const subscription = provider.onDidChange(() => {
      clearTimeout(timeout)
      subscription.dispose()
      resolve()
    })
  })
  assert.equal(provider.snapshot().phase, 'settled')
  assert.ok(provider.snapshot().subject)
  assert.deepEqual(Object.keys(provider.snapshot().capabilities).sort(), phoneCapabilities)
})

test('replaces a pending flow and grants only the chosen method without removing earlier grants', async t => {
  const { provider, control, connection, request } = await fixture(t)
  const previous = await provider.beginSignIn()
  const { token } = await connection()
  const next = await provider.beginSignIn()
  assert.equal(await provider.awaitSignIn(previous.flowId), 'cancelled')
  assert.equal((await request('/control', { token, body: confirm('phone') })).status, 403)
  assert.equal((await control(confirm('account'))).status, 200)
  assert.equal(await provider.awaitSignIn(next.flowId), 'succeeded')
  assert.deepEqual(Object.keys(provider.snapshot().capabilities), ['model'])
  await assert.rejects(provider.issueCredential('example'), /not ready: intranet/)
  await provider.beginSignIn()
  assert.equal((await control(confirm('web'))).status, 200)
  assert.deepEqual(Object.keys(provider.snapshot().capabilities).sort(), ['intranet', 'model'])
})

test('supports noninteractive outcomes and expires a never-confirmed flow', async t => {
  const cases = [
    { mode: 'succeed', expected: 'succeeded', ttl: '60000' },
    { mode: 'cancel', expected: 'cancelled', ttl: '60000' },
    { mode: 'fail', expected: 'failed', ttl: '60000' },
    { mode: 'never', expected: 'expired', ttl: '80' }
  ]
  await Promise.all(cases.map(({ mode, expected, ttl }) => t.test(mode, async st => {
    const { provider } = await fixture(st, { HALO_ORG_MOCK_AUTO: mode, HALO_ORG_MOCK_TTL_MS: ttl })
    const { flowId } = await provider.beginSignIn()
    const timeout = new AbortController()
    try {
      const outcome = await Promise.race([provider.awaitSignIn(flowId), delay(3000, 'timed out', { signal: timeout.signal })])
      assert.equal(outcome, expected)
      assert.equal(await provider.awaitSignIn(flowId), expected)
    } finally {
      timeout.abort()
    }
  })))
})
