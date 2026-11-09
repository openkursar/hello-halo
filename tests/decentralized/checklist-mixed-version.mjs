#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = value => createHash('sha256').update(value).digest('hex')
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function parseOptions(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!['--legacy-root', '--results'].includes(key) || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Use --legacy-root <built older checkout> --results <new JSON file>')
    }
    options[key] = args[i + 1]
  }
  if (!options['--legacy-root'] || !options['--results']) throw new Error('Both --legacy-root and --results are required')
  return { legacyRoot: path.resolve(options['--legacy-root']), results: path.resolve(options['--results']) }
}

// An allowlist prevents shell credentials, proxy settings and host engine homes
// from becoming fallback configuration in either independently built application.
export function isolatedEnvironment(profile, inherited = process.env) {
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL']) {
    if (inherited[key] !== undefined) env[key] = inherited[key]
  }
  return { ...env, HOME: profile, USERPROFILE: profile, HALO_DATA_DIR: path.join(profile, '.halo'),
    XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache'),
    XDG_DATA_HOME: path.join(profile, 'data'), APPDATA: path.join(profile, 'config'), LOCALAPPDATA: path.join(profile, 'cache'),
    TMPDIR: path.join(profile, 'tmp'), TMP: path.join(profile, 'tmp'), TEMP: path.join(profile, 'tmp'),
    CLAUDE_CONFIG_DIR: path.join(profile, 'engine-state'), HALO_E2E_TEST: '1', ELECTRON_DISABLE_GPU: '1',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
}

export function rosterConfiguration(detail) {
  return {
    lead: detail.team.leadAppId,
    members: detail.members.map(member => Object.fromEntries(
      ['appId', 'memberName', 'role', 'isLead', 'duty', 'aiProvisioned', 'isSystemCoordinator'].map(key => [key, member[key] ?? null]),
    )).sort((a, b) => a.appId.localeCompare(b.appId)),
    edges: (detail.edges ?? []).map(edge => `${edge.from ?? edge.fromAppId}->${edge.to ?? edge.toAppId}`).sort(),
  }
}

export function sharedMembers(members) {
  return members.map(({ aiProvisioned: _aiProvisioned, isSystemCoordinator: _isSystemCoordinator, ...member }) => member)
}

export async function stopHeldSend({ send, waitActive, stop, waitCancelled }) {
  const controller = new AbortController()
  // The send API waits for the turn; attach both handlers before observing it.
  const pending = Promise.resolve().then(() => {
    controller.signal.throwIfAborted()
    return send(controller.signal)
  }).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
  try {
    await Promise.race([waitActive(controller.signal), pending.then(outcome => {
      if (outcome.status === 'rejected') throw outcome.reason
      throw new Error('Held send settled before its active stream was observed')
    })])
    const stopped = await stop()
    assert.equal(stopped?.ok, true, 'Owner stop request must succeed')
    assert.equal(stopped.stopped, true, 'Owner stop must stop the active turn')
    await waitCancelled()
    const outcome = await pending
    if (outcome.status === 'rejected') throw outcome.reason
    assert.equal(outcome.value?.ok, true, 'Stopped send must settle successfully, not time out or become undelivered')
    assert.equal(outcome.value.reason, undefined, 'Stopped send must not report a delivery failure')
    assert.equal(outcome.value.delivery, undefined, 'Held send must start a turn, not be queued or injected')
    assert.ok(outcome.value.finalMessage === null || typeof outcome.value.finalMessage === 'string', 'Stopped send needs a valid reply shape')
    return outcome.value
  } finally {
    controller.abort()
    await pending
  }
}

async function api(node, method, route, body, signal, timeout = 10000) {
  const response = await fetch(`${node.baseUrl}${route}`, {
    method, headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  })
  const json = await response.json()
  if (!response.ok || json.success !== true) throw new Error(`${node.label}: ${method} ${route.split('?')[0]} failed (HTTP ${response.status}): ${String(json.error ?? json.code ?? 'unknown').slice(0, 120)}`)
  return json.data
}

async function until(label, check, signal, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const result = await check()
    if (result) return result
    await sleep(150)
  }
  throw new Error(`Timed out: ${label}`)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { port: server.address().port, release: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function inspectBuild(directory, verifyBuild) {
  directory = fs.realpathSync(directory)
  const build = await verifyBuild(directory)
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const entry = path.resolve(directory, descriptor.main)
  assert.equal(path.dirname(entry), path.join(directory, 'out/main'), 'Expected the built checkout main entry')
  const protocolSource = fs.readFileSync(path.join(directory, 'src/shared/federation/protocol-version.ts'), 'utf8')
  assert.match(protocolSource, /FEDERATION_PROTOCOL_VERSION\s*=\s*4\b/, 'This runner exercises the existing protocol 4 compatibility contract')
  const electron = createRequire(path.join(directory, 'package.json'))('electron')
  assert.ok(fs.existsSync(electron), 'The checkout needs its own installed Electron binary')
  assert.equal(build.sdk?.state, 'present', 'Halo SDK must be installed in each checkout')
  assert.ok(build.sdk?.dist, 'Halo SDK must already be built')
  return { directory, entry, electron, build, revision: git(directory, 'rev-parse', 'HEAD'),
    entrySha256: hash(fs.readFileSync(entry)), electronSha256: hash(fs.readFileSync(electron)) }
}

export function verifyBuildPair(current, legacy, readGit = git) {
  assert.notEqual(current.directory, legacy.directory, 'Legacy root must be a separate checkout')
  assert.notEqual(current.revision, legacy.revision, 'Legacy checkout must be a different actual revision')
  readGit(current.directory, 'merge-base', '--is-ancestor', legacy.revision, current.revision)
  assert.equal(readGit(legacy.directory, 'diff', '--name-only', 'HEAD', '--', 'src', ':(exclude)src/sdk'), '', 'Legacy source must match its actual older revision')
  assert.equal(readGit(legacy.directory, 'ls-files', '--others', '--exclude-standard', '--', 'src', ':(exclude)src/sdk'), '', 'Legacy source must not contain uncommitted additions')
  const sourceIdentity = item => {
    const files = item.build.inputs.files.filter(file => file.path.startsWith('src/') && file.path !== 'src/shared/federation/protocol-version.ts')
      .map(({ path: name, sha256 }) => [name, sha256]).sort(([a], [b]) => a.localeCompare(b))
    assert.ok(files.length, 'Build provenance must identify actual application source')
    return hash(JSON.stringify(files))
  }
  assert.notEqual(sourceIdentity(current), sourceIdentity(legacy), 'Legacy application source must differ beyond the protocol version declaration')
  assert.notEqual(current.entrySha256, legacy.entrySha256, 'Both nodes must not run the same application binary')
}

function seedProfile(profile, port, url, token, label) {
  const halo = path.join(profile, '.halo')
  for (const name of ['tmp', 'engine-state', '.halo/temp/artifacts', '.halo/temp/conversations', '.halo/spaces']) fs.mkdirSync(path.join(profile, name), { recursive: true })
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const digest = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')
  fs.writeFileSync(path.join(halo, 'node-identity.json'), JSON.stringify({ id: `id_${digest.slice(0, 32)}`, displayName: label,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 })
  const sourceId = randomUUID()
  fs.writeFileSync(path.join(halo, 'config.json'), JSON.stringify({
    api: { provider: 'anthropic', apiKey: 'local-scripted-endpoint', apiUrl: `${url}/v1`, model: 'gpt-4o' },
    aiSources: { version: 2, currentId: sourceId, sources: [{ id: sourceId, name: 'Mixed version scripted model', provider: 'custom',
      authType: 'api-key', apiUrl: `${url}/v1`, apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', model: 'gpt-4o',
      availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] },
    agent: { sdkEngine: 'halo', promptProfile: 'halo', maxTurns: 12, configDirMode: 'custom', customConfigDir: path.join(profile, 'engine-state') },
    permissions: { fileAccess: 'allow', commandExecution: 'allow', networkAccess: 'allow', trustMode: true },
    remoteAccess: { enabled: true, port, password: token }, system: { autoLaunch: false },
    onboarding: { completed: true }, isFirstLaunch: false, mcpServers: {},
  }), { mode: 0o600 })
}

async function launch(build, label, directory, model, owned, signal) {
  const profile = path.join(directory, label)
  const reservation = await reservePort()
  const token = `Mixed-${randomUUID()}-Aa1!`
  try { seedProfile(profile, reservation.port, model.url, token, label) }
  finally { await reservation.release() }
  const log = fs.openSync(path.join(profile, 'process.log'), 'a', 0o600)
  let child
  try {
    child = spawn(build.electron, ['--no-proxy-server', build.entry], {
      cwd: build.directory, env: isolatedEnvironment(profile), detached: true, stdio: ['ignore', log, log],
    })
  } finally { fs.closeSync(log) }
  const node = { label, child, profile, token, baseUrl: `http://127.0.0.1:${reservation.port}`, exited: false, spawnError: null }
  owned.push(node)
  child.once('exit', () => { node.exited = true })
  child.once('error', error => { node.spawnError = error; node.exited = true })
  await once(child, 'spawn')
  await until(`${label} API readiness`, async () => {
    if (node.exited) throw new Error(`${label} application exited during startup`)
    try { return Array.isArray(await api(node, 'GET', '/api/teams', undefined, signal)) }
    catch (error) { signal.throwIfAborted(); return false }
  }, signal, 90000)
  const engine = await api(node, 'GET', '/api/agent/engine-availability', undefined, signal)
  assert.equal(engine.activeEngine, 'halo', 'The selected engine must not fall back')
  assert.equal(engine.degradedFrom, null, 'The selected engine must not degrade')
  return node
}

async function stopOwned(node) {
  if (!node.child.pid) return
  const send = signal => {
    try { process.kill(-node.child.pid, signal) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  send('SIGTERM')
  const deadline = Date.now() + 8000
  while (!node.exited && Date.now() < deadline) await sleep(100)
  send('SIGKILL')
  await until('owned application exit', () => node.exited, undefined, 5000)
}

async function exercise(host, peer, model, record, signal) {
  const request = (node, method, route, body) => api(node, method, route, body, signal)
  const suffix = randomUUID().replaceAll('-', '')
  const makeOffice = async (node, name) => {
    const space = await request(node, 'POST', '/api/spaces', { name, icon: '🧪' })
    const team = await request(node, 'POST', '/api/teams', { input: { name, goal: 'Answer only explicit requests.', owningSpaceId: space.id,
      memberSourcing: 'ai', collabMode: 'free', escalationRouting: 'user' },
    confirmedProposal: [{ memberName: name, role: 'Reviewer', responsibility: 'Reply only when addressed.' }] })
    const detail = await request(node, 'GET', `/api/teams/${team.id}/detail`)
    return { team, detail, worker: detail.members.find(member => !member.isLead).appId }
  }
  const office = await makeOffice(host, `Host-${suffix}`)
  const teamId = office.team.id
  const prefix = `/api/teams/${teamId}`
  const detail = node => request(node, 'GET', `${prefix}/detail`)
  const history = (node, appId, epochId) => request(node, 'GET', `${prefix}/chat-messages?appId=${appId}&epochId=${epochId}`)
  const send = (node, appId, epochId, message) => request(node, 'POST', `${prefix}/members/${appId}/send`, { epochId, message })
  const idle = async (node, appId, epochId) => {
    const conversationId = `app-chat:${appId}:team:${teamId}:${epochId}`
    return (await request(node, 'GET', `/api/apps/${appId}/chat/status?conversationId=${encodeURIComponent(conversationId)}`)).isGenerating === false
  }
  const answer = async (owner, appId, epochId, marker) => until(`persisted answer ${marker}`, async () => {
    const messages = await history(owner, appId, epochId)
    return messages.some(message => message.role === 'assistant' && message.content?.includes(marker)) && await idle(owner, appId, epochId) ? messages : null
  }, signal)
  const originalRoster = rosterConfiguration(office.detail)
  const invitation = await request(host, 'POST', `${prefix}/invite`, {})
  const originalTask = await request(host, 'POST', `${prefix}/conversations`, { title: 'History before joining' })
  const historicalMarker = `HISTORY_${suffix}`
  model.register(historicalMarker, { kind: 'answer' })
  await send(host, office.worker, originalTask.epochId, historicalMarker)
  const originalMessages = await answer(host, office.worker, originalTask.epochId, `RECEIVED_${historicalMarker}`)
  const bench = await makeOffice(peer, `Peer-${suffix}`)
  await request(peer, 'POST', `${prefix}/join`, { serverUrl: host.baseUrl, inviteToken: invitation.token, bringAppIds: [bench.worker] })
  const expectedMembers = [...originalRoster.members.map(member => member.appId), bench.worker].sort()
  const joined = await until('ordinary roster convergence', async () => {
    const details = await Promise.all([detail(host), detail(peer)])
    return details.every(value => JSON.stringify(value.members.map(member => member.appId).sort()) === JSON.stringify(expectedMembers)
      && value.team.leadAppId === originalRoster.lead) ? details : null
  }, signal)
  assert.deepEqual(rosterConfiguration(joined[0]).members.filter(member => member.appId !== bench.worker), originalRoster.members,
    'Joining must preserve the owner-local provisioning configuration')
  for (const value of joined) {
    const retained = sharedMembers(rosterConfiguration(value).members.filter(member => member.appId !== bench.worker))
    const originalShared = sharedMembers(originalRoster.members)
    const changedFields = retained.flatMap(member => {
      const before = originalShared.find(item => item.appId === member.appId)
      return Object.keys(member).filter(key => JSON.stringify(member[key]) !== JSON.stringify(before?.[key]))
    })
    assert.deepEqual(retained, originalShared, `Existing shared roster fields changed at join: ${[...new Set(changedFields)].join(', ')}`)
  }
  await until('pre-join task history directory', async () => (await request(peer, 'GET', `${prefix}/conversations`))
    .some(item => item.epochId === originalTask.epochId), signal)
  const baseline = joined.map(rosterConfiguration)
  record('join', { host: host.label, peer: peer.label, originalMembers: originalRoster.members.length, joinedMembers: expectedMembers.length })
  const task = await request(host, 'POST', `${prefix}/conversations`, { title: 'Mixed version messages' })
  await until('shared task', async () => (await request(peer, 'GET', `${prefix}/conversations`)).some(item => item.epochId === task.epochId), signal)
  const routes = [
    { sender: host, source: office.worker, target: bench.worker, receiver: peer },
    { sender: peer, source: bench.worker, target: office.worker, receiver: host },
  ]
  for (const [index, route] of routes.entries()) {
    const instruction = `DISPATCH_${suffix}_${index}`
    const delivery = `DELIVERY_${suffix}_${index}`
    const targetName = (await detail(route.sender)).members.find(member => member.appId === route.target)?.memberName
    assert.ok(targetName, 'The sender must resolve the target in its ordinary roster')
    model.register(instruction, { kind: 'send', target: targetName, delivery })
    model.register(delivery, { kind: 'answer' })
    await send(route.sender, route.source, task.epochId, instruction)
    await answer(route.sender, route.source, task.epochId, `SENT_${instruction}`)
    const received = await answer(route.receiver, route.target, task.epochId, `RECEIVED_${delivery}`)
    const deliveredInput = received.find(message => message.role === 'system' && message.source === 'team-message'
      && message.content?.includes(delivery))
    assert.equal(deliveredInput?.metadata?.teamTriggerKind, 'message', 'Recipient needs real teammate provenance')
    for (const reader of [host, peer]) {
      await until('shared directed message record', async () => {
        const board = await request(reader, 'GET', `${prefix}/epochs/${task.epochId}/board`)
        const matches = board.activities?.filter(item => item.kind === 'message' && item.actorAppId === route.source && item.targetAppId === route.target && `${item.body ?? ''} ${item.subject ?? ''}`.includes(delivery)) ?? []
        assert.ok(matches.length <= 1, 'Directed message must not be duplicated')
        return matches.length === 1
      }, signal)
      const mirrored = await history(reader, route.target, task.epochId)
      assert.ok(mirrored.some(message => message.role === 'assistant' && message.content?.includes(`RECEIVED_${delivery}`)))
    }
    record('message-and-record', { host: host.label, from: route.sender.label, to: route.receiver.label, provenance: 'message', sharedRecordCount: 1 })
  }
  for (const route of routes) {
    const marker = `HOLD_${suffix}_${route.receiver.label}`
    model.register(marker, { kind: 'hold' })
    await stopHeldSend({
      send: pendingSignal => api(route.sender, 'POST', `${prefix}/members/${route.target}/send`,
        { epochId: task.epochId, message: marker }, AbortSignal.any([signal, pendingSignal]), 90000),
      waitActive: pendingSignal => until('active model stream and owner generation', async () => model.exchangesFor(marker).some(exchange => !exchange.completed && !exchange.cancelled)
        && !await idle(route.receiver, route.target, task.epochId), AbortSignal.any([signal, pendingSignal])),
      stop: () => request(route.sender, 'POST', `${prefix}/members/${route.target}/stop`, { epochId: task.epochId }),
      waitCancelled: () => until('owner cancels the held provider stream', async () => model.exchangesFor(marker).some(exchange => exchange.cancelled)
        && await idle(route.receiver, route.target, task.epochId), signal),
    })
    const fresh = `FRESH_${suffix}_${route.receiver.label}`
    model.register(fresh, { kind: 'answer' })
    await send(route.sender, route.target, task.epochId, fresh)
    await answer(route.receiver, route.target, task.epochId, `RECEIVED_${fresh}`)
    assert.ok(model.exchangesFor(fresh).some(exchange => exchange.completed), 'Fresh input must reach and complete at the model')
    record('owner-stop-and-fresh-input', { host: host.label, caller: route.sender.label, owner: route.receiver.label, cancelled: true, sendSettled: true, freshCompleted: true })
  }
  for (const [index, node] of [host, peer].entries()) {
    assert.deepEqual(rosterConfiguration(await detail(node)), baseline[index], 'Ordinary member configuration must not change')
    const preserved = await history(node, office.worker, originalTask.epochId)
    const rows = messages => messages.map(message => ({ ...(node === host ? { id: message.id } : {}), role: message.role, content: message.content }))
    const changed = rows(preserved).map((message, index) => Object.keys(message).filter(key => JSON.stringify(message[key]) !== JSON.stringify(rows(originalMessages)[index]?.[key])))
    assert.deepEqual(rows(preserved), rows(originalMessages), `Pre-join transcript must remain unchanged: node=${node.label} rows=${preserved.length}/${originalMessages.length} changed=${JSON.stringify(changed)}`)
  }
  record('history-and-members-unchanged', { host: host.label, members: expectedMembers.length, historicalMessages: originalMessages.length })
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (options.help) {
    console.log('Usage: node tests/decentralized/checklist-mixed-version.mjs --legacy-root <built older checkout> --results <new JSON file>\nRequires two distinct controlled acceptance builds (v2 provenance), installed Halo SDK/Electron, Node 22+, and a GUI session on macOS/Linux. Run alone. No build, paid model, production profile or shared output writes. Evidence is backend integration, not UI or live-model quality.')
    return
  }
  if (process.platform === 'win32') throw new Error('Blocked prerequisite: owned process-group cleanup currently requires macOS or Linux')
  if (fs.existsSync(options.results)) throw new Error('Results already exist; choose a new path to preserve earlier evidence')
  fs.mkdirSync(path.dirname(options.results), { recursive: true })
  const output = fs.openSync(options.results, 'wx', 0o600)
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'halo-mixed-version-'))
  const owned = [], records = [], cleanupErrors = []
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('Runner interrupted'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const timeout = setTimeout(() => controller.abort(new Error('Runner exceeded its 15 minute budget')), 15 * 60000)
  let model, builds, verifyBuild, failure, integrity = false
  const report = { version: 1, evidence: 'integration', mode: 'scripted', startedAt: new Date().toISOString(), status: 'not-run', records }
  const record = (name, evidence) => { records.push({ name, status: 'passed', ...evidence }); console.log(`PASS ${name}: ${JSON.stringify(evidence)}`) }
  try {
    ;({ verifyBuild } = await import('../../scripts/acceptance/lib/build.mjs'))
    builds = await Promise.all([inspectBuild(root, verifyBuild), inspectBuild(options.legacyRoot, verifyBuild)])
    verifyBuildPair(builds[0], builds[1])
    report.builds = builds.map((item, index) => ({ label: index ? 'legacy' : 'current', revision: item.revision, buildId: item.build.id,
      inputsSha256: item.build.inputs.rootSha256, artifactsSha256: item.build.artifacts.rootSha256,
      entrySha256: item.entrySha256, electronSha256: item.electronSha256, sdk: item.build.sdk, protocol: 4 }))
    const { build } = await import('esbuild')
    const bundle = path.join(directory, 'mixed-version-model.mjs')
    await build({ entryPoints: [path.join(root, 'tests/decentralized/fixtures/mixed-version-model.ts')], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' })
    const fixture = await import(pathToFileURL(bundle).href)
    model = await fixture.startMixedVersionModel()
    const current = await launch(builds[0], 'current', directory, model, owned, controller.signal)
    const legacy = await launch(builds[1], 'legacy', directory, model, owned, controller.signal)
    await exercise(current, legacy, model, record, controller.signal)
    await exercise(legacy, current, model, record, controller.signal)
    assert.equal(model.errors.length, 0, 'Scripted endpoint errors invalidate the run')
    assert.equal(model.issues.length, 0, 'Scripted tool execution/discovery errors invalidate the run')
    report.status = 'passed'
  } catch (error) {
    failure = error
    report.status = owned.length ? 'failed' : 'blocked'
    // Do not retain arbitrary API payloads, credentials, prompts or assertion dumps.
    report.failure = { kind: error.name, message: String(error.message).split('\n')[0].slice(0, 240),
      location: String(error.stack ?? '').split('\n').find(line => line.includes('checklist-mixed-version.mjs:'))?.trim() }
    console.error(`FAIL mixed-version: ${report.failure.message}`)
  } finally {
    clearTimeout(timeout)
    for (const node of owned.reverse()) {
      try { await stopOwned(node) } catch { cleanupErrors.push(`Could not stop owned ${node.label} process group`) }
      if (failure) {
        const logPath = path.join(node.profile, '.halo/logs/main.log')
        if (fs.existsSync(logPath)) {
          const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(line => /unreachable|undelivered|refused|not found|failed|rejected/i.test(line)
            && !/tool (block|call)|input:|payload|password|token|credential/i.test(line))
          ;(report.diagnostics ??= {})[node.label] = lines.slice(-20).map(line => line.replaceAll(node.token, '[redacted]').slice(0, 500))
        }
      }
    }
    if (model) {
      report.model = { exchanges: model.evidence(), errorCount: model.errors.length, issueCount: model.issues.length, issues: model.issues }
      try { await model.close() } catch { cleanupErrors.push('Could not close scripted endpoint') }
    }
    if (builds) {
      try {
        for (const item of builds) {
          const after = await verifyBuild(item.directory)
          assert.equal(after.id, item.build.id)
          assert.equal(hash(fs.readFileSync(item.electron)), item.electronSha256)
          assert.equal(git(item.directory, 'rev-parse', 'HEAD'), item.revision)
        }
        integrity = true
      } catch { cleanupErrors.push('Build identity changed or could not be verified after execution') }
    }
    if (!cleanupErrors.length) fs.rmSync(directory, { recursive: true, force: true })
    else report.retainedPrivateProfile = directory
    report.integrity = { valid: integrity && cleanupErrors.length === 0, cleanupErrors }
    if (!report.integrity.valid && report.status === 'passed') report.status = 'failed'
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    fs.closeSync(output)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  if (failure || report.status !== 'passed') process.exitCode = 1
  console.log(`Mixed-version ${report.status}; sanitized evidence: ${options.results}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
