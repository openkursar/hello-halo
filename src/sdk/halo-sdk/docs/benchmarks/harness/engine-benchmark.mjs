import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const execute = promisify(execFile)
const script = fileURLToPath(import.meta.url)
const project = resolve(dirname(script), '../..')
const now = () => Number(process.hrtime.bigint()) / 1e6
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const model = 'claude-sonnet-4-5'
const systemPrompt = 'Execute the requested benchmark task. Return the supplied completion marker.'
const marker = (session, turn) => `BENCH_SESSION_${session}_TURN_${turn}`
const quantile = (values, fraction) => {
  assert(values.length > 0 && values.every(Number.isFinite))
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  return sorted[Math.floor(position)] + (sorted[Math.ceil(position)] - sorted[Math.floor(position)]) * (position % 1)
}
const distribution = values => ({ median: quantile(values, 0.5), p95: quantile(values, 0.95), min: Math.min(...values), max: Math.max(...values) })

function isolatedEnv(directory, baseUrl = 'http://127.0.0.1:9') {
  return {
    PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, XDG_CACHE_HOME: directory,
    CLAUDE_CONFIG_DIR: join(directory, 'config'),
    ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'benchmark-placeholder',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    AGENT_SDK_LOG_LEVEL: 'silent',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1',
  }
}

async function ccSession(config, index) {
  const cwd = join(config.directory, `session-${index}`)
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{"disableAllHooks":true}', '--model', model, '--thinking', 'disabled',
    '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
    '--tools', config.workload === 'tools' ? 'Read,Write' : '', '--system-prompt', systemPrompt]
  if (!config.persist) args.push('--no-session-persistence')
  const child = spawn(config.cc, args, { cwd, env: isolatedEnv(config.directory, config.baseUrl), stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  const events = []
  let notify
  let failure
  let stderr = ''
  let closing = false
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384) })
  const fail = error => { failure = error; notify?.(); notify = undefined }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.on('exit', (code, signal) => {
    if (!closing) fail(new Error(`CC session ${index} exited (${code}, ${signal}): ${stderr}`))
  })
  lines.on('line', line => {
    try { events.push(JSON.parse(line)); notify?.(); notify = undefined }
    catch (error) { fail(new Error(`CC session ${index} emitted invalid JSON`, { cause: error })) }
  })
  async function next() {
    while (!events.length) {
      if (failure) throw failure
      await new Promise(resolve => { notify = resolve })
    }
    return events.shift()
  }
  const write = message => child.stdin.write(JSON.stringify(message) + '\n')
  write({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] } })
  for (;;) {
    const event = await next()
    if (event.type === 'control_response' && event.response?.request_id === 'initialize') {
      assert.equal(event.response.subtype, 'success')
      break
    }
  }
  return {
    async send(prompt) { write({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() }) },
    async *stream() {
      for (;;) {
        const event = await next()
        assert.notEqual(event.type, 'control_request', 'Unexpected CC permission or callback request')
        yield event
        if (event.type === 'result') break
      }
    },
    async dispose() {
      closing = true
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000)
      try {
        const [code, signal] = await exit
        assert.equal(code, 0, `CC did not close cleanly: ${signal}; ${stderr}`)
      } finally { clearTimeout(timer); lines.close() }
    },
  }
}

async function actor() {
  const [config] = await once(process, 'message')
  process.on('disconnect', () => { console.error('Benchmark supervisor disconnected'); process.exit(2) })
  process.send({ type: 'baseline-ready' })
  await once(process, 'message')
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  const engineStartAt = now()
  let runtime
  let sdk
  const sessions = []
  try {
    if (config.engine !== 'cc') {
      sdk = await import(pathToFileURL(join(config.snapshot, 'dist', config.engine === 'halo-worker' ? 'worker/index.js' : 'index.js')).href)
      if (config.engine === 'halo-worker') { runtime = sdk.createWorkerRuntime(); await runtime.initialize() }
    }
    const moduleReadyAt = now()
    await Promise.all(Array.from({ length: config.concurrency }, async (_, index) => {
      if (config.engine === 'cc') sessions[index] = await ccSession(config, index)
      else {
        const options = {
          cwd: join(config.directory, `session-${index}`), env: isolatedEnv(config.directory, config.baseUrl),
          model, apiKey: 'benchmark-placeholder', anthropicBaseUrl: config.baseUrl,
          tools: config.workload === 'tools' ? ['Read', 'Write'] : [], settingSources: [], systemPrompt,
          permissionMode: 'bypassPermissions', thinking: { type: 'disabled' },
          includePartialMessages: true,
          persistSession: config.persist, turnEndChecks: { openWork: false, completion: false },
        }
        sessions[index] = runtime ? await runtime.createSession(options, { group: 'benchmark' }) : await sdk.createSession(options)
      }
    }))
    const sessionsReadyAt = now()
    const batches = []
    for (let turn = 0; turn < config.turns; turn++) {
      const batchStartAt = now()
      const results = await Promise.all(sessions.map(async (session, index) => {
        const expected = marker(index, turn)
        const prompt = `${expected}\n${config.workload === 'tools' ? 'Read seed-' + turn + '.txt and write its content into output-' + turn + '.txt.' : 'Return the completion marker.'}\n${'x'.repeat(config.inputChars)}`
        const sentAt = now()
        await session.send(prompt)
        let result
        let firstTextAt
        let text = ''
        for await (const event of session.stream()) {
          if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
            firstTextAt ??= now()
            text += event.event.delta.text
          }
          if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) if (block.type === 'text') { firstTextAt ??= now(); text += block.text }
          }
          if (event.type === 'result') { assert(!result, 'Duplicate terminal result'); result = event }
        }
        assert(result && !result.is_error, `Session ${index}, turn ${turn} failed: ${JSON.stringify(result)}`)
        assert(text.includes(expected) || result.result?.includes(expected), `Missing completion marker: ${expected}`)
        return { index, turn, sentAt, firstTextAt, completedAt: now() }
      }))
      batches.push({ turn, batchStartAt, completedAt: now(), results })
    }
    const workCompletedAt = now()
    loop.disable()
    process.send({ type: 'work-done', engineStartAt, moduleReadyAt, sessionsReadyAt, workCompletedAt, batches,
      diagnostics: runtime?.diagnostics(), hostLoopP99Ms: loop.percentile(99) / 1e6, hostLoopMaxMs: loop.max / 1e6,
      ownCpu: process.cpuUsage(), ownMemory: process.memoryUsage() })
    await once(process, 'message')
    await delay(config.idleMs)
    process.send({ type: 'idle-done' })
    await once(process, 'message')
  } finally {
    loop.disable()
    await Promise.all(sessions.map(async session => {
      if (session.dispose) await session.dispose()
      else { session.close(); await session.flush() }
    }))
    await runtime?.close()
  }
  process.send({ type: 'closed' })
  process.removeAllListeners('disconnect')
  process.disconnect()
}

async function snapshotSdk(directory) {
  const source = join(project, 'src/sdk/halo-sdk')
  const snapshot = join(directory, 'sdk')
  const { stdout } = await execute('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: source, maxBuffer: 16 * 1024 * 1024 })
  const digest = createHash('sha256')
  const manifest = []
  for (const name of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    if (/^(node_modules|dist|validation\/results|swe-bench-eval)(\/|$)/.test(name) || name.split('/').some(part => part.startsWith('.env'))) continue
    let stat
    try { stat = await fs.lstat(join(source, name)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!stat.isFile()) continue
    const content = await fs.readFile(join(source, name))
    digest.update(name).update('\0').update(content)
    manifest.push({ name, sha256: hash(content) })
    await fs.mkdir(dirname(join(snapshot, name)), { recursive: true })
    await fs.writeFile(join(snapshot, name), content)
  }
  await fs.symlink(join(source, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
  for (const args of [[join(source, 'node_modules/typescript/bin/tsc'), '-p', join(snapshot, 'tsconfig.json')], [join(snapshot, 'scripts/build-worker.mjs')]]) {
    const result = await execute(process.execPath, args, { cwd: snapshot, timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
    await fs.appendFile(join(directory, 'build.log'), result.stdout + result.stderr)
  }
  const git = async args => (await execute('git', args, { cwd: source })).stdout.trim()
  return { snapshot, sourceSha256: digest.digest('hex'), manifest, gitHead: await git(['rev-parse', 'HEAD']),
    dirty: await git(['status', '--short']), workerSha256: hash(await fs.readFile(join(snapshot, 'dist/worker/entry.js'))),
    version: JSON.parse(await fs.readFile(join(snapshot, 'package.json'), 'utf8')).version }
}

async function startPeer(config) {
  const requests = []
  const errors = []
  const steps = new Map()
  const server = createServer(async (request, response) => {
    try {
      const receivedAt = now()
      let body = ''
      for await (const chunk of request) { body += chunk; assert(body.length < 8 * 1024 * 1024, 'Oversized model request') }
      const json = body ? JSON.parse(body) : {}
      if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":4096}'); return }
      assert(request.url?.startsWith('/v1/messages'), `Unexpected endpoint ${request.url}`)
      const matches = [...JSON.stringify(json.messages).matchAll(/BENCH_SESSION_(\d+)_TURN_(\d+)/g)]
      assert(matches.length, 'Unattributed model request')
      const [key, sessionText, turnText] = matches.at(-1)
      const session = Number(sessionText)
      const turn = Number(turnText)
      const step = steps.get(key) ?? 0
      steps.set(key, step + 1)
      assert(session < config.concurrency && turn < config.turns)
      assert(step < (config.workload === 'tools' ? 3 : 1), `Unexpected retry or auxiliary request: ${key}/${step}`)
      const row = { session, turn, step, receivedAt, parsedAt: now(), bytes: Buffer.byteLength(body), model: json.model,
        tools: (json.tools ?? []).map(tool => tool.name) }
      requests.push(row)
      const seed = `seed-${config.nonce}-${session}-${turn}`
      let tool
      if (config.workload === 'tools' && step === 0) tool = { name: 'Read', input: { file_path: join(config.directory, `session-${session}`, `seed-${turn}.txt`) } }
      if (config.workload === 'tools' && step === 1) {
        assert(JSON.stringify(json.messages.at(-1)).includes(seed), 'Read result did not contain the expected seed')
        tool = { name: 'Write', input: { file_path: join(config.directory, `session-${session}`, `output-${turn}.txt`), content: seed } }
      }
      if (config.workload === 'tools' && step === 2) {
        assert.equal(await fs.readFile(join(config.directory, `session-${session}`, `output-${turn}.txt`), 'utf8'), seed)
        assert(!JSON.stringify(json.messages.at(-1)).includes('"is_error":true'), 'Write tool reported an error')
      }
      if (tool) assert(row.tools.includes(tool.name), `Missing required ${tool.name} tool`)
      await delay(config.responseDelayMs)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = data => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
      send({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4096, output_tokens: 0 } } })
      send({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `toolu_${randomUUID()}`, name: tool.name, input: {} } : { type: 'text', text: '' } })
      if (tool) send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })
      else {
        const output = `${key} ${'ok '.repeat(680)}`
        for (let start = 0; start < output.length; start += 128) {
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: output.slice(start, start + 128) } })
          await delay(config.chunkDelayMs)
        }
      }
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: tool ? 64 : 512 } })
      send({ type: 'message_stop' })
      response.end()
      row.endedAt = now()
    } catch (error) {
      errors.push({ at: now(), message: error.message, stack: error.stack })
      response.writeHead(500).end(JSON.stringify({ error: { type: 'api_error', message: error.message } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, errors, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function sampleTree(pid, cpuExecutable) {
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  const rows = stdout.trim().split('\n').map(line => {
    const fields = line.trim().split(/\s+/)
    const [pid, parent, rssKiB] = fields.slice(0, 3).map(Number)
    const clock = fields[3].split(':').map(Number)
    assert(clock.length >= 2 && clock.every(Number.isFinite), `Unsupported ps CPU time: ${fields[3]}`)
    const cpuMs = clock.reduce((seconds, part) => seconds * 60 + part, 0) * 1000
    return { pid, parent, rssBytes: rssKiB * 1024, cpuMs, identity: fields.slice(4).join(' ') }
  })
  const pids = new Set([pid])
  for (let size = 0; size !== pids.size;) {
    size = pids.size
    for (const row of rows) if (pids.has(row.parent)) pids.add(row.pid)
  }
  const processes = rows.filter(row => pids.has(row.pid))
  assert(processes.some(row => row.pid === pid), 'Benchmark host disappeared during collection')
  // Hardened CC helpers deny proc_pid_rusage; ps supplies the same CPU accounting for both engines.
  const result = JSON.parse((await execute(cpuExecutable, [String(pid)], { timeout: 5000 })).stdout)
  assert(result.samples.length === 1 && !result.samples[0].error, 'Native host CPU cross-check failed')
  return { at: now(), rssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0), processes,
    nativeHostCpu: result.samples[0] }
}

async function runCase(config, cpuExecutable) {
  const loadBefore = os.loadavg()
  const swapBefore = (await execute('/usr/sbin/sysctl', ['vm.swapusage'])).stdout.trim()
  await fs.mkdir(config.directory, { recursive: true })
  await fs.mkdir(join(config.directory, 'config'), { recursive: true })
  for (let index = 0; index < config.concurrency; index++) {
    await fs.mkdir(join(config.directory, `session-${index}`))
    for (let turn = 0; turn < config.turns; turn++) {
      await fs.writeFile(join(config.directory, `session-${index}`, `seed-${turn}.txt`), `seed-${config.nonce}-${index}-${turn}`)
    }
  }
  const peer = await startPeer(config)
  config.baseUrl = peer.baseUrl
  const child = spawn(process.execPath, [script, '--actor'], {
    cwd: config.directory, env: isolatedEnv(config.directory, peer.baseUrl), detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-128 * 1024) })
  const samples = []
  let sampling
  let interval
  let failure
  let work
  let finished = false
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const fail = error => { failure ??= error; kill() }
  const sample = async label => {
    assert(!peer.errors.length, peer.errors[0]?.stack)
    if (sampling) await sampling
    sampling = sampleTree(child.pid, cpuExecutable)
    try {
      const row = { ...await sampling, label }
      samples.push(row)
      if (row.rssBytes > config.maxRssGiB * 2 ** 30) throw new Error('Benchmark process tree exceeded its RSS budget')
      return row
    } finally { sampling = undefined }
  }
  const deadline = setTimeout(() => fail(new Error('Benchmark case deadline exceeded')), config.timeoutMs)
  child.on('error', fail)
  child.on('message', message => {
    void (async () => {
      if (message.type === 'baseline-ready') {
        await sample('baseline')
        interval = setInterval(() => { if (!sampling) void sample('periodic').catch(fail) }, config.sampleMs)
        child.send({ type: 'go' })
      } else if (message.type === 'work-done') {
        work = message
        clearInterval(interval)
        await sample('work-done')
        child.send({ type: 'idle' })
      } else if (message.type === 'idle-done') {
        await sample('idle-done')
        child.send({ type: 'close' })
      } else if (message.type === 'closed') finished = true
      else throw new Error(`Unknown actor event ${message.type}`)
    })().catch(fail)
  })
  const abort = () => fail(new Error('Benchmark interrupted'))
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  child.send(config)
  let result
  try {
    const exit = await closed
    if (sampling) await sampling
    assert(!failure, failure?.stack)
    assert.equal(exit.code, 0, `Actor failed: ${JSON.stringify(exit)}\n${log}`)
    assert(finished && work, 'Actor did not finish all lifecycle stages')
    assert.deepEqual(peer.errors, [])
    assert.equal(peer.requests.length, config.concurrency * config.turns * (config.workload === 'tools' ? 3 : 1))
    const observed = new Set(samples.flatMap(row => row.processes.map(p => p.pid)))
    for (const pid of observed) {
      let alive = true
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
      assert(!alive, `Benchmark process ${pid} survived shutdown`)
    }
    const first = peer.requests.filter(row => row.turn === 0 && row.step === 0)
    assert.equal(first.length, config.concurrency)
    const baseline = samples.find(row => row.label === 'baseline')
    const complete = samples.find(row => row.label === 'work-done')
    const idle = samples.find(row => row.label === 'idle-done')
    const cpuTotal = row => row.processes.reduce((sum, p) => sum + p.cpuMs, 0)
    const workCpuByIdentity = new Map()
    for (const row of samples) {
      for (const p of row.processes) {
        const key = `${p.pid}:${p.identity}`
        workCpuByIdentity.set(key, Math.max(workCpuByIdentity.get(key) ?? 0, p.cpuMs))
      }
      if (row === complete) break
    }
    const warm = work.batches.slice(1)
    const warmRequests = peer.requests.filter(row => row.turn > 0 && row.step === 0)
    result = { config, passed: true, loadBefore, load: os.loadavg(), swapBefore,
      swapAfter: (await execute('/usr/sbin/sysctl', ['vm.swapusage'])).stdout.trim(), work, requests: peer.requests, samples,
      metrics: {
        moduleReadyMs: work.moduleReadyAt - work.engineStartAt,
        sessionsReadyMs: work.sessionsReadyAt - work.engineStartAt,
        coldRequestMedianMs: quantile(first.map(row => row.receivedAt - work.engineStartAt), 0.5),
        coldRequestAllMs: Math.max(...first.map(row => row.receivedAt)) - work.engineStartAt,
        coldBatchMs: work.batches[0].completedAt - work.engineStartAt,
        warmRequestMedianMs: quantile(warmRequests.map(row => row.receivedAt - work.batches[row.turn].results[row.session].sentAt), 0.5),
        warmBatchMedianMs: quantile(warm.map(row => row.completedAt - row.batchStartAt), 0.5),
        warmTurnsPerSecond: config.concurrency * warm.length / (warm.reduce((sum, row) => sum + row.completedAt - row.batchStartAt, 0) / 1000),
        peakTreeRssMiB: Math.max(...samples.map(row => row.rssBytes)) / 2 ** 20,
        residentTreeRssMiB: idle.rssBytes / 2 ** 20,
        workTreeCpuMs: [...workCpuByIdentity.values()].reduce((sum, value) => sum + value, 0) - cpuTotal(baseline),
        idleCpuPercentOneCore: (cpuTotal(idle) - cpuTotal(complete)) / (idle.at - complete.at) * 100,
        hostLoopP99Ms: work.hostLoopP99Ms, hostLoopMaxMs: work.hostLoopMaxMs,
        workers: work.diagnostics?.workers.length ?? 0, residentProcesses: idle.processes.length,
      } }
  } catch (error) {
    result = { config, passed: false, error: error.stack, log, work, samples, requests: peer.requests, peerErrors: peer.errors }
  } finally {
    clearTimeout(deadline); clearInterval(interval)
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
    kill()
    peer.server.closeAllConnections()
    await new Promise(resolve => peer.server.close(resolve))
  }
  await fs.writeFile(join(config.directory, 'result.json'), JSON.stringify(result, null, 2))
  await fs.writeFile(join(config.directory, 'actor.log'), log)
  return result
}

async function supervisor() {
  assert.equal(process.platform, 'darwin', 'This harness requires the validated macOS CPU collector')
  const { values } = parseArgs({ options: {
    cc: { type: 'string', default: '/usr/local/bin/claude' }, output: { type: 'string' },
    rounds: { type: 'string', default: '5' }, concurrency: { type: 'string', default: '1,8,32,64' },
    engines: { type: 'string', default: 'halo-worker,cc' }, workload: { type: 'string', default: 'text' },
    turns: { type: 'string', default: '5' }, 'input-chars': { type: 'string', default: '8192' },
    'response-delay-ms': { type: 'string', default: '100' }, 'chunk-delay-ms': { type: 'string', default: '5' },
    'idle-ms': { type: 'string', default: '1000' }, 'sample-ms': { type: 'string', default: '100' },
    'max-rss-gib': { type: 'string', default: '14' }, 'timeout-ms': { type: 'string', default: '120000' },
    'no-persist': { type: 'boolean', default: false }, snapshot: { type: 'string' },
  } })
  const positive = name => { const number = Number(values[name]); assert(Number.isSafeInteger(number) && number > 0, `Invalid ${name}`); return number }
  const rounds = positive('rounds')
  assert(rounds <= 10)
  const concurrency = values.concurrency.split(',').map(Number)
  assert(concurrency.every(number => Number.isInteger(number) && number > 0 && number <= 64))
  const engines = values.engines.split(',')
  assert(engines.every(engine => ['halo-worker', 'halo-direct', 'cc'].includes(engine)))
  assert(['text', 'tools'].includes(values.workload))
  const directory = resolve(values.output ?? join(project, '.validation', `engine-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`))
  await fs.mkdir(directory, { recursive: true })
  const manifestPath = join(directory, 'manifest.json')
  const lock = await fs.open(manifestPath, 'wx')
  await lock.close()
  console.log(`Building isolated SDK and CPU collector: ${directory}`)
  const sdk = values.snapshot ? JSON.parse(await fs.readFile(resolve(values.snapshot), 'utf8')).sdk : await snapshotSdk(directory)
  const cpuExecutable = join(directory, 'process-cpu')
  const cpuSource = join(project, 'tests/perf/lib/darwin-process-cpu.c')
  await execute('/usr/bin/clang', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', cpuSource, '-o', cpuExecutable], { timeout: 30000 })
  const probe = JSON.parse((await execute(cpuExecutable, ['--probe'])).stdout)
  assert(probe.samples.length === 3 && probe.samples.every(row => !row.error))
  const cpu = row => BigInt(row.userCpuNs) + BigInt(row.systemCpuNs)
  const busyPercent = Number(cpu(probe.samples[2]) - cpu(probe.samples[1])) / Number(BigInt(probe.samples[2].sampleTimeNs) - BigInt(probe.samples[1].sampleTimeNs)) * 100
  assert(busyPercent > 20 && busyPercent < 150, 'CPU collector positive control failed')
  const cc = await fs.realpath(values.cc)
  const ccVersion = (await execute(cc, ['--version'], { env: isolatedEnv(directory), timeout: 10000 })).stdout.trim()
  const manifest = { startedAt: new Date().toISOString(), settings: values, sdk, cc: { path: cc, version: ccVersion, sha256: hash(await fs.readFile(cc)) },
    harnessSha256: hash(await fs.readFile(script)), cpuCollectorSha256: hash(await fs.readFile(cpuSource)), cpuProbe: probe,
    machine: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version, cpu: os.cpus()[0].model, cores: os.cpus().length, memoryGiB: os.totalmem() / 2 ** 30, load: os.loadavg() } }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  const results = []
  for (let round = 0; round < rounds; round++) {
    for (const count of round % 2 ? [...concurrency].reverse() : concurrency) {
      for (const engine of round % 2 ? [...engines].reverse() : engines) {
        const config = { engine, concurrency: count, round, cc, snapshot: sdk.snapshot, workload: values.workload,
          directory: join(directory, `${round}-${count}-${engine}`), nonce: randomUUID(), persist: !values['no-persist'],
          turns: positive('turns'), inputChars: positive('input-chars'), responseDelayMs: positive('response-delay-ms'),
          chunkDelayMs: positive('chunk-delay-ms'), idleMs: positive('idle-ms'), sampleMs: positive('sample-ms'),
          maxRssGiB: positive('max-rss-gib'), timeoutMs: positive('timeout-ms') }
        assert(config.turns >= 2)
        console.log(`Running round ${round + 1}/${rounds}: ${engine}, ${count} sessions, ${config.workload}`)
        const result = await runCase(config, cpuExecutable)
        results.push(result)
        await fs.writeFile(join(directory, 'progress.json'), JSON.stringify({ completed: results.length, last: result.passed, lastCase: config.directory }))
        if (!result.passed) throw new Error(`Benchmark failed; see ${join(config.directory, 'result.json')}: ${result.error}`)
        console.log(JSON.stringify({ engine, concurrency: count, ...result.metrics }))
        await delay(300)
      }
    }
  }
  const groups = []
  for (const count of concurrency) for (const engine of engines) {
    const cases = results.filter(row => row.config.concurrency === count && row.config.engine === engine)
    groups.push({ engine, concurrency: count, rounds: cases.length,
      metrics: Object.fromEntries(Object.keys(cases[0].metrics).map(key => [key, distribution(cases.map(row => row.metrics[key]))])) })
  }
  await fs.writeFile(join(directory, 'summary.json'), JSON.stringify({ passed: true, manifest, groups }, null, 2))
  console.log(`PASS: ${results.length} cases. Summary: ${join(directory, 'summary.json')}`)
}

try {
  if (process.argv.includes('--actor')) await actor()
  else await supervisor()
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
  if (process.send) process.exit(1)
}
