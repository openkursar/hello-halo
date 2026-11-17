'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { materializePinnedAsset } = require('../../scripts/lib/pinned-build-asset.cjs')

test('verified content cache survives clean output and repairs corrupt output without network', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-pinned-asset-'))
  const bytes = Buffer.from('pinned-font')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const options = { destination: path.join(root, 'output', 'font.otf'), cacheDirectory: path.join(root, 'cache'), sha256, url: 'https://fixture.invalid/font' }
  let downloads = 0
  try {
    materializePinnedAsset(options, (_url, target) => { downloads++; fs.writeFileSync(target, bytes) })
    fs.rmSync(path.dirname(options.destination), { recursive: true })
    materializePinnedAsset(options, () => { throw new Error('offline') })
    fs.writeFileSync(options.destination, 'corrupt')
    materializePinnedAsset(options, () => { throw new Error('offline') })
    assert.equal(downloads, 1)
    assert.deepEqual(fs.readFileSync(options.destination), bytes)
    fs.writeFileSync(path.join(options.cacheDirectory, sha256), 'corrupt')
    fs.unlinkSync(options.destination)
    assert.throws(() => materializePinnedAsset(options, (_url, target) => fs.writeFileSync(target, 'bad')), /checksum mismatch/)
    assert.ok(!fs.existsSync(options.destination))
    assert.ok(!fs.readdirSync(options.cacheDirectory).some(name => name.endsWith('.tmp')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
