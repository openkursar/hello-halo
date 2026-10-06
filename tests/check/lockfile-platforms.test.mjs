import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'))

function resolutionCandidates(parent, name) {
  const candidates = []
  let directory = parent
  while (directory && directory !== '.') {
    if (path.posix.basename(directory) !== 'node_modules') candidates.push(`${directory}/node_modules/${name}`)
    directory = path.posix.dirname(directory)
  }
  candidates.push(`node_modules/${name}`)
  return candidates
}

test('exact optional dependencies are locked for every platform', () => {
  const missing = []
  for (const [parent, metadata] of Object.entries(lock.packages)) {
    for (const [name, version] of Object.entries(metadata.optionalDependencies ?? {})) {
      if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) continue
      if (!resolutionCandidates(parent, name).some(candidate => lock.packages[candidate]?.version === version)) {
        missing.push(`${parent}: ${name}@${version}`)
      }
    }
  }
  assert.deepEqual(missing, [], 'Host-only npm lockfiles break clean Windows and Linux installs')
})
