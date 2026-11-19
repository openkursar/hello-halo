'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// The Linux build is not distributed in upstream's npm package. Pin its bytes
// separately from the source package integrity recorded in package-lock.json.
const version = '1.1.0'
const sha256 = '7bbab3c5a20f7739480f38e737b0174b1cdf3906b7c879de8b3454331ab5fe3a'

function verifyLinuxPty(file, projectRoot) {
  const installed = JSON.parse(fs.readFileSync(path.join(projectRoot, 'node_modules/node-pty/package.json'), 'utf8'))
  if (installed.version !== version) throw new Error(`Linux PTY prebuild requires node-pty ${version}, found ${installed.version}`)
  const bytes = fs.readFileSync(file)
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== 62) {
    throw new Error('Linux PTY prebuild is not an x86-64 ELF shared object')
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Linux PTY prebuild SHA-256 mismatch')
}

module.exports = { verifyLinuxPty }
