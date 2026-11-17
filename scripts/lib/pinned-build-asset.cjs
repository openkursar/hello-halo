'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')

function matches(file, sha256) {
  return fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256
}

function materializePinnedAsset({ destination, cacheDirectory, sha256, url }, download = (source, target) => {
  execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5', '--connect-timeout', '5', '--max-time', '15', '--max-filesize', '67108864', '--output', target, source], { timeout: 17000, stdio: 'pipe' })
}) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid pinned asset digest')
  fs.mkdirSync(cacheDirectory, { recursive: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const cached = path.join(cacheDirectory, sha256)
  if (!matches(cached, sha256)) {
    const temporary = path.join(cacheDirectory, `${sha256}.${randomUUID()}.tmp`)
    try {
      if (matches(destination, sha256)) fs.copyFileSync(destination, temporary)
      else download(url, temporary)
      if (!matches(temporary, sha256)) throw new Error(`Pinned asset checksum mismatch: ${path.basename(destination)}`)
      fs.renameSync(temporary, cached)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  if (!matches(destination, sha256)) fs.copyFileSync(cached, destination)
  if (!matches(destination, sha256)) throw new Error(`Materialized asset checksum mismatch: ${path.basename(destination)}`)
}

module.exports = { materializePinnedAsset }
