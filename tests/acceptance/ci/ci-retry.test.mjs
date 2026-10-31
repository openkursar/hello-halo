import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const retry = parse(fs.readFileSync(new URL('./acceptance-retry.yml', import.meta.url), 'utf8'))
const acceptance = parse(fs.readFileSync(new URL('./acceptance.yml', import.meta.url), 'utf8'))
const job = retry.jobs.retry
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const decide = new AsyncFunction('github', 'context', 'core', job.steps[0].with.script)

const record = (name, conclusion, steps) => ({ name, conclusion, steps: steps.map(([number, stepConclusion]) => ({ number, conclusion: stepConclusion })) })

async function decision(jobs) {
  const lookups = []
  const reruns = []
  const github = { rest: { actions: {
    listJobsForWorkflowRun: async request => { lookups.push(request); return { data: { jobs } } },
    reRunWorkflowFailedJobs: async request => { reruns.push(request) },
  } } }
  await decide(github, { repo: { owner: 'example', repo: 'controller' }, payload: { workflow_run: { id: 77, run_attempt: 1 } } }, { info() {} })
  return { lookups, reruns }
}

test('only a failed run of the acceptance workflow is considered, at most twice, on a hosted runner with narrow permissions', () => {
  assert.deepEqual(retry.on, { workflow_run: { workflows: [acceptance.name], types: ['completed'] } })
  assert.deepEqual(retry.permissions, { actions: 'write', contents: 'read' })
  assert.equal(job['runs-on'], 'ubuntu-latest')
  assert.match(job.if, /workflow_run\.conclusion == 'failure'/)
  assert.match(job.if, /workflow_run\.run_attempt < 3/)
  assert.equal(job.steps.length, 1)
  assert.equal(job.steps[0].with['github-token'], '${{ github.token }}')
  assert.equal(retry.env, undefined)
  assert.equal(job.env, undefined)
})

test('a run that could not set up its job, or lost its runner in the middle of a step, is started again', async () => {
  const setup = await decision([record('Verify private controller', 'success', []), record('acceptance', 'failure', [[1, 'failure']])])
  assert.deepEqual(setup.reruns, [{ owner: 'example', repo: 'controller', run_id: 77 }])
  assert.deepEqual(setup.lookups, [{ owner: 'example', repo: 'controller', run_id: 77, filter: 'latest', per_page: 100 }])
  const lost = await decision([record('acceptance', 'failure', [[1, 'success'], [2, 'success'], [3, null], [4, null]])])
  assert.equal(lost.reruns.length, 1)
})

test('a failure that came from the work itself is never started again', async () => {
  const build = await decision([record('acceptance', 'failure', [[1, 'success'], [2, 'failure'], [3, 'skipped'], [4, 'success']])])
  assert.deepEqual(build.reruns, [])
  const guard = await decision([record('Verify private controller', 'failure', [[1, 'success'], [2, 'failure']]), record('acceptance', 'skipped', [])])
  assert.deepEqual(guard.reruns, [])
  const stopped = await decision([record('acceptance', 'cancelled', [[1, 'success'], [2, 'cancelled']])])
  assert.deepEqual(stopped.reruns, [])
  const unstarted = await decision([record('acceptance', 'failure', [])])
  assert.deepEqual(unstarted.reruns, [])
})
