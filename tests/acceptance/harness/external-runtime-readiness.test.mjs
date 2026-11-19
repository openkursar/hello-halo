import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { externalRuntimeFailure } from '../../../scripts/acceptance/lib/external-runtime-readiness.mjs'

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-runtime-readiness-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'codex')
  const provenance = path.join(directory, 'provenance.json')
  const bytes = 'inert test fixture; never executed'
  await fs.writeFile(executable, bytes, { mode: 0o700 })
  const receipt = { version: '0.132.0', platform: process.platform, arch: process.arch, executable, sha256: createHash('sha256').update(bytes).digest('hex') }
  await fs.writeFile(provenance, JSON.stringify(receipt))
  return { executable, provenance, receipt, environment: { HALO_ACCEPTANCE_CODEX_CLI: executable, HALO_ACCEPTANCE_CODEX_PROVENANCE: provenance } }
}

test('external runtimes never resolve missing or relative paths through personal PATH', async () => {
  for (const runtime of ['anthropic', 'codex']) {
    for (const value of [undefined, 'codex']) {
      const environment = { PATH: '/personal/bin', HALO_ACCEPTANCE_CODEX_CLI: value, HALO_ACCEPTANCE_CLAUDE_CLI: value }
      assert.match(await externalRuntimeFailure(runtime, { environment }), /explicit absolute.*personal PATH is not searched/)
    }
  }
})

test('Codex readiness binds fixed version, host and actual bytes without executing the artifact', async context => {
  const data = await fixture(context)
  assert.equal(await externalRuntimeFailure('codex', data), null)
  await fs.appendFile(data.executable, 'changed')
  assert.match(await externalRuntimeFailure('codex', data), /do not match.*SHA-256/)
})

test('a wrong release or platform cannot supply Codex prerequisite evidence', async context => {
  const data = await fixture(context)
  for (const change of [{ version: '0.128.0' }, { platform: 'other' }, { arch: 'other' }, { sha256: 'not-a-digest' }]) {
    await fs.writeFile(data.provenance, JSON.stringify({ ...data.receipt, ...change }))
    assert.match(await externalRuntimeFailure('codex', data), /version 0\.132\.0.*platform.*SHA-256/)
  }
})

test('recorded OS execution failure blocks a byte-identical Codex artifact without launching it again', async context => {
  const data = await fixture(context)
  await fs.writeFile(data.provenance, JSON.stringify({ ...data.receipt, execution: { state: 'blocked' } }))
  assert.match(await externalRuntimeFailure('codex', data), /OS execution prerequisite is blocked/)
})

test('a missing Codex receipt blocks and Claude Code still requires its own explicit executable', async context => {
  const data = await fixture(context)
  assert.match(await externalRuntimeFailure('codex', { environment: { HALO_ACCEPTANCE_CODEX_CLI: data.executable } }), /PROVENANCE/)
  assert.equal(await externalRuntimeFailure('anthropic', { environment: { HALO_ACCEPTANCE_CLAUDE_CLI: data.executable } }), null)
})
