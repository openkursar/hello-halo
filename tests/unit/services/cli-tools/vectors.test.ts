// Shared `halo.cli/1` contract vectors. The same files and expectations are
// checked by every server that validates uploads, so a change here is a
// contract change: regenerate with vectors/generate.mjs and copy the directory
// to every consumer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CliToolError, CliToolStore } from '../../../../src/main/services/cli-tools'
import { makeTempDir, removeTree } from './helpers'

interface Vector {
  file: string
  sha256: string
  note: string
  expect: { ok: true; id: string; version: string; integrity: string } | { error: string }
}

const VECTORS = join(__dirname, 'vectors')
const expected = JSON.parse(readFileSync(join(VECTORS, 'expected.json'), 'utf-8')) as {
  schema: string
  vectors: Vector[]
}
const silent = { log: () => undefined, error: () => undefined }

let dir: string

beforeEach(() => {
  dir = makeTempDir()
})

afterEach(() => {
  removeTree(dir)
})

describe('cli-tools shared contract vectors', () => {
  it('uses the vectors/1 layout and covers every error code', () => {
    expect(expected.schema).toBe('halo.cli.vectors/1')
    const codes = new Set(expected.vectors.map(v => ('error' in v.expect ? v.expect.error : 'OK')))
    expect([...codes].sort()).toEqual([
      'DIGEST_MISMATCH', 'MANIFEST_INVALID', 'NATIVE_NOT_ALLOWED', 'OK',
      'PACKAGE_INVALID', 'PATH_UNSAFE', 'RUNTIME_KIND_UNSUPPORTED',
    ])
  })

  it.each(expected.vectors.map(v => [v.file, v] as const))('%s', async (_name, vector) => {
    const file = join(VECTORS, vector.file)
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(vector.sha256)

    // A host that satisfies every package, so only package rules decide.
    const store = new CliToolStore({
      root: join(dir, 'cli'),
      runtimePath: process.execPath,
      runtimeNodeVersion: '24.0.0',
      platform: 'linux',
      arch: 'x64',
      log: silent,
    })
    let outcome: unknown
    try {
      const result = await store.importPackage(file, { source: 'user-import' })
      outcome = { ok: true, id: result.id, version: result.version, integrity: result.integrity }
    } catch (err) {
      outcome = { error: err instanceof CliToolError ? err.code : `NOT_TYPED: ${String(err)}` }
    }
    expect(outcome).toEqual(vector.expect)
  })
})
