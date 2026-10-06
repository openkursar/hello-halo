import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import deployment from '../../scripts/lib/macho-deployment-target.cjs'

const { inspectMachO, validateMacOSDeploymentTarget, assertMacOSDeploymentTargets } = deployment

function thin({ minimum = 12 << 16, cpu = 0x0100000c, modern = true, little = true, platform = 1 } = {}) {
  const data = Buffer.alloc(96)
  const write = (value, offset) => little ? data.writeUInt32LE(value, offset) : data.writeUInt32BE(value, offset)
  write(0xfeedfacf, 0)
  write(cpu, 4)
  write(1, 16)
  write(modern ? 24 : 16, 20)
  write(modern ? 0x32 : 0x24, 32)
  write(modern ? 24 : 16, 36)
  write(modern ? platform : minimum, 40)
  write(modern ? minimum : 15 << 16, 44)
  return data
}

function universal(slices, wide = false) {
  const entrySize = wide ? 32 : 20
  const start = 8 + entrySize * slices.length
  const buffer = Buffer.alloc(start + slices.length * 96)
  buffer.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0)
  buffer.writeUInt32BE(slices.length, 4)
  slices.forEach((slice, index) => {
    const entry = 8 + index * entrySize
    buffer.writeUInt32BE(slice.readUInt32LE(4), entry)
    if (wide) {
      buffer.writeBigUInt64BE(BigInt(start + index * 96), entry + 8)
      buffer.writeBigUInt64BE(96n, entry + 16)
    } else {
      buffer.writeUInt32BE(start + index * 96, entry + 8)
      buffer.writeUInt32BE(96, entry + 12)
    }
    slice.copy(buffer, start + index * 96)
  })
  return buffer
}

function withBinary(data, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-macho-target-'))
  const file = path.join(directory, 'binary')
  try {
    fs.writeFileSync(file, data)
    run(file, directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('modern and legacy commands read deployment target rather than build SDK', () => {
  for (const modern of [true, false]) for (const little of [true, false]) {
    withBinary(thin({ modern, little }), file => {
      assert.equal(validateMacOSDeploymentTarget(file).valid, true)
      assert.equal(inspectMachO(file).slices[0].minimumMacOS, '12.0.0')
    })
  }
})

test('every universal architecture must support the baseline', () => {
  for (const wide of [false, true]) {
    withBinary(universal([thin(), thin({ cpu: 0x01000007, minimum: 15 << 16 })], wide), file => {
      const result = validateMacOSDeploymentTarget(file)
      assert.equal(result.slices.length, 2)
      assert.equal(result.valid, false)
      assert.match(result.reason, /15\.0\.0.*x64/)
    })
    withBinary(universal([thin(), thin({ cpu: 0x01000007 })], wide), file => assert.equal(validateMacOSDeploymentTarget(file).valid, true))
  }
})

test('non-macOS, zero and absent deployment commands cannot pass', () => {
  for (const data of [thin({ platform: 2 }), thin({ minimum: 0 })]) {
    withBinary(data, file => assert.equal(validateMacOSDeploymentTarget(file).valid, false))
  }
  const data = thin()
  data.writeUInt32LE(0, 16)
  data.writeUInt32LE(0, 20)
  withBinary(data, file => assert.equal(validateMacOSDeploymentTarget(file).valid, false))
})

test('malformed native files fail instead of inheriting a partial target', () => {
  const shortCommand = thin()
  shortCommand.writeUInt32LE(8, 36)
  const wrongCount = thin()
  wrongCount.writeUInt32LE(2, 16)
  const wrongCpu = universal([thin()])
  wrongCpu.writeUInt32BE(0x01000007, 8)
  for (const data of [shortCommand, wrongCount, wrongCpu, thin().subarray(0, 40)]) {
    withBinary(data, file => assert.throws(() => inspectMachO(file), /Mach-O/))
  }
})

test('the artifact gate checks all native resources without following symlinks or Java classes', () => {
  withBinary(thin(), (file, directory) => {
    fs.mkdirSync(path.join(directory, 'nested'))
    fs.writeFileSync(path.join(directory, 'nested', 'unsupported'), thin({ minimum: 15 << 16 }))
    fs.writeFileSync(path.join(directory, 'Ignored.class'), universal([thin({ minimum: 15 << 16 })]))
    fs.symlinkSync(directory, path.join(directory, 'cycle'), 'dir')
    assert.throws(() => assertMacOSDeploymentTargets(directory), /nested.*unsupported.*15\.0\.0/)
    fs.rmSync(path.join(directory, 'nested', 'unsupported'))
    assert.equal(assertMacOSDeploymentTargets(directory).length, 1)
    assert.equal(validateMacOSDeploymentTarget(file).valid, true)
  })
})

test('a declared helper floor applies to that binary only and must match a scanned file', () => {
  withBinary(thin(), (file, directory) => {
    const helper = path.join(directory, 'helper')
    fs.writeFileSync(helper, thin({ minimum: 15 << 16 }))
    assert.throws(() => assertMacOSDeploymentTargets(directory), /helper.*15\.0\.0/)
    assert.equal(assertMacOSDeploymentTargets(directory, undefined, { [helper]: '15.0.0' }).length, 2)

    fs.writeFileSync(helper, thin({ minimum: 16 << 16 }))
    assert.throws(() => assertMacOSDeploymentTargets(directory, undefined, { [helper]: '15.0.0' }), /16\.0\.0 exceeds baseline 15\.0\.0/)

    fs.writeFileSync(file, thin({ minimum: 15 << 16 }))
    fs.writeFileSync(helper, thin())
    assert.throws(() => assertMacOSDeploymentTargets(directory, undefined, { [helper]: '15.0.0' }), /binary.*15\.0\.0 exceeds baseline 12\.0\.0/)

    assert.throws(
      () => assertMacOSDeploymentTargets(directory, undefined, { [path.join(directory, 'absent')]: '15.0.0' }),
      /declared floors match no binary/,
    )
  })
})
