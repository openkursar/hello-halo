/**
 * Empirical smoke test for the dsh transport.
 *
 * Boots a real runtime child through the real launch spec, runs the full
 * handshake → prompt → turn → shutdown sequence, and records every JSON-RPC
 * frame the runtime emitted into `../../__fixtures__/`.
 *
 * The model endpoint is a local OpenAI-compatible SSE stub, so this runs
 * without a DeepSeek API key and produces a deterministic event stream. Point
 * DEEPSEEK_BASE_URL at the real service and pass a key to exercise a live model.
 *
 * Run from the repo root:  node src/main/services/agent/dsh/transport/__smoke__/smoke.mjs
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, '..', '..', '__fixtures__')
const repoRoot = path.resolve(here, '..', '..', '..', '..', '..', '..', '..')

const ENTRY = path.join(
  repoRoot,
  'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js'
)

if (!existsSync(ENTRY)) {
  console.error(`[smoke] runtime entry not found: ${ENTRY}`)
  process.exit(1)
}

/**
 * Two scripted assistant turns: a plain text reply, then a tool call followed
 * by its post-tool summary. The tool turn is what produces tool lifecycle
 * events in the fixture.
 */
const responses = [
  (res) => {
    sse(res, [
      { choices: [{ delta: { role: 'assistant', content: null } }] },
      { choices: [{ delta: { content: 'Hello! I am the dsh runtime speaking through Halo.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 24, completion_tokens: 12 } },
    ])
  },
  (res) => {
    sse(res, [
      { choices: [{ delta: { role: 'assistant', content: null } }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_smoke_1',
              type: 'function',
              function: { name: 'todo_write', arguments: '' },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"todos":[{"id":"1","content":"probe the transport","status":"in_progress"}]}' },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 20 } },
    ])
  },
  (res) => {
    sse(res, [
      { choices: [{ delta: { role: 'assistant', content: null } }] },
      { choices: [{ delta: { content: 'Recorded the todo.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 6 } },
    ])
  },
]

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.end('data: [DONE]\n\n')
}

let requestIndex = 0
const modelRequests = []
const modelServer = createServer((req, res) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    modelRequests.push(JSON.parse(body))
    const handler = responses[Math.min(requestIndex++, responses.length - 1)]
    handler(res)
  })
})
await new Promise((r) => modelServer.listen(0, '127.0.0.1', r))
const port = modelServer.address().port

const workDir = mkdtempSync(path.join(tmpdir(), 'dsh-smoke-work-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'dsh-smoke-data-'))

// Mirrors buildDshLaunchSpec's allowlist: nothing is inherited blindly.
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DEEPSEEK_API_KEY: 'smoke-local-stub-not-a-real-key',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
  DSH_CWD: workDir,
  DSH_SESSION_ROOT: path.join(dataDir, 'sessions'),
  DSH_SYSTEM_PROMPT: 'You are Halo, a helpful assistant.',
  DSH_TELEMETRY_DISABLED: '1',
}

const configPath = path.join(dataDir, 'halo.cordis.yml')
mkdirSync(dataDir, { recursive: true })
writeFileSync(configPath, extractConfig(), 'utf-8')

console.log(`[smoke] entry=${ENTRY}`)
console.log(`[smoke] config=${configPath}`)
console.log(`[smoke] workDir=${workDir}`)

const child = spawn(process.execPath, [ENTRY, configPath], {
  cwd: workDir,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const frames = []
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => { stderr += c })

const listeners = []
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  frames.push(line)
  let v
  try { v = JSON.parse(line) } catch { console.log(`[smoke] NON-JSON: ${line.slice(0, 120)}`); return }
  const label = v.method === 'session.event'
    ? `session.event ${v.params?.event?.type}`
    : (v.method ?? `response#${v.id}`)
  console.log(`[smoke] <- ${label}`)
  listeners.forEach((f) => f(v))
})

let exitInfo = null
const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve() })
})

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n')
const waitFor = (pred, label, ms = 40000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}; stderr=${stderr.slice(-2000)}`)), ms)
  listeners.push((v) => { if (pred(v)) { clearTimeout(t); resolve(v) } })
})
const waitIdle = () => waitFor(
  (v) => v.method === 'session.status' && v.params?.status === 'idle',
  'agent idle'
)

let failure = null
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: workDir, provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 2048 } })
  const init = await waitFor((v) => v.id === 1, 'initialize')
  console.log(`[smoke] serverInfo=${JSON.stringify(init.result.serverInfo)}`)

  send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'say hi' }] } })
  const p1 = await waitFor((v) => v.id === 2, 'prompt#1')
  console.log(`[smoke] messageId=${p1.result.messageId}`)
  await waitIdle()

  send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'track a todo for me' }] } })
  await waitFor((v) => v.id === 3, 'prompt#2')
  await waitIdle()

  send({ jsonrpc: '2.0', id: 4, method: 'shutdown' })
  await waitFor((v) => v.id === 4, 'shutdown')
  console.log('[smoke] shutdown acknowledged')
} catch (err) {
  failure = err
  console.error(`[smoke] FAILED: ${err.message}`)
}

// Clean-exit check: the runtime should exit on its own after `shutdown`.
const cleanExit = await Promise.race([
  exited.then(() => true),
  new Promise((r) => setTimeout(() => r(false), 5000)),
])
if (!cleanExit) {
  console.error('[smoke] runtime did not exit after shutdown; escalating')
  child.stdin.end()
  const afterEof = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))])
  if (!afterEof) { child.kill('SIGTERM'); await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]) }
  if (!exitInfo) child.kill('SIGKILL')
}

mkdirSync(fixturesDir, { recursive: true })
const fixturePath = path.join(fixturesDir, 'runtime-notifications.jsonl')
writeFileSync(fixturePath, frames.join('\n') + '\n', 'utf-8')

const eventTypes = {}
for (const line of frames) {
  const v = JSON.parse(line)
  if (v.method === 'session.event') {
    const t = v.params?.event?.type ?? '(untyped)'
    eventTypes[t] = (eventTypes[t] ?? 0) + 1
  }
}

console.log('\n=== smoke summary ===')
console.log(`frames captured : ${frames.length}`)
console.log(`model requests  : ${modelRequests.length}`)
console.log(`exit            : code=${exitInfo?.code} signal=${exitInfo?.signal} clean=${cleanExit}`)
console.log(`fixture         : ${fixturePath}`)
console.log('session.event types:')
for (const [t, n] of Object.entries(eventTypes).sort()) console.log(`  ${String(n).padStart(3)}  ${t}`)
if (stderr.trim()) console.log(`\nruntime stderr:\n${stderr.slice(-2000)}`)

modelServer.close()
process.exit(failure || exitInfo?.code !== 0 ? 1 : 0)

/** Read the config text out of the runtime module so both cannot drift. */
function extractConfig() {
  const src = path.join(here, '..', '..', 'runtime', 'cordis-config.ts')
  const text = readFileSync(src, 'utf-8')
  const m = text.match(/const HALO_CORDIS_CONFIG = `([\s\S]*?)`\n/)
  if (!m) throw new Error('could not extract HALO_CORDIS_CONFIG from cordis-config.ts')
  return m[1]
}
