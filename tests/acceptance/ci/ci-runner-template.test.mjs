import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import plist from 'plist'

const directory = path.dirname(fileURLToPath(import.meta.url))
const template = fs.readFileSync(path.join(directory, 'macos-gui-runner.plist.template'), 'utf8')

test('the dedicated GUI runner template inherits the logged-in Aqua security session', () => {
  const data = plist.parse(template)
  assert.equal(data.SessionCreate, false)
  assert.equal(data.LimitLoadToSessionType, 'Aqua')
  assert.equal(data.ProcessType, 'Interactive')
  assert.equal(data.RunAtLoad, true)
  assert.equal(data.EnvironmentVariables.ACTIONS_RUNNER_SVC, '1')
})

test('the GUI template preserves official service placeholders without a machine-specific identity', () => {
  assert.deepEqual([...new Set(template.match(/\{\{[^}]+\}\}/g))].sort(), ['{{RunnerRoot}}', '{{SvcName}}', '{{UserHome}}', '{{User}}'])
  const substitutions = { RunnerRoot: '/example/runner', SvcName: 'actions.runner.example', UserHome: '/example/home', User: 'example-user' }
  const rendered = template.replace(/\{\{([^}]+)\}\}/g, (_match, name) => substitutions[name])
  const data = plist.parse(rendered)
  assert.equal(data.Label, substitutions.SvcName)
  assert.equal(data.UserName, substitutions.User)
  assert.equal(data.WorkingDirectory, substitutions.RunnerRoot)
  assert.deepEqual(data.ProgramArguments, ['/example/runner/runsvc.sh'])
  assert.equal(data.StandardOutPath, '/example/home/Library/Logs/actions.runner.example/stdout.log')
  assert.equal(data.StandardErrorPath, '/example/home/Library/Logs/actions.runner.example/stderr.log')
})
