import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const script = readFileSync(new URL('../../scripts/build-server-halo.sh', import.meta.url), 'utf8')
const sdkEntry = 'node_modules/@hello-halo/agent-sdk/dist/worker/entry.js'
const setup = 'out/main/worker/halo-setup.cjs'
const check = script.match(/log "verifying packaged Halo worker launch files\.\.\."\nnode -e '([\s\S]*?)' dist\/linux-unpacked\/resources\/app\.asar/)[1]

// Without --config, electron-builder takes package.json#build and skips the
// shared config (product identity, runtime and worker unpack globs).
test('server packaging uses the shared config and never publishes', () => {
  assert.match(script, /electron-builder --linux dir --x64 --config electron-builder\.cjs --publish never/)
})

for (const scenario of [
  { name: 'rejects archived-only files', unpack: undefined, status: 1 },
  { name: 'rejects an archived setup with an unpacked worker', unpack: '**/entry.js', status: 1 },
  { name: 'rejects a missing physical setup file', unpack: '**/{entry.js,halo-setup.cjs}', removeSetup: true, status: 1 },
  { name: 'accepts unpacked files', unpack: '**/{entry.js,halo-setup.cjs}', status: 0 },
]) {
  test(`packaged Halo worker launch check ${scenario.name}`, async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'halo-server-sdk-package-'))
    try {
      const source = path.join(temp, 'source')
      for (const [file, content] of [
        ['node_modules/@hello-halo/agent-sdk/package.json', '{"name":"@hello-halo/agent-sdk"}'],
        [sdkEntry, '// worker'],
        [setup, '// setup'],
      ]) {
        const target = path.join(source, file)
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, content)
      }
      const archive = path.join(temp, 'app.asar')
      await asar.createPackageWithOptions(source, archive, { unpack: scenario.unpack })
      if (scenario.removeSetup) rmSync(path.join(archive + '.unpacked', setup))
      const result = spawnSync(process.execPath, ['-e', check, archive], {
        cwd: new URL('../..', import.meta.url), encoding: 'utf8',
      })
      assert.equal(result.status, scenario.status, result.stderr)
      if (scenario.status !== 0) assert.match(result.stderr, /Halo worker launch file is not unpacked|ENOENT/)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
}
