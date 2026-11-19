import { createHash } from 'node:crypto'
import { redact } from './process.mjs'

const chunkBytes = 4 * 1024 * 1024
const maximumBytes = 256 * 1024 * 1024

export function evidenceChunks(value, root, environment = process.env) {
  const bytes = Buffer.from(redact(JSON.stringify(value), root, environment))
  if (bytes.length > maximumBytes) throw new Error('Structured evidence exceeds the bounded 256 MiB export budget')
  const count = Math.max(1, Math.ceil(bytes.length / chunkBytes))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const manifest = { version: 1, encoding: 'base64', byteLength: bytes.length, sha256, count, chunkBytes, redacted: true }
  function* chunks() {
    for (let index = 0; index < count; index++) {
      const part = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes)
      yield { index, byteLength: part.length, sha256: createHash('sha256').update(part).digest('hex'), data: part.toString('base64') }
    }
  }
  return { manifest, chunks }
}
