import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileRules } from '../../scripts/commit-check/match.mjs'

const source = fileURLToPath(new URL('../../', import.meta.url))
const dir = 'scripts/commit-check'
const rulesFile = `${dir}/disclosure-rules.json`
const rules = JSON.parse(readFileSync(join(source, rulesFile)))
const matches = compileRules(rules)
const categories = text => matches(text).map(m => m.category)
const name = 'Microsoft Teams'
const token = `synthetic-${'7'.repeat(24)}`
const secret = `API_KEY=${token}`
const reviewed = ['-c', 'disclosure.reviewed=true']

function fixture(t, install = true) {
  const temp = mkdtempSync(join(tmpdir(), 'disclosure-test-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const root = join(temp, 'repo')
  mkdirSync(root)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'), GIT_TEMPLATE_DIR: '', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' })
  const run = (program, args, status = 0, cwd = root, extraEnv = {}) => {
    const r = spawnSync(program, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' })
    assert.equal(r.status, status, `${program}: ${r.stderr || r.error || r.stdout}`)
    return `${r.stdout}${r.stderr}`
  }
  const git = (...args) => run('git', args)
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  const stage = (path, content) => { write(path, content); git('add', '--', path) }
  git('init', '-q')
  cpSync(join(source, dir), join(root, dir), { recursive: true })
  const node = (args, status) => run(process.execPath, args, status)
  const hooks = (args = [], status = 0) => node([`${dir}/install.mjs`, ...args], status)
  const scan = (args = [], status = 0) => node([`${dir}/check.mjs`, ...args], status)
  const commit = (message = 'Update fixture', status = 0, { config = [], extra = [] } = {}) => run('git', [...config, 'commit', '-q', ...extra, '-m', message], status)
  const count = () => git('rev-list', '--all', '--count').trim()
  if (install) hooks()
  return { root, run, git, write, stage, hooks, scan, commit, count, node }
}

test('public vocabulary, common spellings and short-word boundaries', () => {
  assert.equal(rules.names.length, 88)
  for (const alias of rules.names.flat()) assert.ok(categories(alias).includes('name'), alias)
  for (const term of rules.phrases) assert.ok(categories(term).includes('context'), term)
  for (const variant of ['microsoft-teams', 'microsoft_teams', 'microsoftTeams', 'MICROSOFTTEAMS', 'readMicrosoftTeamsFile', 'useAWSClient']) assert.deepEqual(categories(variant), ['name'])
  assert.ok(categories('corporateProxy').includes('context'))
  assert.deepEqual(categories('draws metadata subsequent internal private customer production AI CC Q'), [])
  assert.deepEqual(categories('5127.0.0.1 127.0.0.1 192.0.2.8 198.51.100.9 203.0.113.7 2001:db8::1 https://example.invalid API_KEY process.env.API_KEY'), [])
})

test('synthetic private formats versus references and reserved examples', () => {
  for (const sample of ['10.12.34.56.', '172.31.9.1', '192.168.99.27', '100.64.0.1', '100.127.99.1', 'fd12::1', 'fe80::2', 'fixture.internal.', 'jumpbox-synthetic']) assert.ok(categories(sample).includes('network'), sample)
  for (const sample of ['10.999.999.999', '172.32.0.1', '100.128.0.1', 'bastion.example.org', 'redis://localhost', 'redis://db.example.invalid', 'API_KEY = process.env.API_KEY', 'password: string', 'token = ${TOKEN}', 'Authorization: Bearer ${TOKEN}']) assert.deepEqual(categories(sample), [], sample)
  for (const sample of ['/Users/fixture-only/project', '/home/fixture-only', 'C:\\Users\\fixture-only\\debug', '\\\\fixture-share\\demo', 'smb://fixture.invalid/demo']) assert.ok(categories(sample).includes('path'), sample)
  for (const sample of ['postgres://synthetic:sample@db.example.invalid', 'redis://synthetic-db']) assert.ok(categories(sample).includes('connection'), sample)
  for (const sample of [secret, `"password": "${token}"`, `Authorization: Bearer ${token}`, `Cookie: sample=${token}`, '-----BEGIN PRIVATE KEY-----', `https://example.invalid/blob?X-Amz-Signature=${token}`, `https://example.invalid/robot/send?access_token=${token}`, `https://example.invalid/services/a/b/${token}`, `https://example.invalid/api/webhooks/123/${token}`]) assert.ok(categories(sample).includes('credential'), sample)
  const policy = readFileSync(join(source, rulesFile), 'utf8')
  for (const line of policy.split('\n')) assert.deepEqual(matches(line, true), [])
  assert.ok(matches(`"note": "Using ${name} here"`, true).length)
  assert.ok(matches(`"label": "${secret}"`, true).some(m => m.category === 'credential'))
})

test('a name pauses the commit like any other match', t => {
  const f = fixture(t)
  f.stage('docs/channels.md', `Send to ${name}.\n`)
  const output = f.commit(`Mention ${name}`, 1)
  assert.match(output, /found possible sensitive information or internal details in this commit, so nothing has been committed yet/)
  assert.match(output, /docs\/channels\.md {2}line 1 {2}company or product name: Microsoft Teams/)
  assert.match(output, /commit message {2}line 1 {2}company or product name: Microsoft Teams/)
  assert.match(output, /may be false positives, or things the code genuinely needs/)
  assert.equal(f.count(), '0')
  assert.equal(f.commit(`Mention ${name}`, 0, { config: reviewed }), '')
  assert.equal(f.count(), '1')
})

test('a large report is capped in the hook and listed in full on request', t => {
  const f = fixture(t)
  for (let i = 0; i < 25; i++) f.stage(`docs/note-${i}.md`, `${name}\n`)
  const output = f.commit('Add notes', 1)
  assert.equal(output.match(/^ {2}docs\/note-/gm).length, 20)
  assert.match(output, /\.\.\.and 5 more\. Run node scripts\/commit-check\/check\.mjs to see them all\./)
  assert.equal(f.scan([], 1).match(/^ {2}docs\/note-/gm).length, 25)
})

test('sensitive content pauses without echoing it, and the reviewed flag commits', t => {
  const f = fixture(t)
  assert.match(f.scan(), /Nothing staged/)
  f.stage('src/config.md', `intro\n${secret}\n`)
  assert.match(f.scan([], 1), /src\/config\.md {2}line 2 {2}looks like a credential \(value hidden\)/)
  const output = f.commit('Add config', 1)
  assert.match(output, /found possible sensitive information or internal details in this commit, so nothing has been committed yet/)
  assert.match(output, /src\/config\.md {2}line 2 {2}looks like a credential \(value hidden\)/)
  assert.match(output, /git -c disclosure\.reviewed=true commit/)
  assert.ok(!output.includes(token))
  assert.equal(f.count(), '0')
  assert.equal(f.commit('Add config', 0, { config: reviewed }), '')
  assert.equal(f.count(), '1')
})

test('the message is checked line by line', t => {
  const f = fixture(t)
  f.stage('a.txt', 'Public\n')
  const output = f.commit(`Rotate\n\n${secret}`, 1)
  assert.match(output, /commit message {2}line 3 {2}looks like a credential \(value hidden\)/)
  assert.ok(!output.includes(token))
  assert.equal(f.commit('Rotate'), '')
})

test('only staged additions are scanned', t => {
  const f = fixture(t)
  f.stage('notes.md', `${secret}\nfirst\n`)
  f.commit('Baseline', 0, { config: reviewed })
  f.stage('notes.md', `${secret}\nsecond\n`)
  assert.equal(f.commit('Edit an unrelated line'), '')
  f.write('notes.md', `${secret}\nthird\n${secret}\n`)
  f.stage('other.md', 'Public\n')
  assert.equal(f.commit('Commit only the staged file'), '')
})

test('a file name that looks sensitive is reported without echoing it', t => {
  const f = fixture(t)
  f.stage('old.md', 'Public\n')
  f.commit()
  f.git('mv', '--', 'old.md', `${secret}.md`)
  const output = f.commit('Rename', 1)
  assert.match(output, /staged file #1 \(name hidden\) {2}file name {2}looks like a credential \(value hidden\)/)
  assert.ok(!output.includes(token))
})

test('a type change scans the new symlink target', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  f.stage('link', 'ordinary\n')
  f.commit()
  rmSync(join(f.root, 'link'))
  symlinkSync('fixture.internal', join(f.root, 'link'))
  f.git('add', '--', 'link')
  assert.match(f.commit('Change link', 1), /link {2}line 1 {2}looks like a private network address/)
})

test('a merge commit checks its message only', t => {
  const f = fixture(t)
  f.commit('Base', 0, { extra: ['--allow-empty'] })
  f.git('checkout', '-q', '-b', 'topic')
  f.stage('fixture.md', `${secret}\n`)
  f.commit('Add fixture', 0, { config: reviewed })
  f.git('checkout', '-q', '-b', 'trunk', 'HEAD~1')
  f.stage('trunk.md', 'Public\n')
  f.commit('Trunk')
  f.git('branch', 'second')
  assert.equal(f.git('merge', '-q', '--no-ff', '-m', 'Merge topic', 'topic'), '')
  f.git('checkout', '-q', 'second')
  assert.match(f.run('git', ['merge', '-q', '--no-ff', '-m', `Merge\n\n${secret}`, 'topic'], 1), /commit message {2}line 3 {2}looks like a credential \(value hidden\)/)
})

test('a broken check pauses with a way forward', t => {
  const f = fixture(t)
  f.write(rulesFile, '{')
  f.stage('a.txt', 'Public\n')
  const output = f.commit('Broken rules', 1)
  assert.match(output, /could not run/)
  assert.match(output, /git -c disclosure\.reviewed=true commit/)
  f.commit('Broken rules', 0, { config: reviewed })
})

test('a branch that predates the checker commits normally', t => {
  const f = fixture(t)
  f.commit('Baseline', 0, { extra: ['--allow-empty'] })
  f.git('add', '--', dir)
  f.commit('Add checker')
  f.git('checkout', '-q', '-b', 'older', 'HEAD~1')
  assert.equal(existsSync(join(f.root, dir)), false)
  f.stage('note.md', `${secret}\n`)
  f.commit(secret)
  assert.equal(f.git('log', '-1', '--format=%s').trim(), secret)
})

test('installer is idempotent and leaves existing hooks, custom hooks paths and parent repositories alone', t => {
  const f = fixture(t, false)
  const hook = join(f.root, '.git/hooks/commit-msg')
  mkdirSync(dirname(hook), { recursive: true })
  const previous = '#!/bin/sh\nexit 0\n'
  writeFileSync(hook, previous, { mode: 0o755 })
  assert.match(f.hooks([], 1), /existing commit-msg hook was kept/)
  assert.equal(readFileSync(hook, 'utf8'), previous)
  rmSync(hook)
  f.hooks()
  const installed = statSync(hook)
  f.hooks()
  assert.equal(statSync(hook).mtimeMs, installed.mtimeMs)
  rmSync(hook)
  const custom = join(dirname(f.root), 'custom')
  f.git('config', '--local', 'core.hooksPath', custom)
  assert.match(f.hooks([], 1), /custom core\.hooksPath/)
  assert.equal(existsSync(custom), false)
  f.git('config', '--local', '--unset', 'core.hooksPath')
  const nested = join(f.root, 'dependency', dir)
  cpSync(join(source, dir), nested, { recursive: true })
  f.node([join(nested, 'install.mjs'), '--if-checkout'])
  assert.equal(existsSync(hook), false)
})

test('a fresh clone activates the hook from the root npm postinstall', t => {
  const f = fixture(t, false)
  const postinstall = JSON.parse(readFileSync(join(source, 'package.json'))).scripts.postinstall
  f.write('package.json', JSON.stringify({ name: 'install-fixture', version: '1.0.0', scripts: { postinstall }, dependencies: { 'patch-package': 'file:vendor/fixture' } }))
  cpSync(join(source, 'scripts/postinstall.mjs'), join(f.root, 'scripts/postinstall.mjs'))
  // The lifecycle is real; unrelated native builds and package patching are inert in this fixture.
  f.write('scripts/build-sdk.mjs', '')
  f.write('vendor/fixture/package.json', JSON.stringify({ name: 'patch-package', version: '1.0.0', bin: 'noop.cjs' }))
  f.write('vendor/fixture/noop.cjs', '#!/usr/bin/env node\n')
  f.git('add', '--', 'package.json', 'scripts/postinstall.mjs', 'scripts/build-sdk.mjs', dir, 'vendor/fixture')
  f.commit('Create installation fixture')
  const clone = join(dirname(f.root), 'clone')
  f.git('clone', '--local', '-q', f.root, clone)
  f.run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts=false'], 0, clone, {
    HALO_SKIP_NATIVE_REBUILD: '1', npm_config_cache: join(dirname(f.root), 'npm-cache'), npm_config_update_notifier: 'false'
  })
  writeFileSync(join(clone, 'example.md'), `${secret}\n`)
  f.run('git', ['add', '--', 'example.md'], 0, clone)
  assert.match(f.run('git', ['commit', '-q', '-m', 'Example'], 1, clone), /example\.md {2}line 1 {2}looks like a credential \(value hidden\)/)
})
