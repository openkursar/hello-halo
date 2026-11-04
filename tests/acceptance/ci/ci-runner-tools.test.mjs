import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { parse } from 'yaml'
import { cleanEnvironment, prerequisiteFailures } from '../../../scripts/acceptance/lib/execution.mjs'

const workflow = parse(fs.readFileSync(new URL('./runner-tools.yml', import.meta.url), 'utf8'))
const acceptance = parse(fs.readFileSync(new URL('./acceptance.yml', import.meta.url), 'utf8'))
const policy = fs.readFileSync(new URL('../../../src/main/services/cc-runtime/policy.ts', import.meta.url), 'utf8')
const job = workflow.jobs['claude-code']
const install = job.steps[0]
const supported = process.platform === 'darwin' && process.arch === 'arm64'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('the installed Claude Code is the version Halo recommends and has verified on macOS arm64, pinned by checksum', () => {
  const recommended = policy.match(/RECOMMENDED_VERSION = '([^']+)'/)[1]
  const verified = policy.match(/platform: 'darwin', arch: 'arm64', kind: 'native', versions: \[([^\]]+)\]/)[1].match(/\d+\.\d+\.\d+/g)
  assert.equal(job.env.CLAUDE_CODE_VERSION, recommended)
  assert(verified.includes(job.env.CLAUDE_CODE_VERSION))
  assert.match(job.env.CLAUDE_CODE_SHA256, /^[a-f0-9]{64}$/)
  assert.equal(job.env.CLAUDE_CODE_RELEASES, 'https://downloads.claude.ai/claude-code-releases')
})

test('the maintenance workflow is manual, read-only, uses no secret or account, and installs outside the system and the runner account home', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.equal(workflow.on.workflow_dispatch, null)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(job['runs-on'], acceptance.jobs.acceptance['runs-on'])
  assert.equal(job.steps.length, 1)
  assert.equal(job.env.HALO_CI_TOOLS_ROOT, "${{ vars.HALO_CI_TOOLS_ROOT || '/Users/Shared/halo-ci-tools' }}")
  const text = JSON.stringify(workflow)
  assert.equal(/secrets\.|github\.token|ANTHROPIC|login|\/\.claude|~\/|\$HOME/i.test(text), false)
  assert.equal(/sudo|npm |brew /.test(install.run), false)
})

test('acceptance runs receive the configured executable and nothing changes while it is unset', async () => {
  assert.equal(acceptance.jobs.acceptance.steps.find(step => step.id === 'execute').env.HALO_ACCEPTANCE_CLAUDE_CLI, '${{ vars.HALO_ACCEPTANCE_CLAUDE_CLI }}')
  assert.equal(cleanEnvironment({ HALO_ACCEPTANCE_CLAUDE_CLI: '/tools/claude' }).HALO_ACCEPTANCE_CLAUDE_CLI, '/tools/claude')
  const scenario = { requirements: [], variant: { engine: 'anthropic' } }
  const previous = process.env.HALO_ACCEPTANCE_CLAUDE_CLI
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-claude-cli-'))
  try {
    process.env.HALO_ACCEPTANCE_CLAUDE_CLI = ''
    assert.deepEqual(await prerequisiteFailures(directory, scenario), ['A separately installed external command-line engine was not configured'])
    process.env.HALO_ACCEPTANCE_CLAUDE_CLI = path.join(directory, 'missing')
    assert.deepEqual(await prerequisiteFailures(directory, scenario), ['The configured external command-line engine does not exist'])
    fs.writeFileSync(path.join(directory, 'claude'), '')
    process.env.HALO_ACCEPTANCE_CLAUDE_CLI = path.join(directory, 'claude')
    assert.deepEqual(await prerequisiteFailures(directory, scenario), [])
  } finally {
    if (previous === undefined) delete process.env.HALO_ACCEPTANCE_CLAUDE_CLI
    else process.env.HALO_ACCEPTANCE_CLAUDE_CLI = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function installer(context, { served, manifestChecksum, pinned, existing, version = '2.1.310', reported = version, guard = '' } = {}) {
  const executable = Buffer.from(`#!/bin/sh\n${guard}echo "${reported} (Claude Code)"\n`)
  const body = served ?? executable
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    if (request.url === `/${version}/manifest.json`) response.end(JSON.stringify({ version, platforms: { 'darwin-arm64': { checksum: manifestChecksum ?? sha256(body), size: body.length } } }))
    else if (request.url === `/${version}/darwin-arm64/claude`) response.end(body)
    else { response.statusCode = 404; response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-runner-tools-'))
  context.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const tools = path.join(root, 'tools')
  const binary = path.join(tools, 'claude-code', version, 'claude')
  if (existing !== undefined) { fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, existing, { mode: 0o755 }) }
  const run = (overrides = {}) => new Promise(resolve => {
    const output = path.join(root, 'output'), summary = path.join(root, 'summary')
    fs.rmSync(output, { force: true })
    const child = spawn('bash', ['-c', install.run], { cwd: root, env: {
      PATH: process.env.PATH, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      CLAUDE_CODE_VERSION: version, CLAUDE_CODE_SHA256: pinned ?? sha256(executable), CLAUDE_CODE_RELEASES: `http://127.0.0.1:${server.address().port}`, HALO_CI_TOOLS_ROOT: tools, ...overrides,
    }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    child.on('exit', status => resolve({ status, log, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' }))
  })
  const leftovers = () => fs.existsSync(path.join(tools, 'claude-code')) ? fs.readdirSync(path.join(tools, 'claude-code')) : []
  return { run, binary, tools, leftovers, requests }
}

test('the pinned executable is downloaded, verified and run once, and installing again changes nothing', { skip: !supported }, async context => {
  const selected = await installer(context)
  const first = await selected.run()
  assert.equal(first.status, 0, first.log)
  assert.equal(first.output.trim(), `path=${selected.binary}`)
  assert.equal(fs.statSync(selected.binary).mode & 0o777, 0o755)
  assert.deepEqual(selected.leftovers(), ['2.1.310'])
  const stamp = fs.statSync(selected.binary).mtimeMs
  const second = await selected.run()
  assert.equal(second.status, 0, second.log)
  assert.match(second.log, /Already installed/)
  assert.equal(fs.statSync(selected.binary).mtimeMs, stamp)
})

test('a checksum that differs from the pin, in the manifest or in the downloaded bytes, installs nothing', { skip: !supported }, async context => {
  const manifestMoved = await installer(context, { manifestChecksum: 'f'.repeat(64) })
  const moved = await manifestMoved.run()
  assert.equal(moved.status, 1)
  assert.match(moved.log, /differs from the pinned one/)
  assert.deepEqual(manifestMoved.leftovers(), [])
  const bytesChanged = await installer(context, { served: Buffer.from('#!/bin/sh\necho "2.1.310 (Claude Code)"\n# altered\n'), manifestChecksum: sha256(Buffer.from('#!/bin/sh\necho "2.1.310 (Claude Code)"\n')) })
  const altered = await bytesChanged.run()
  assert.equal(altered.status, 1)
  assert.match(altered.log, /does not match the pinned checksum/)
  assert.deepEqual(bytesChanged.leftovers(), [])
})

test('an executable that reports another version is refused before it is published', { skip: !supported }, async context => {
  const selected = await installer(context, { reported: '2.1.89' })
  const result = await selected.run()
  assert.equal(result.status, 1)
  assert.match(result.log, /reports '2\.1\.89 /)
  assert.deepEqual(selected.leftovers(), [])
})

test('an existing file or directory that is not the pinned executable is never replaced', { skip: !supported }, async context => {
  const different = await installer(context, { existing: 'something else' })
  const result = await different.run()
  assert.equal(result.status, 1)
  assert.match(result.log, /does not match the pinned checksum; nothing was changed/)
  assert.equal(fs.readFileSync(different.binary, 'utf8'), 'something else')
  const empty = await installer(context)
  fs.mkdirSync(path.dirname(empty.binary), { recursive: true })
  const blocked = await empty.run()
  assert.equal(blocked.status, 1)
  assert.match(blocked.log, /exists without an executable/)
})

test('the version check runs the executable in an empty environment', { skip: !supported }, async context => {
  const selected = await installer(context, { guard: '[ -z "$PROBE_LEAK" ] || { echo "leaked environment"; exit 0; }\n[ "$HOME" != "$PROBE_HOME" ] || { echo "inherited home"; exit 0; }\n' })
  const result = await selected.run({ PROBE_LEAK: 'present', PROBE_HOME: os.homedir(), HOME: os.homedir() })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(selected.leftovers(), ['2.1.310'])
})

test('a tools directory containing a parent reference is refused by the check itself, before any request', { skip: !supported }, async context => {
  const selected = await installer(context)
  const resolvable = `${selected.tools}/../${path.basename(selected.tools)}`
  fs.mkdirSync(selected.tools, { recursive: true })
  const result = await selected.run({ HALO_CI_TOOLS_ROOT: resolvable })
  assert.equal(result.status, 1)
  assert.match(result.log, /unsupported characters/)
  assert.deepEqual(selected.requests, [])
  assert.deepEqual(selected.leftovers(), [])
})

test('an unwritable tools directory stops the run before any request and changes nothing', { skip: !supported || process.getuid?.() === 0 }, async context => {
  const selected = await installer(context)
  fs.mkdirSync(selected.tools, { recursive: true })
  fs.chmodSync(selected.tools, 0o555)
  try {
    const present = await selected.run()
    assert.equal(present.status, 1)
    assert.match(present.log, /is not writable by the runner account; nothing was changed/)
    assert.deepEqual(selected.requests, [])
    const absent = await selected.run({ HALO_CI_TOOLS_ROOT: path.join(selected.tools, 'inner') })
    assert.equal(absent.status, 1)
    assert.match(absent.log, /its parent is not writable/)
    assert.deepEqual(selected.requests, [])
  } finally { fs.chmodSync(selected.tools, 0o755) }
})

test('an unsupported pin or tools directory is refused before any request', { skip: !supported }, async context => {
  const selected = await installer(context)
  for (const overrides of [{ CLAUDE_CODE_VERSION: 'latest' }, { CLAUDE_CODE_VERSION: '' }, { CLAUDE_CODE_SHA256: 'ABC' }, { CLAUDE_CODE_SHA256: 'a'.repeat(63) }, { HALO_CI_TOOLS_ROOT: 'relative/tools' }, { HALO_CI_TOOLS_ROOT: '/tmp/../etc' }, { HALO_CI_TOOLS_ROOT: '/tmp/a b' }]) {
    const result = await selected.run(overrides)
    assert.equal(result.status, 1, JSON.stringify(overrides))
    assert.deepEqual(selected.leftovers(), [])
  }
})
