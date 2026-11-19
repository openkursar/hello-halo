const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { verifyLinuxPty } = require('../../scripts/lib/node-pty-prebuild.cjs')

const root = path.resolve(__dirname, '../..')
const input = path.join(root, 'resources/prebuilds/node-pty/linux-x64/pty.node')

test('Linux PTY matches its pinned npm version, architecture and digest', () => {
  verifyLinuxPty(input, root)
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-prebuild-'))
  try {
    const file = path.join(fixture, 'pty.node')
    const bytes = fs.readFileSync(input)
    assert.throws(() => verifyLinuxPty(file, root), /ENOENT/)
    bytes[bytes.length - 1] ^= 1
    fs.writeFileSync(file, bytes)
    assert.throws(() => verifyLinuxPty(file, root), /SHA-256/)
    bytes.writeUInt16LE(183, 18)
    fs.writeFileSync(file, bytes)
    assert.throws(() => verifyLinuxPty(file, root), /x86-64/)
    const manifest = path.join(fixture, 'node_modules/node-pty/package.json')
    fs.mkdirSync(path.dirname(manifest), { recursive: true })
    fs.writeFileSync(manifest, JSON.stringify({ version: '0.0.0' }))
    assert.throws(() => verifyLinuxPty(input, fixture), /version|requires node-pty/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
