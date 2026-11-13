import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { verifyLocalNativeSignature } from '../../../scripts/acceptance/lib/native-signature.mjs'

const require = createRequire(import.meta.url)
const { signingEnvironment } = require('../../../scripts/lib/mac-local-signing.cjs')

test('local native identity accepts the exact signing transformation and rejects changed signed code', { skip: process.platform !== 'darwin' }, async context => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'halo-native-signature-test-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source', 'fixture.node')
  const signed = path.join(directory, 'signed', 'fixture.node')
  const different = path.join(directory, 'different', 'fixture.node')
  const entitlements = path.join(directory, 'entitlements.plist')
  await fs.writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>')
  for (const [file, executable] of [[source, '/usr/bin/true'], [signed, '/usr/bin/true'], [different, '/usr/bin/false']]) {
    await fs.mkdir(path.dirname(file))
    await fs.copyFile(executable, file)
    await fs.chmod(file, 0o700)
  }
  const env = signingEnvironment()
  for (const file of [signed, different]) {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlements, file], { env, stdio: 'pipe' })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { env, stdio: 'pipe' })
  }
  const original = await fs.readFile(source)
  const packaged = await fs.readFile(signed)
  assert.notDeepEqual(original, packaged)
  const identity = await verifyLocalNativeSignature(source, packaged, entitlements)
  assert.equal(identity.transformation, 'macos-local-adhoc')
  assert.equal(identity.sourceBytes, original.length)
  assert.equal(identity.signedBytes, packaged.length)
  assert.notEqual(identity.sourceSha256, identity.signedSha256)
  assert.equal(await verifyLocalNativeSignature(source, await fs.readFile(different), entitlements), null)
  const corrupted = Buffer.from(packaged)
  corrupted[corrupted.length - 1] ^= 1
  assert.equal(await verifyLocalNativeSignature(source, corrupted, entitlements), null)
  assert.deepEqual(await fs.readFile(source), original)
})

test('non-native SDK payloads cannot enter the signing exception', async context => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'halo-native-signature-text-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'fixture.node')
  await fs.writeFile(file, 'SDK runtime code')
  assert.equal(await verifyLocalNativeSignature(file, Buffer.from('changed code'), '/missing/entitlements'), null)
})
