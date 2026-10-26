import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { prerequisiteFailures } from '../../../scripts/acceptance/lib/execution.mjs'

async function trackProbeDirectories(context) {
  const directories = []
  const create = fs.mkdtemp.bind(fs)
  context.mock.method(fs, 'mkdtemp', async (...args) => {
    const directory = await create(...args)
    directories.push(directory)
    return directory
  })
  context.after(async () => {
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true })
  })
  return directories
}

test('file-link readiness probes the host without retaining its temporary files', async context => {
  const directories = await trackProbeDirectories(context)
  const problems = await prerequisiteFailures(process.cwd(), { requirements: ['file-symlinks'] })
  if (process.platform !== 'win32') assert.deepEqual(problems, [])
  else assert(problems.length === 0 || problems.every(problem => /File symbolic-link creation and reading are unavailable/.test(problem)))
  assert.equal(directories.length, 1)
  await assert.rejects(fs.access(directories[0]), { code: 'ENOENT' })
})

test('a denied file-link operation becomes an explicit prerequisite failure and still cleans its probe', async context => {
  const directories = await trackProbeDirectories(context)
  context.mock.method(fs, 'symlink', async () => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }) })
  const problems = await prerequisiteFailures(process.cwd(), { requirements: ['file-symlinks'] })
  assert.deepEqual(problems, ['File symbolic-link creation and reading are unavailable (EPERM)'])
  assert.equal(directories.length, 1)
  await assert.rejects(fs.access(directories[0]), { code: 'ENOENT' })
})
