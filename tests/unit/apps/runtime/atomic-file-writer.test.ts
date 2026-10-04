/**
 * Unit tests for apps/runtime/atomic-file-writer.ts — writes requested while
 * another is in flight must never interleave into a torn file, the last
 * content requested is what ends up on disk, and a target briefly held by
 * another process is retried rather than given up.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { rename } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { AtomicFileWriter } from '../../../../src/main/apps/runtime/atomic-file-writer'

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

function busy(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code })
}

async function settle(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('AtomicFileWriter', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-writer-'))
    file = join(dir, 'nested', 'data.json')
  })

  afterEach(async () => {
    await settle()
    vi.mocked(rename).mockClear()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lands the newest content when writes overlap, long then short', async () => {
    const writer = new AtomicFileWriter(file, '[Test]')
    const long = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(40) })))
    const short = JSON.stringify([{ i: 0 }])
    writer.write(long)
    writer.write(JSON.stringify([{ i: 1 }, { i: 2 }]))
    writer.write(short)
    await settle()
    expect(readFileSync(file, 'utf8')).toBe(short)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['data.json'])
  })

  it('keeps a synchronous write over one still in flight', async () => {
    const writer = new AtomicFileWriter(file, '[Test]')
    writer.write('"background"')
    writer.writeSync('"final"')
    await settle()
    expect(readFileSync(file, 'utf8')).toBe('"final"')
    expect(readdirSync(join(dir, 'nested'))).toEqual(['data.json'])
  })

  it('retries a target held by another process, keeping the old file whole meanwhile', async () => {
    mkdirSync(join(dir, 'nested'))
    writeFileSync(file, '"old"')
    vi.mocked(rename).mockRejectedValueOnce(busy('EPERM')).mockRejectedValueOnce(busy('EBUSY'))
    const writer = new AtomicFileWriter(file, '[Test]')
    writer.write('"new"')

    await settle(200)
    expect(readFileSync(file, 'utf8')).toBe('"old"')
    await settle(500)
    expect(readFileSync(file, 'utf8')).toBe('"new"')
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(3)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['data.json'])
  })

  it('writes newer content handed in during a retry instead of retrying the older', async () => {
    vi.mocked(rename).mockRejectedValueOnce(busy('EPERM'))
    const writer = new AtomicFileWriter(file, '[Test]')
    writer.write('"first"')
    await settle(20)
    writer.write('"second"')

    await settle(300)
    expect(readFileSync(file, 'utf8')).toBe('"second"')
    // The failed first attempt, then the second content; "first" is never retried.
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(2)
  })

  it('gives up at once on an error a retry cannot fix', async () => {
    vi.mocked(rename).mockRejectedValueOnce(busy('EXDEV'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const writer = new AtomicFileWriter(file, '[Test]')
    writer.write('"lost"')
    await settle()
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
