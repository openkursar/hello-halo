import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('dispatch previews never call gh and do not report a test result', () => {
  const result = spawnSync(process.execPath, ['scripts/acceptance/ci-dispatch.mjs', '--repository', 'example/controller'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Preview only/)
  assert.doesNotMatch(result.stdout, /"source_ref"/)
  assert.match(result.stdout, /"ref": "main"/)
  assert.doesNotMatch(result.stdout, /dispatch accepted/)
})

test('explicit module and source selections reach dispatch without overriding unspecified defaults', () => {
  const result = spawnSync(process.execPath, ['scripts/acceptance/ci-dispatch.mjs', '--repository', 'example/controller', '--source-ref', 'release', '--module', 'teams', '--module', 'chat', '--case', 'teams.keep'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"source_ref": "release"/)
  assert.match(result.stdout, /"modules": "chat,teams"/)
  assert.match(result.stdout, /"cases": "teams.keep"/)
})

test('registration preview does not execute a new runner distribution', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-runner-preview-'))
  try {
    fs.writeFileSync(path.join(directory, 'config.sh'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    const result = spawnSync(process.execPath, ['scripts/acceptance/ci-runner.mjs', '--directory', directory, '--repository', 'example/controller', '--name', 'test-runner'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Preview only/)
    assert.equal(fs.readdirSync(directory).length, 1)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('registration refuses an existing runner even with execute requested', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-existing-runner-'))
  try {
    fs.writeFileSync(path.join(directory, '.runner'), 'existing-runner')
    const result = spawnSync(process.execPath, ['scripts/acceptance/ci-runner.mjs', '--directory', directory, '--repository', 'example/controller', '--name', 'test-runner', '--execute'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already configured/)
    assert.equal(fs.readFileSync(path.join(directory, '.runner'), 'utf8'), 'existing-runner')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
