import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/
const workflowPattern = /^[A-Za-z0-9_.-]+\.ya?ml$/
const requestPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function localSetting(name) {
  const result = spawnSync('git', ['config', '--local', '--get', name], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function githubEnvironment() {
  const environment = { ...process.env }
  delete environment.GH_DEBUG
  delete environment.GH_FORCE_TTY
  const explicit = Object.hasOwn(environment, 'HALO_ACCEPTANCE_CI_PROXY')
  const proxy = explicit ? environment.HALO_ACCEPTANCE_CI_PROXY : localSetting('halo.acceptanceProxy')
  const proxyConfiguration = proxy === undefined ? 'inherited' : explicit ? 'environment-override' : 'git-override'
  if (proxy !== undefined) {
    if (/[\r\n\0]/.test(proxy)) throw new Error('CI proxy configuration contains an invalid control character.')
    if (proxy) {
      if (!/^https?:\/\/[^/?#\s\\]+\/?$/i.test(proxy)) throw new Error('CI proxy configuration must be a complete HTTP(S) URL.')
      let parsed
      try { parsed = new URL(proxy) } catch { throw new Error('CI proxy configuration must be a complete HTTP(S) URL.') }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error('CI proxy configuration must name an HTTP(S) proxy endpoint.')
    }
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      if (proxy) environment[name] = proxy
      else delete environment[name]
    }
    environment.NO_PROXY = ''
    environment.no_proxy = ''
  }
  const account = localSetting('halo.acceptanceAccount')
  if (account && !environment.GH_TOKEN && !environment.GITHUB_TOKEN) {
    if (!/^[A-Za-z0-9-]+$/.test(account)) throw new Error('Configured GitHub account name is invalid.')
    const credential = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account], { encoding: 'utf8', env: environment, timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] })
    if (credential.error || credential.status !== 0 || !credential.stdout.trim()) throw new Error('The configured GitHub account is not authenticated.')
    environment.GH_TOKEN = credential.stdout.trim()
  }
  return { environment, proxyConfiguration }
}

function classify(result, proxyConfiguration) {
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  const response = stdout.match(/^HTTP\/\S+\s+(\d{3})\b/)
  const reported = response ?? stderr.match(/\bHTTP ([1-5]\d{2})\b/)
  const httpStatus = reported ? Number(reported[1]) : null
  let category = 'unknown', errorCode = null
  if (result.error?.code === 'ETIMEDOUT' || /timed? out|timeout/i.test(stderr)) { category = 'timeout'; errorCode = 'ETIMEDOUT' }
  else if (result.error) { category = 'process-error'; errorCode = ['ENOENT', 'EACCES', 'ENOBUFS'].includes(result.error.code) ? result.error.code : 'PROCESS_ERROR' }
  else if (/x509:|tls:|tls handshake|certificate|SSL/i.test(stderr)) { category = 'tls'; errorCode = 'TLS_ERROR' }
  else if (/\b(?:unexpected\s+)?EOF\b/i.test(stderr)) { category = 'eof'; errorCode = 'EOF' }
  else if (/no such host|ENOTFOUND|EAI_AGAIN|name resolution/i.test(stderr)) { category = 'dns'; errorCode = 'DNS_ERROR' }
  else if (/connection (?:reset|refused|closed)|ECONNRESET|ECONNREFUSED|broken pipe/i.test(stderr)) { category = 'connection'; errorCode = 'CONNECTION_ERROR' }
  else if (httpStatus) { category = 'http'; errorCode = httpStatus >= 400 ? `HTTP_${httpStatus}` : null }
  else if (result.status !== 0) errorCode = 'TRANSPORT_ERROR'
  const separator = stdout.match(/\r?\n\r?\n/)
  return {
    transport: { category, exitCode: Number.isInteger(result.status) ? result.status : null, errorCode, httpStatus, responseReceived: Boolean(response), signal: /^SIG[A-Z0-9]+$/.test(result.signal ?? '') ? result.signal : null, proxyConfiguration },
    body: response && separator ? stdout.slice(separator.index + separator[0].length) : stdout,
  }
}

function githubRequest(connection, method, endpoint, body, timeoutMs) {
  const args = ['api', '--hostname', 'github.com', '--method', method, '--include', endpoint]
  if (body !== undefined) args.push('--input', '-')
  const result = spawnSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', env: connection.environment, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
  return classify(result, connection.proxyConfiguration)
}

function writeReceipt(filename, record, previous) {
  if (previous !== undefined && fs.readFileSync(filename, 'utf8') !== previous) throw new Error('The dispatch receipt changed during lookup; it was not overwritten.')
  const temporary = `${filename}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, filename)
}

function readReceipt(filename) {
  const info = fs.lstatSync(filename)
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('The receipt must be a regular JSON file no larger than 1 MiB.')
  const serialized = fs.readFileSync(filename, 'utf8')
  let record
  try { record = JSON.parse(serialized) } catch { throw new Error('The dispatch receipt is not valid JSON.') }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 || !requestPattern.test(record.requestId ?? '') || !repositoryPattern.test(record.repository ?? '') || !workflowPattern.test(record.workflow ?? '') || typeof record.requestedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(record.requestedAt) || !Number.isFinite(Date.parse(record.requestedAt)) || record.request?.inputs?.request_id !== record.requestId) throw new Error('The dispatch receipt does not contain a supported request identity.')
  return { record, serialized }
}

function lookupRuns(record, connection) {
  const started = Date.now()
  const from = new Date(Date.parse(record.requestedAt) - 5 * 60000).toISOString()
  const until = new Date(Math.max(started, Date.parse(record.requestedAt))).toISOString()
  const deadline = started + 60000
  const matches = new Map(), seen = new Set(), transports = []
  let complete = false, pages = 0, total = 0, failure
  for (let page = 1; page <= 10; page++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) { failure = 'lookup-deadline'; break }
    const query = new URLSearchParams({ event: 'workflow_dispatch', created: `${from}..${until}`, per_page: '100', page: String(page), exclude_pull_requests: 'true' })
    const response = githubRequest(connection, 'GET', `repos/${record.repository}/actions/workflows/${record.workflow}/runs?${query}`, undefined, Math.min(15000, remaining))
    pages++
    transports.push(response.transport)
    if (response.transport.httpStatus !== 200 || !response.transport.responseReceived || response.transport.exitCode !== 0) { failure = 'transport-error'; break }
    let data
    try { data = JSON.parse(response.body) } catch { failure = 'invalid-response'; break }
    if (!data || !Array.isArray(data.workflow_runs) || data.workflow_runs.length > 100 || !Number.isSafeInteger(data.total_count) || data.total_count < data.workflow_runs.length) { failure = 'invalid-response'; break }
    total = Math.max(total, data.total_count)
    for (const run of data.workflow_runs) {
      if (!run || !Number.isSafeInteger(run.id) || run.id < 1 || typeof run.event !== 'string' || typeof run.path !== 'string' || typeof run.display_title !== 'string' || !Number.isFinite(Date.parse(run.created_at))) { failure = 'invalid-response'; break }
      seen.add(run.id)
      if (run.event !== 'workflow_dispatch' || run.path !== `.github/workflows/${record.workflow}` || typeof run.display_title !== 'string' || !run.display_title.startsWith(`Acceptance ${record.requestId} · `)) continue
      const created = Date.parse(run.created_at)
      if (!Number.isFinite(created) || created < Date.parse(from) || created > Date.parse(until)) continue
      const safeState = value => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : null
      matches.set(run.id, { id: run.id, attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : null, status: safeState(run.status), conclusion: safeState(run.conclusion), createdAt: new Date(created).toISOString(), url: `https://github.com/${record.repository}/actions/runs/${run.id}` })
    }
    if (failure) break
    if (seen.size >= total) { complete = true; break }
    if (!data.workflow_runs.length) { failure = 'pagination-incomplete'; break }
  }
  if (!complete && !failure) failure = 'page-limit'
  const runs = [...matches.values()].sort((left, right) => left.id - right.id)
  return { version: 1, requestId: record.requestId, checkedAt: new Date().toISOString(), matchCount: runs.length, complete, outcome: !complete ? 'incomplete' : runs.length === 0 ? 'no-match-yet' : runs.length === 1 ? 'one-match' : 'multiple-matches', runs, search: { from, until, pages, maximumPages: 10, maximumMilliseconds: 60000, ...(failure ? { failure } : {}) }, transports }
}

function main() {
  const { values } = parseArgs({ options: {
    repository: { type: 'string' }, workflow: { type: 'string' }, ref: { type: 'string' },
    'source-ref': { type: 'string' }, 'source-repository': { type: 'string' }, profile: { type: 'string' },
    module: { type: 'string', multiple: true }, case: { type: 'string', multiple: true },
    full: { type: 'boolean', default: false }, execute: { type: 'boolean', default: false },
    receipt: { type: 'string' }, reconcile: { type: 'boolean', default: false },
  } })
  if (values.receipt) {
    if (values.execute || values.repository || values.workflow || values.ref || values['source-ref'] || values['source-repository'] || values.profile || values.module || values.case || values.full) throw new Error('Receipt lookup cannot be combined with dispatch options.')
    const filename = path.resolve(values.receipt)
    const { record, serialized } = readReceipt(filename)
    const result = lookupRuns(record, githubEnvironment())
    if (values.reconcile) {
      record.reconciliation = result
      writeReceipt(filename, record, serialized)
    }
    console.log(JSON.stringify(result, null, 2))
    if (!result.complete) process.exitCode = 2
    return
  }
  if (values.reconcile) throw new Error('--reconcile requires --receipt and never resubmits a request.')
  values.repository ??= process.env.HALO_ACCEPTANCE_CI_REPOSITORY || localSetting('halo.acceptanceRepository')
  values.workflow ??= 'acceptance.yml'
  values.ref ??= 'main'
  values.profile ??= 'fast'
  if (!repositoryPattern.test(values.repository ?? '')) throw new Error('--repository must name the controller owner/repository.')
  if (!workflowPattern.test(values.workflow)) throw new Error('--workflow must be a workflow filename.')
  if (!['fast', 'regression'].includes(values.profile)) throw new Error('--profile must be fast or regression.')
  if (!values.ref || /[\r\n\0]/.test(values.ref)) throw new Error('--ref must be a nonempty single-line controller ref.')
  if (values['source-ref'] !== undefined && (!values['source-ref'] || /[\r\n\0]/.test(values['source-ref']))) throw new Error('--source-ref must be a nonempty single-line source ref.')
  if (values['source-repository'] && !repositoryPattern.test(values['source-repository'])) throw new Error('--source-repository must be owner/repository.')
  for (const value of [...values.module ?? [], ...values.case ?? []]) if (!/^[a-z][a-z0-9.-]*$/.test(value)) throw new Error('Module and case ids must use catalog identifiers.')
  const requestId = randomUUID()
  const inputs = { profile: values.profile, full: String(values.full), request_id: requestId }
  if (values['source-ref']) inputs.source_ref = values['source-ref']
  if (values.module?.length) inputs.modules = [...new Set(values.module)].sort().join(',')
  if (values.case?.length) inputs.cases = [...new Set(values.case)].sort().join(',')
  if (values['source-repository']) inputs.source_repository = values['source-repository']
  const endpoint = `repos/${values.repository}/actions/workflows/${values.workflow}/dispatches`
  const request = { ref: values.ref, inputs }
  if (!values.execute) {
    console.log(JSON.stringify({ method: 'POST', endpoint, body: request }, null, 2))
    console.log('Preview only. Add --execute after authorizing this workflow dispatch.')
    return
  }
  const connection = githubEnvironment()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const receipt = path.join(root, 'tests/acceptance/output/dispatches', `${requestId}.json`)
  fs.mkdirSync(path.dirname(receipt), { recursive: true })
  const record = { version: 1, requestId, repository: values.repository, workflow: values.workflow, requestedAt: new Date().toISOString(), request, status: 'pending' }
  fs.writeFileSync(receipt, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ requestId, receipt }))
  const { transport } = githubRequest(connection, 'POST', endpoint, request, 30000)
  record.transport = transport
  record.status = transport.responseReceived && transport.httpStatus >= 200 && transport.httpStatus < 300 ? 'accepted'
    : transport.responseReceived && transport.httpStatus >= 400 && transport.httpStatus < 500 && transport.httpStatus !== 408 ? 'rejected' : 'unknown'
  writeReceipt(receipt, record)
  if (record.status !== 'accepted') throw new Error(`Dispatch ${record.status} (${transport.category}); query the saved receipt before deciding whether to send a new request.`)
  console.log('Workflow dispatch accepted. Acceptance results are available when its run completes; dispatch itself is not a passing test.')
}

try { main() }
catch (error) { console.error(`[Acceptance CI] ${error.message}`); process.exitCode = 1 }
