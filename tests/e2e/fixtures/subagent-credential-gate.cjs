const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(process.env.HOME, '.halo/config.json')
const config = JSON.parse(fs.readFileSync(file, 'utf8'))
config.network = { ...config.network, proxy: '', noProxy: '*', requireProxyForOAuth: false }
if (!config.aiSources.sources.some(source => source.id === 'cancellation-copilot')) config.aiSources.sources.push({
  id: 'cancellation-copilot', name: 'Cancellation credential fixture', provider: 'github-copilot', authType: 'oauth',
  accessToken: 'synthetic-cancellation-oauth', tokenExpires: Date.now() + 3600000,
  model: 'gpt-4o', availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
fs.writeFileSync(file, JSON.stringify(config))
const observation = { tokenRequests: 0, sessionRequests: 0, sessionResponses: 0, inferenceRequests: 0, unexpected: [], released: false }
let release
const gate = new Promise(resolve => { release = resolve })
let origin
const server = http.createServer(async (request, response) => {
  const send = body => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
  const expires_at = Math.floor(Date.now() / 1000) + 3600
  if (request.url === '/token') {
    observation.tokenRequests++
    if (request.headers.authorization !== 'token synthetic-cancellation-oauth') observation.unexpected.push('token-credential-identity')
    send({ token: 'synthetic-copilot-token', expires_at, endpoints: { api: origin } })
  } else if (request.url === '/models/session' && request.method === 'POST') {
    if (request.headers.authorization !== 'Bearer synthetic-copilot-token') observation.unexpected.push('session-credential-identity')
    let body = ''
    for await (const chunk of request) body += chunk
    const hints = JSON.parse(body).auto_mode?.model_hints
    if (JSON.stringify(hints) !== JSON.stringify(['gpt-4o'])) observation.unexpected.push('session-model-hints')
    observation.sessionRequests++
    await gate
    observation.sessionResponses++
    send({ session_token: 'synthetic-session-token', expires_at, selected_model: 'gpt-4o', available_models: ['gpt-4o'] })
  } else if (request.url === '/models') {
    send({ data: [{ id: 'gpt-4o', name: 'gpt-4o', model_picker_enabled: true, capabilities: { type: 'chat' } }] })
  } else {
    observation.inferenceRequests++
    response.writeHead(503); response.end('Unexpected inference after cancellation')
  }
})
const ready = new Promise(resolve => server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve() }))
const fetch = globalThis.fetch
// Substitute transport only; the source manager and provider retain their real implementations.
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.href === 'https://api.github.com/copilot_internal/v2/token') {
    await ready
    return fetch.call(this, `${origin}/token`, init)
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
    observation.unexpected.push(`external:${url.hostname}`)
    throw new Error('Credential fixture refuses non-loopback transport')
  }
  return fetch.call(this, input, init)
}
globalThis.cancellationCredentialGate = {
  state: () => ({ ...observation, unexpected: [...observation.unexpected] }),
  release: () => { observation.released = true; release() },
}
require('electron').app.on('before-quit', () => { release(); server.closeAllConnections(); server.close() })
