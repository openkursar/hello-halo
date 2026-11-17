import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { evidenceChunks } from '../../../scripts/acceptance/lib/evidence-chunks.mjs'

test('large exchanges export below attachment limits and reassemble complete redacted UTF-8 evidence', () => {
  const secret = 'private-credential-value'
  const input = { exchanges: [{ text: '中😀'.repeat(3000000), authorization: `Bearer ${secret}` }], errors: [] }
  const result = evidenceChunks(input, '/controlled/repository', { API_KEY: secret })
  const chunks = [...result.chunks()]
  assert(chunks.length > 4)
  const bytes = chunks.map((chunk, index) => {
    assert.equal(chunk.index, index)
    assert(Buffer.byteLength(JSON.stringify(chunk)) < 8 * 1024 * 1024)
    const bytes = Buffer.from(chunk.data, 'base64')
    assert(bytes.length <= 4 * 1024 * 1024)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.sha256)
    return bytes
  })
  const joined = Buffer.concat(bytes)
  assert.equal(joined.length, result.manifest.byteLength)
  assert.equal(createHash('sha256').update(joined).digest('hex'), result.manifest.sha256)
  assert.equal(result.manifest.count, chunks.length)
  const decoded = joined.toString('utf8')
  assert(!decoded.includes(secret))
  const restored = JSON.parse(decoded)
  assert.equal(restored.exchanges[0].text, input.exchanges[0].text)
  assert.match(restored.exchanges[0].authorization, /REDACTED/)
})

test('the total evidence budget is enforced rather than silently truncating an exchange', () => {
  assert.throws(() => evidenceChunks({ text: 'x'.repeat(256 * 1024 * 1024) }, '/repository', {}), /bounded 256 MiB/)
})
