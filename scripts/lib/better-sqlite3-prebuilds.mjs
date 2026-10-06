import fs from 'node:fs'
import path from 'node:path'
import machoDeployment from './macho-deployment-target.cjs'

const { validateMacOSDeploymentTarget } = machoDeployment

export const BETTER_SQLITE3_TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
  win: { platform: 'win32', arch: 'x64' },
  linux: { platform: 'linux', arch: 'x64' },
}

export function getBetterSqlite3PrebuildPath(projectRoot, target) {
  return path.join(projectRoot, 'node_modules/better-sqlite3/prebuilds', `${target.platform}-${target.arch}.node`)
}

export function validateBetterSqlite3Prebuild(filePath, target) {
  if (!fs.existsSync(filePath)) return { exists: false, valid: false, reason: 'missing' }
  const size = fs.statSync(filePath).size
  if (size <= 500 * 1024) return { exists: true, valid: false, size, reason: 'too small' }
  const fd = fs.openSync(filePath, 'r')
  try {
    const header = Buffer.alloc(64)
    fs.readSync(fd, header, 0, header.length, 0)
    let matches = false
    if (target.platform === 'darwin') {
      const cpu = target.arch === 'arm64' ? 0x0100000c : 0x01000007
      matches = header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === cpu
    } else if (target.platform === 'linux') {
      matches = header.subarray(0, 4).toString('hex') === '7f454c46' &&
        header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62
    } else if (target.platform === 'win32') {
      const signature = Buffer.alloc(6)
      fs.readSync(fd, signature, 0, signature.length, header.readUInt32LE(0x3c))
      matches = header.subarray(0, 2).toString() === 'MZ' &&
        signature.readUInt32LE(0) === 0x00004550 && signature.readUInt16LE(4) === 0x8664
    }
    if (!matches) return { exists: true, valid: false, size, reason: `format mismatch for ${target.platform}-${target.arch}` }
    if (target.platform === 'darwin') {
      return { exists: true, size, ...validateMacOSDeploymentTarget(filePath) }
    }
    return { exists: true, valid: true, size }
  } finally {
    fs.closeSync(fd)
  }
}
