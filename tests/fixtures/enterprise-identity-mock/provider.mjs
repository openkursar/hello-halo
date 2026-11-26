import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { methods, signInPage } from './sign-in-page.mjs'

const labels = { model: 'Models', intranet: 'Internal systems', mail: 'Mail' }
const capabilityIds = Object.keys(labels)
const defaultTtlMs = 30 * 60 * 1000
const defaultControlFile = join(tmpdir(), 'halo-org-mock-control.json')
const autoOutcomes = new Map([['succeed', 'succeeded'], ['cancel', 'cancelled'], ['fail', 'failed']])
const nonce = () => randomBytes(24).toString('base64url')

function reply(response, status, data) {
  const html = typeof data === 'string'
  response.writeHead(status, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(html ? data : JSON.stringify(data))
}

async function readControl(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') return null
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 4096) {
      request.resume()
      return null
    }
    chunks.push(chunk)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

export function createMockIdentity({ env = process.env, controlFile = defaultControlFile } = {}) {
  const requestedTtl = Number(env.HALO_ORG_MOCK_TTL_MS)
  const ttlMs = Number.isSafeInteger(requestedTtl) && requestedTtl > 0 && requestedTtl <= 2 ** 31 - 1 ? requestedTtl : defaultTtlMs
  const autoOutcome = autoOutcomes.get(env.HALO_ORG_MOCK_AUTO)
  const changes = new EventEmitter()
  const flows = new Map()
  const initialToken = nonce()
  let activeFlow
  let port
  let opening = Promise.resolve()
  let expiryTimer
  let restoreTimer
  let principalRevision = 0
  let phase = env.HALO_ORG_MOCK_RESTORE === '1' ? 'restoring' : 'settled'
  let subject
  let capabilities = {}
  let credentialMode = 'normal'

  function scanExpiries() {
    clearTimeout(expiryTimer)
    const now = Date.now()
    let next = Infinity
    let changed = false
    for (const state of Object.values(capabilities)) {
      if (state.status !== 'ready') continue
      if (state.expiresAt <= now) {
        state.status = 'expired'
        changed = true
      } else {
        next = Math.min(next, state.expiresAt)
      }
    }
    if (Number.isFinite(next)) expiryTimer = setTimeout(scanExpiries, next - now).unref()
    if (changed) changes.emit('change')
  }

  function grant(ids) {
    clearTimeout(restoreTimer)
    phase = 'settled'
    subject ??= nonce()
    const expiresAt = Date.now() + ttlMs
    for (const id of ids) capabilities[id] = { status: 'ready', expiresAt }
    scanExpiries()
    changes.emit('change')
  }

  function settle(flow, outcome, method) {
    if (!flow || flow.outcome) return false
    flow.outcome = outcome
    clearTimeout(flow.timeout)
    clearTimeout(flow.auto)
    flow.resolve(outcome)
    if (outcome === 'succeeded') grant(methods[method].grants)
    return true
  }

  function statusFor(flow) {
    return { scanned: flow?.scanned ?? false, outcome: flow?.outcome ?? null }
  }

  function control(data, flow) {
    switch (data.action) {
      case 'scan':
        if (!flow || flow.outcome) return 409
        flow.scanned = true
        return 200
      case 'confirm':
        if (!Object.hasOwn(methods, data.method)) return 400
        return settle(flow, 'succeeded', data.method) ? 200 : 409
      case 'expire': {
        if (!Object.hasOwn(labels, data.capability)) return 400
        const state = capabilities[data.capability]
        if (!state || state.status !== 'ready') return 409
        state.expiresAt = Date.now()
        scanExpiries()
        return 200
      }
      case 'switch-subject':
        if (!subject) return 409
        subject = nonce()
        principalRevision++
        changes.emit('change')
        return 200
      case 'credential':
        if (!['normal', 'slow', 'fail'].includes(data.mode)) return 400
        credentialMode = data.mode
        return 200
      default:
        return 400
    }
  }

  async function serve(request, response) {
    const host = `127.0.0.1:${port}`
    const origin = `http://${host}`
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)) {
      return reply(response, 403, { error: 'Invalid host or origin' })
    }
    const url = new URL(request.url, origin)
    const page = request.method === 'GET' && url.pathname === '/sign-in'
    const auth = request.headers.authorization
    const token = page ? url.searchParams.get('token') : auth?.startsWith('Bearer ') ? auth.slice(7) : null
    const flow = activeFlow
    if (!token || token !== (flow?.token ?? initialToken) || (page && !flow)) {
      return reply(response, 403, { error: 'Invalid mock token' })
    }
    if (page) return reply(response, 200, await signInPage(`example-org-mock:${flow.id}`, labels))
    if (request.method === 'GET' && url.pathname === '/status') return reply(response, 200, statusFor(flow))
    if (request.method === 'POST' && url.pathname === '/control') {
      const data = await readControl(request)
      if (flow !== activeFlow) return reply(response, 403, { error: 'Invalid mock token' })
      const code = data ? control(data, flow) : 400
      const errors = { 400: 'Invalid mock action', 409: 'Action is not available in the current state' }
      return reply(response, code, code === 200 ? statusFor(flow) : { error: errors[code] })
    }
    reply(response, 404, { error: 'Unknown mock route' })
  }

  const server = createServer({ requestTimeout: 5000 }, (request, response) => {
    serve(request, response).catch(error => {
      if (!request.aborted) {
        console.error('[Example Org mock] Could not serve the mock request', error.name)
        if (!response.headersSent) reply(response, 500, { error: 'Mock server error' })
      }
    })
  })
  server.on('error', error => console.error('[Example Org mock] Loopback server error', error.code))

  async function publishControl(token) {
    const temporaryFile = `${controlFile}.${nonce()}.tmp`
    await writeFile(temporaryFile, JSON.stringify({ port, token }), { flag: 'wx', mode: 0o600 })
    try {
      await rename(temporaryFile, controlFile)
    } catch (error) {
      await rm(temporaryFile, { force: true })
      throw error
    }
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      port = server.address().port
      resolve()
    })
  }).then(() => publishControl(initialToken))
  ready.catch(error => console.error('[Example Org mock] Could not publish control info', error.code))
  server.unref()

  const provider = {
    contractVersion: 2,
    capabilityCatalog: () => capabilityIds.map(id => ({ id, label: labels[id] })),
    snapshot() {
      return {
        phase,
        ...(subject ? { subject, account: { displayName: 'Example Member' } } : {}),
        capabilities: Object.fromEntries(Object.entries(capabilities).map(([id, state]) => [id, { ...state }]))
      }
    },
    onDidChange(listener) {
      const notify = () => listener()
      changes.on('change', notify)
      return { dispose: () => changes.off('change', notify) }
    },
    beginSignIn() {
      const begin = opening.then(async () => {
        await ready
        const flow = { id: nonce(), token: nonce(), scanned: false, outcome: null }
        flow.result = new Promise(resolve => { flow.resolve = resolve })
        settle(activeFlow, 'cancelled')
        activeFlow = flow
        flows.set(flow.id, flow)
        try {
          await publishControl(flow.token)
        } catch (error) {
          settle(flow, 'failed')
          throw error
        }
        if (!flow.outcome) {
          flow.timeout = setTimeout(() => settle(flow, 'expired'), ttlMs).unref()
          if (autoOutcome) flow.auto = setTimeout(() => settle(flow, autoOutcome, 'phone'), 700).unref()
        }
        return { flowId: flow.id, url: `http://127.0.0.1:${port}/sign-in?token=${flow.token}` }
      })
      opening = begin.catch(() => {})
      return begin
    },
    async awaitSignIn(flowId) {
      const flow = flows.get(flowId)
      if (!flow) throw new Error('Unknown mock sign-in flow')
      return flow.result
    },
    async cancelSignIn(flowId) { settle(flows.get(flowId), 'cancelled') },
    async verify() { scanExpiries() },
    supportsDeviceUnbind: true,
    async signOut(scope) {
      if (scope !== 'session' && scope !== 'device') throw new Error('Invalid mock sign-out scope')
      clearTimeout(restoreTimer)
      clearTimeout(expiryTimer)
      settle(activeFlow, 'cancelled')
      phase = 'settled'
      principalRevision++
      subject = undefined
      capabilities = {}
      changes.emit('change')
    },
    async issueCredential(audience) {
      const capability = audience.startsWith('mail-') ? 'mail' : 'intranet'
      function getReadyCapability() {
        const state = capabilities[capability]
        if (!subject || state?.status !== 'ready' || state.expiresAt <= Date.now()) {
          throw new Error(`Mock capability is not ready: ${capability}`)
        }
        return state
      }
      getReadyCapability()
      const revision = principalRevision
      const mode = credentialMode
      if (mode === 'slow') await delay(2500)
      if (revision !== principalRevision) throw new Error('Mock subject changed before issuing a credential')
      if (mode === 'fail') throw new Error('Mock credential issuance failed')
      const state = getReadyCapability()
      return { token: `mock-${nonce()}`, expiresAt: Math.min(state.expiresAt, Date.now() + 5 * 60 * 1000) }
    }
  }

  if (phase === 'restoring') restoreTimer = setTimeout(() => grant(methods.phone.grants), 800).unref()

  return {
    provider,
    ready,
    async close() {
      await opening
      clearTimeout(expiryTimer)
      clearTimeout(restoreTimer)
      settle(activeFlow, 'cancelled')
      await ready.catch(() => {})
      await new Promise(resolve => server.close(resolve))
    }
  }
}

export function getMockOrganizationProvider() {
  return createMockIdentity({ controlFile: process.env.HALO_ORG_MOCK_CONTROL_FILE || defaultControlFile }).provider
}
