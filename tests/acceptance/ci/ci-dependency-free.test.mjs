import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const builtins = new Set(builtinModules)
const specifier = /(?:\bimport\s+(?:[^'"()]*?\s+from\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*|\bexport\s+[^'"]*?\s+from\s+)['"]([^'"]+)['"]/g

function closure(entry) {
  const seen = new Set(), outside = []
  const visit = file => {
    if (seen.has(file)) return
    seen.add(file)
    for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(specifier)) {
      if (name.startsWith('.')) visit(path.resolve(path.dirname(file), name))
      else if (!name.startsWith('node:') && !builtins.has(name.split('/')[0])) outside.push(`${path.relative(root, file)} imports ${name}`)
    }
  }
  visit(entry)
  return outside
}

// These run before dependencies are installed or after their installation failed; a package import would hide the failure behind a module error.
for (const name of ['ci-state', 'ci-prepare', 'ci-run', 'ci-finalize', 'ci-archive']) {
  test(`${name} and everything it loads need no installed package`, () => {
    assert.deepEqual(closure(path.join(root, 'scripts/acceptance', `${name}.mjs`)), [])
  })
}

test('the check sees a package import', () => {
  const file = path.join(root, 'scripts/acceptance/lib/catalog.mjs')
  assert(closure(file).some(entry => entry.endsWith(' imports yaml')))
})
