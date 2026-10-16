import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import WebSocket from 'ws'
import readline from 'node:readline'
import { PROJECT_ROOT, apiOk, clusterStart, clusterStop, sleep } from './_lib.mjs'

const { values } = parseArgs({ options: {
  engine: { type: 'string' }, model: { type: 'string' }, 'api-type': { type: 'string' },
  'env-file': { type: 'string' }, 'base-port': { type: 'string', default: '3910' },
  'timeout-ms': { type: 'string', default: '720000' }, output: { type: 'string' },
} })
dotenv.config({ path: path.resolve(values['env-file'] ?? path.join(PROJECT_ROOT, '.env.local')), quiet: true })
if (values.engine) process.env.HALO_TEST_SDK_ENGINE = values.engine
if (values.model) process.env.HALO_TEST_MODEL_ID = values.model
if (values['api-type']) process.env.HALO_TEST_API_TYPE = values['api-type']
const engine = process.env.HALO_TEST_SDK_ENGINE || 'anthropic'
const model = process.env.HALO_TEST_MODEL_ID || process.env.HALO_TEST_MODEL
assert(['anthropic', 'halo', 'codex', 'dsh'].includes(engine), 'Unknown engine')
assert(model, 'Configure HALO_TEST_MODEL or pass --model')
assert(process.env.HALO_TEST_API_KEY || process.env.HALO_TEST_MODEL_API_KEY || process.env.HALO_TEST_SIGNED_IN_SOURCE || process.env.HALO_TEST_OAUTH_SOURCE,
  'Configure a real model credential before running this suite')
const timeoutMs = Number(values['timeout-ms'])
const basePort = Number(values['base-port'])
assert(Number.isFinite(timeoutMs) && timeoutMs >= 60000, 'timeout-ms must be at least 60000')
assert(Number.isInteger(basePort) && basePort > 1024 && basePort < 65534, 'Invalid base-port')

const secrets = Object.entries(process.env).filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key)).map(([, value]) => value).filter(Boolean)
function collectSourceSecrets(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /^(?:accessToken|refreshToken|apiKey|idToken|token|authorization)$/i.test(key) && item) secrets.push(item)
    else if (item && typeof item === 'object') collectSourceSecrets(item)
  }
}
for (const name of ['HALO_TEST_SIGNED_IN_SOURCE', 'HALO_TEST_OAUTH_SOURCE']) {
  if (!process.env[name]) continue
  const source = JSON.parse(process.env[name])
  collectSourceSecrets(source)
  if (name === 'HALO_TEST_SIGNED_IN_SOURCE' || !process.env.HALO_TEST_SIGNED_IN_SOURCE) {
    assert(source.model === undefined || source.model === model,
      'The signed-in source model must match the requested test model; implicit substitution is not allowed')
  }
}
const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value))
const clusterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-live-turn-'))
const fixtureDir = path.join(clusterDir, 'review-fixture')
const output = path.resolve(values.output ?? path.join(os.tmpdir(), `halo-live-turn-${crypto.randomUUID()}.json`))
const report = { engine, model, startedAt: new Date().toISOString(), passed: false, checks: {}, counts: {} }
let node
let socket
let cleaning
let spaceId
let conversationId
let lastTranscript
const events = []
const notices = new Map()
const tokenPattern = /REVIEW_(bounds|empty|permissions)_[a-f0-9-]{36}/g
const roles = ['bounds', 'empty', 'permissions']

function cleanup() {
  cleaning ??= (async () => {
    socket?.terminate()
    if (fs.existsSync(path.join(clusterDir, 'nodes.json'))) clusterStop(clusterDir)
    if (node?.pid && process.platform !== 'win32') {
      const alive = () => { try { process.kill(-node.pid, 0); return true } catch { return false } }
      const deadline = Date.now() + 5000
      while (alive() && Date.now() < deadline) await sleep(100)
      if (alive()) {
        // The launcher creates a detached process group owned by this test.
        try { process.kill(-node.pid, 'SIGKILL') } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    }
    fs.rmSync(clusterDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })()
  return cleaning
}
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })

async function observe(conversationId) {
  socket = new WebSocket(`${node.wsUrl}/ws`)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket authentication timed out')), 15000)
    socket.once('error', error => { clearTimeout(timer); reject(error) })
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', payload: { token: node.token } })))
    socket.on('message', raw => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame.type === 'auth:failed') { clearTimeout(timer); reject(new Error('WebSocket authentication failed')); return }
      if (frame.type === 'auth:success') {
        socket.send(JSON.stringify({ type: 'subscribe', payload: { conversationId } }))
        clearTimeout(timer)
        resolve()
        return
      }
      if (frame.type !== 'event' || frame.data?.conversationId !== conversationId) return
      if (!['agent:turn-start', 'agent:complete', 'agent:tool-call', 'agent:error', 'agent:message'].includes(frame.channel)) return
      if (frame.channel === 'agent:message' && frame.data.isComplete !== true) return
      const data = frame.data
      if (events.length >= 10000) return
      events.push({ at: Date.now(), channel: frame.channel, name: data.name,
        input: frame.channel === 'agent:tool-call' ? JSON.stringify(data.input ?? {}) : undefined,
        error: frame.channel === 'agent:error' ? redact(data.error ?? 'unknown agent error') : undefined,
        tokens: frame.channel === 'agent:message' ? [...String(data.content ?? '').matchAll(tokenPattern)].map(match => match[0]) : undefined,
        content: frame.channel === 'agent:message' ? redact(String(data.content ?? '')).slice(0, 4000) : undefined,
        cost: typeof data.tokenUsage?.totalCostUsd === 'number' ? data.tokenUsage.totalCostUsd : undefined })
    })
  })
}

async function openReviewTools() {
  const scope = { spaceId, conversationId }
  const deadline = Date.now() + 30000
  let statuses = []
  while (Date.now() < deadline) {
    statuses = await apiOk(node, 'POST', '/api/agent/toolsets/list', scope)
    if (Array.isArray(statuses) && statuses.some(toolset => toolset.id === 'halo-team')) break
    await sleep(500)
  }
  report.toolsetsBefore = statuses.map(toolset => ({ id: toolset.id, open: toolset.open }))
  assert(statuses.some(toolset => toolset.id === 'halo-team'), 'The team collaboration toolset was not registered')
  await apiOk(node, 'POST', '/api/agent/toolsets/open', { ...scope, toolsetId: 'halo-team' })
  statuses = await apiOk(node, 'POST', '/api/agent/toolsets/list', scope)
  report.toolsetsAfter = statuses.map(toolset => ({ id: toolset.id, open: toolset.open }))
  assert(statuses.some(toolset => toolset.id === 'halo-team' && toolset.open), 'The team collaboration toolset did not open')
}

async function diagnosticRead(apiPath) {
  try {
    const response = await fetch(`${node.baseUrl}${apiPath}`, {
      headers: { Authorization: `Bearer ${node.token}` }, signal: AbortSignal.timeout(4000),
    })
    const value = await response.json()
    return value.success === false ? { diagnosticError: redact(value.error ?? 'request failed') } : value.data ?? value
  } catch (error) { return { diagnosticError: redact(error.message ?? error) } }
}

async function collectDiagnostics() {
  report.counts = {
    ...report.counts,
    notices: notices.size,
    reports: [...notices.values()].filter(notice => notice.kind === 'message' && notice.tokens.length).length,
    coordinatorTurns: events.filter(event => event.channel === 'agent:complete').length,
    toolCalls: events.filter(event => event.channel === 'agent:tool-call').length,
    events: Object.fromEntries([...new Set(events.map(event => event.channel))].map(channel =>
      [channel, events.filter(event => event.channel === channel).length])),
  }
  report.toolNames = [...new Set(events.filter(event => event.channel === 'agent:tool-call').map(event => event.name))]
    .slice(0, 80).map(name => redact(name).slice(0, 160))
  if (node && conversationId && spaceId) {
    const [conversation, session] = await Promise.all([
      diagnosticRead(`/api/spaces/${spaceId}/conversations/${conversationId}`),
      diagnosticRead(`/api/agent/session/${conversationId}`),
    ])
    if (Array.isArray(conversation.messages)) lastTranscript = conversation
    report.session = {
      active: session.isActive, pendingQuestion: !!session.pendingQuestion,
      thoughtCount: Array.isArray(session.thoughts) ? session.thoughts.length : undefined,
      toolNames: [...new Set((session.thoughts ?? []).filter(thought => thought.type === 'tool_use').map(thought => thought.toolName))]
        .slice(0, 80).map(name => redact(name).slice(0, 160)),
      retryPending: !!session.apiRetry,
      ...(session.diagnosticError ? { diagnosticError: session.diagnosticError } : {}),
    }
  }
  const finals = events.filter(event => event.channel === 'agent:message')
  report.finalAssistant = finals[0]?.content ?? redact(
    lastTranscript?.messages?.filter(message => message.role === 'assistant').at(-1)?.content ?? ''
  ).slice(0, 4000)
  report.transcriptCounts = Object.fromEntries(['user', 'assistant', 'system'].map(role =>
    [role, (lastTranscript?.messages ?? []).filter(message => message.role === role).length]))
  report.sessionLog = []
  if (node?.logFile && conversationId && fs.existsSync(node.logFile)) {
    const lines = readline.createInterface({ input: fs.createReadStream(node.logFile), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.includes(conversationId)) continue
      if (/payload|prompt|stderr|authorization|bearer|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|headers|input:|content:/i.test(line)) continue
      if (!/session|consumer|turn[_ -]|V2|stream|delivered|buffered|lease|model=|error|failed|closed|aborted/i.test(line)) continue
      report.sessionLog.push(redact(line).slice(0, 600))
      if (report.sessionLog.length > 80) report.sessionLog.shift()
    }
  }
}

function prepareFixture() {
  fs.mkdirSync(fixtureDir, { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, 'subject.mjs'), [
    'export const last = values => values[values.length]',
    'export const average = values => values.reduce((sum, value) => sum + value, 0) / values.length',
    'export const canEdit = role => role !== "guest"',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(fixtureDir, 'make-report-token.mjs'), [
    "import { randomUUID } from 'node:crypto'",
    "const role = process.argv[2]",
    "if (!['bounds', 'empty', 'permissions'].includes(role)) throw new Error('Unknown review role')",
    "console.log(`REVIEW_${role}_${randomUUID()}`)",
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(fixtureDir, 'coordinator-check.mjs'), [
    "import fs from 'node:fs'",
    "import { setTimeout } from 'node:timers/promises'",
    "import { last, average, canEdit } from './subject.mjs'",
    "const step = Number(process.argv[2])",
    "if (!Number.isInteger(step) || step < 1 || step > 12) throw new Error('Invalid step')",
    "const receipts = process.argv.slice(3).join(' ')",
    "const write = phase => fs.appendFileSync(new URL('./steps.jsonl', import.meta.url), JSON.stringify({ phase, step, at: Date.now(), receipts }) + '\\n')",
    "write('start')",
    'await setTimeout(8000)',
    "console.log(JSON.stringify({ step, last: last([step, step + 1]), emptyAverageIsFinite: Number.isFinite(average([])), unknownCanEdit: canEdit(null), receipts }))",
    "write('end')",
    '',
  ].join('\n'))
}

try {
  prepareFixture()
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', () => reject(new Error('The selected test port is already in use')))
    probe.listen(basePort + 1, '127.0.0.1', () => probe.close(resolve))
  })
  node = clusterStart({ nodes: 1, basePort, fresh: false, clusterDir, quiet: true }).nodes[0]
  assert(node.ready, 'Isolated Halo node did not start')
  secrets.push(node.token)
  const availability = await apiOk(node, 'GET', '/api/agent/engine-availability')
  assert.equal(availability.activeEngine, engine, 'Requested engine did not load; fallback is not a passing run')
  const space = await apiOk(node, 'POST', '/api/spaces', { name: 'Live delivery review', icon: '🧪', customPath: fixtureDir })
  const conversation = await apiOk(node, 'POST', `/api/spaces/${space.id}/conversations`, { title: 'Concurrent three-member review' })
  spaceId = space.id
  conversationId = conversation.id
  await openReviewTools()
  await observe(conversation.id)
  const prompt = [
    'Run this bounded live collaboration regression as a real code review. All work is authorized; ask no questions and edit no code.',
    'Use collab_start to create exactly three members named bounds, empty, and permissions. You are the space coordinator.',
    `The shared review fixture is ${path.join(fixtureDir, 'subject.mjs')}.`,
    'Give each member one narrow responsibility: bounds reviews last(); empty reviews average([]); permissions reviews canEdit(null).',
    'Dispatch all three with team_send. Each instruction must tell the member to read the fixture, run',
    `node ${JSON.stringify(path.join(fixtureDir, 'make-report-token.mjs'))} THEIR_NAME`,
    'and send exactly one concise finding and its generated REVIEW_name_uuid receipt to coordinator using team_send, then stop.',
    'Do not generate receipt tokens yourself, read member transcripts, or poll the blackboard. Their reports will reach your context while you work.',
    'After dispatch, perform your independent verification by calling your shell tool six separate times, sequentially:',
    `node ${JSON.stringify(path.join(fixtureDir, 'coordinator-check.mjs'))} N "RECEIPTS_ALREADY_RECEIVED"`,
    'with N from 1 through 6. Each command must be its own tool call; do not batch them into one shell command.',
    'The command takes eight seconds to run a simulated slow check. Once a teammate report appears in your context,',
    'include its exact receipt in the very next check command, along with all receipts received earlier. Do not wait for your turn to end.',
    'Continue your own six checks even if all reports arrive early. If a report is still missing after six checks, perform up to six more individual checks.',
    'When all reports have arrived, finish remaining checks, then provide one final review containing all three exact receipt strings and the findings.',
    'Do not call team_complete: this regression needs to observe member-ending notices naturally. Do not send acknowledgments or new tasks back to members.',
    'If only a turn-ending notice arrives after you finished, end quietly without a new report.',
  ].join('\n')
  let sendFailure
  let sendFinished = false
  const sending = apiOk(node, 'POST', '/api/agent/message', { spaceId: space.id, conversationId: conversation.id, message: prompt })
    .then(() => { sendFinished = true }, error => { sendFinished = true; sendFailure = error })
  const deadline = Date.now() + timeoutMs
  let transcript
  let nextProgress = 0
  while (Date.now() < deadline) {
    transcript = await apiOk(node, 'GET', `/api/spaces/${space.id}/conversations/${conversation.id}`)
    lastTranscript = transcript
    for (const message of transcript.messages ?? []) {
      if (message.source !== 'team-message' || notices.has(message.id)) continue
      notices.set(message.id, { at: Date.parse(message.timestamp), kind: message.metadata?.teamTriggerKind,
        tokens: [...message.content.matchAll(tokenPattern)].map(match => match[0]) })
    }
    if (sendFailure) throw sendFailure
    const firstComplete = events.find(event => event.channel === 'agent:complete')
    if (firstComplete && sendFinished) break
    if (Date.now() >= nextProgress) {
      console.log(`Live review running: engine=${engine} model=${model} notices=${notices.size} toolCalls=${events.filter(event => event.channel === 'agent:tool-call').length}`)
      nextProgress = Date.now() + 15000
    }
    await sleep(350)
  }
  assert(sendFinished, 'Coordinator did not finish before the bounded deadline')
  await sending
  const firstComplete = events.find(event => event.channel === 'agent:complete')
  assert(firstComplete, 'No coordinator completion event was observed')
  assert(!events.some(event => event.channel === 'agent:error'), 'Coordinator emitted an agent error')
  const reports = [...notices.values()].filter(notice => notice.kind === 'message' && notice.tokens.length)
  const tokens = [...new Set(reports.flatMap(notice => notice.tokens))]
  assert.equal(tokens.length, 3, 'Expected three independently generated report receipts')
  for (const role of roles) assert(tokens.some(token => token.startsWith(`REVIEW_${role}_`)), `Missing ${role} report`)
  assert(reports.every(notice => notice.at <= firstComplete.at), 'A member report only arrived after the original coordinator turn ended')
  const firstFinal = events.find(event => event.channel === 'agent:message' && event.at <= firstComplete.at)
  assert(firstFinal && tokens.every(token => firstFinal.tokens.includes(token)), 'Original coordinator turn did not incorporate all report receipts')
  const steps = fs.readFileSync(path.join(fixtureDir, 'steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const starts = steps.filter(step => step.phase === 'start')
  assert(starts.length >= 6 && starts.length <= 12, 'Coordinator did not perform the bounded independent checks')
  let checkedBoundaries = 0
  for (const notice of reports) {
    const boundary = steps.find(step => step.phase === 'end' && step.at >= notice.at)
    const nextStep = boundary && starts.find(step => step.at >= boundary.at && step.step > boundary.step)
    if (!nextStep) continue
    assert(notice.tokens.every(token => nextStep.receipts.includes(token)), 'A delivered report was not consumed after the next completed tool call')
    checkedBoundaries++
  }
  assert(checkedBoundaries > 0, 'No report overlapped independent work; the run did not exercise live delivery')
  report.checks = { threeIndependentReports: true, originalTurnIncorporatedAll: true, nextToolBoundary: true }
  await sleep(12000)
  const laterStarts = events.filter(event => event.channel === 'agent:turn-start' && event.at > firstComplete.at)
  assert(laterStarts.length <= 1, `Member notices caused ${laterStarts.length} follow-up turns instead of at most one merged continuation`)
  report.checks.noWakeStorm = true
  const logs = fs.readFileSync(node.logFile, 'utf8').split('\n').filter(line => line.includes(conversation.id))
  assert(logs.some(line => line.includes('Delivered into running turn')), 'No successful live-delivery log for the coordinator')
  assert(!logs.some(line => /route offers no mid-turn|route does not provide mid-turn|live delivery unavailable/.test(line)), 'Coordinator still used an unavailable live-delivery route')
  const completions = events.filter(event => event.channel === 'agent:complete')
  report.counts = { members: 3, notices: notices.size, reports: reports.length, independentChecks: starts.length,
    verifiedBoundaries: checkedBoundaries, coordinatorTurns: completions.length, turnsAfterFinal: laterStarts.length,
    coordinatorCostUsd: completions.every(event => typeof event.cost === 'number')
      ? completions.reduce((sum, event) => sum + event.cost, 0) : null }
  report.passed = true
  console.log(`PASS live-turn delivery: engine=${engine} model=${model} reports=3 nextBoundary=${checkedBoundaries} laterTurns=${laterStarts.length}`)
} catch (error) {
  report.error = redact(error.message ?? error)
  report.agentErrors = events.filter(event => event.error).slice(-5).map(event => event.error)
  console.error(`FAIL live-turn delivery: ${report.error}`)
  process.exitCode = 1
} finally {
  try { await collectDiagnostics() } catch (error) { report.diagnosticError = redact(error.message ?? error) }
  report.finishedAt = new Date().toISOString()
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  await cleanup()
  console.log(`Sanitized evidence: ${output}`)
}
