import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getBetterSqlite3PrebuildPath,
  validateBetterSqlite3Prebuild,
} from '../../scripts/lib/better-sqlite3-prebuilds.mjs'

function withTemporaryDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-sqlite-prebuild-'))
  try {
    run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function darwinBinary(minimumMacOSMajor) {
  const data = Buffer.alloc(600 * 1024)
  data.writeUInt32LE(0xfeedfacf)
  data.writeUInt32LE(0x0100000c, 4)
  data.writeUInt32LE(1, 16)
  data.writeUInt32LE(24, 20)
  data.writeUInt32LE(0x32, 32)
  data.writeUInt32LE(24, 36)
  data.writeUInt32LE(1, 40)
  data.writeUInt32LE(minimumMacOSMajor << 16, 44)
  return data
}

function linuxBinary() {
  const data = Buffer.alloc(600 * 1024)
  data.write('7f454c46', 0, 'hex')
  data[4] = 2
  data[5] = 1
  data.writeUInt16LE(62, 18)
  return data
}

test('bundled prebuild paths select the platform without a legacy Electron ABI cache', () => {
  withTemporaryDirectory(root => {
    const current = getBetterSqlite3PrebuildPath(root, { platform: 'darwin', arch: 'arm64' })
    assert.equal(current, path.join(root, 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'))
    assert.notEqual(current, getBetterSqlite3PrebuildPath(root, { platform: 'darwin', arch: 'x64' }))
    assert.equal(
      getBetterSqlite3PrebuildPath(root, { platform: 'linux', arch: 'x64' }),
      path.join(root, 'node_modules/better-sqlite3/prebuilds/linux-x64.node'),
    )
  })
})

test('validation rejects a different native architecture and a truncated binary', () => {
  withTemporaryDirectory(root => {
    const binary = path.join(root, 'better_sqlite3.node')
    const data = darwinBinary(11)
    fs.writeFileSync(binary, data)
    assert.equal(validateBetterSqlite3Prebuild(binary, { platform: 'darwin', arch: 'arm64' }).valid, true)
    assert.equal(validateBetterSqlite3Prebuild(binary, { platform: 'darwin', arch: 'x64' }).valid, false)
    assert.equal(validateBetterSqlite3Prebuild(binary, { platform: 'linux', arch: 'x64' }).valid, false)
    fs.writeFileSync(binary, data.subarray(0, 20))
    assert.equal(validateBetterSqlite3Prebuild(binary, { platform: 'darwin', arch: 'arm64' }).valid, false)
  })
})

test('macOS prebuilds must not exceed the macOS 12 deployment floor', () => {
  withTemporaryDirectory(root => {
    const binary = path.join(root, 'better_sqlite3.node')
    fs.writeFileSync(binary, darwinBinary(13))
    const result = validateBetterSqlite3Prebuild(binary, { platform: 'darwin', arch: 'arm64' })
    assert.equal(result.valid, false)
    assert.match(result.reason, /exceeds baseline/)
  })
})

test('the stock Linux x64 prebuild is accepted by format alone', () => {
  withTemporaryDirectory(root => {
    const binary = path.join(root, 'linux-x64.node')
    fs.writeFileSync(binary, linuxBinary())
    assert.equal(validateBetterSqlite3Prebuild(binary, { platform: 'linux', arch: 'x64' }).valid, true)
    assert.equal(validateBetterSqlite3Prebuild(binary, { platform: 'win32', arch: 'x64' }).valid, false)
  })
})
