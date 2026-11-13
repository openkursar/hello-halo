import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { signingEnvironment } = require('../../lib/mac-local-signing.cjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function verifyLocalNativeSignature(source, packagedBytes, entitlements) {
  if (process.platform !== 'darwin' || path.extname(source) !== '.node') return null
  const original = await fs.readFile(source)
  const magic = original.subarray(0, 4).toString('hex')
  if (!['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) return null
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'halo-native-signature-'))
  try {
    const candidate = path.join(directory, path.basename(source))
    await fs.writeFile(candidate, original, { mode: 0o700 })
    const env = signingEnvironment()
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlements, candidate],
      { env, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', candidate],
      { env, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
    const expected = await fs.readFile(candidate)
    if (!expected.equals(packagedBytes)) return null
    return { transformation: 'macos-local-adhoc', sourceBytes: original.length, sourceSha256: hash(original),
      signedBytes: expected.length, signedSha256: hash(expected), entitlementsSha256: hash(await fs.readFile(entitlements)) }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
