/**
 * Unit tests for src/main/store/dhpkg/{pack,unpack}
 *
 * Coverage:
 *   - Pack → unpack roundtrip preserves spec + files
 *   - Reject archive without spec.yaml
 *   - Reject archive that exceeds the size cap
 *   - Reject zip-slip path entries
 *   - Reject invalid spec content
 */

import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { pack } from '../../../src/main/store/dhpkg/pack'
import { unpack, MAX_UNPACK_BYTES, MAX_UNPACK_DECOMPRESSED_BYTES } from '../../../src/main/store/dhpkg/unpack'
import type { AppSpec } from '../../../src/main/apps/spec/schema'

function testSpec(overrides?: Partial<AppSpec>): AppSpec {
  return {
    spec_version: '1',
    name: 'dhpkg-test',
    version: '1.0.0',
    author: 'Tester',
    description: 'roundtrip',
    type: 'skill',
    skill_files: { 'SKILL.md': '# hello\n' },
    ...overrides,
  } as AppSpec
}

describe('dhpkg pack/unpack', () => {
  it('roundtrips a skill spec with files', async () => {
    const original = testSpec()
    const buf = await pack(original, { 'SKILL.md': '# hello\n', 'extras/log.txt': 'log\n' })
    const { spec, files } = await unpack(buf)

    expect(spec.name).toBe('dhpkg-test')
    expect(spec.type).toBe('skill')
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', 'extras/log.txt'])
    expect(files['SKILL.md'].toString('utf-8')).toBe('# hello\n')
    expect(files['extras/log.txt'].toString('utf-8')).toBe('log\n')
  })

  it('rejects an archive missing spec.yaml', async () => {
    const bogus = zipSync({ 'README.md': strToU8('no spec') })
    await expect(unpack(Buffer.from(bogus))).rejects.toThrow(/missing spec.yaml/)
  })

  it('rejects an archive whose spec.yaml fails schema validation', async () => {
    const bogus = zipSync({
      'spec.yaml': strToU8('name: only-name\n'), // missing required fields
    })
    await expect(unpack(Buffer.from(bogus))).rejects.toThrow(/Invalid spec.yaml/)
  })

  it('rejects archives larger than the size cap', async () => {
    // Synthesize a buffer larger than the cap (we never actually try to unzip it)
    const oversize = Buffer.alloc(MAX_UNPACK_BYTES + 1)
    await expect(unpack(oversize)).rejects.toThrow(/Archive too large/)
  })

  it('rejects archives that decompress past the cap (zip-bomb)', async () => {
    // A small compressed archive can still inflate to gigabytes. Zeros are
    // highly compressible, so a single over-cap entry stays tiny on disk but
    // declares a huge uncompressed size in the central directory — exactly the
    // case the unzip filter must reject before allocating it.
    const bomb = zipSync({
      'spec.yaml': strToU8(
        'spec_version: "1"\nname: ok\nversion: 1.0.0\nauthor: a\ndescription: d\ntype: skill\nskill_files: {}\n'
      ),
      'big.bin': new Uint8Array(MAX_UNPACK_DECOMPRESSED_BYTES + 1),
    })
    expect(bomb.byteLength).toBeLessThan(MAX_UNPACK_BYTES)
    await expect(unpack(Buffer.from(bomb))).rejects.toThrow(/decompresses too large/)
  })

  it('rejects unsafe path entries (zip-slip)', async () => {
    const evil = zipSync({
      'spec.yaml': strToU8(
        'spec_version: "1"\nname: ok\nversion: 1.0.0\nauthor: a\ndescription: d\ntype: skill\nskill_files: {}\n'
      ),
      '../../etc/passwd': strToU8('pwned'),
    })
    await expect(unpack(Buffer.from(evil))).rejects.toThrow(/unsafe archive entry/)
  })
})
