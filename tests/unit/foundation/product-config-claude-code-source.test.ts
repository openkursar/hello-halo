/**
 * The Claude Code download source a build declares in product.json, read
 * without throwing whatever shape it was written in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const env = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({ app: { getAppPath: () => env.root, isPackaged: true } }))

async function sourceFor(product: Record<string, unknown>) {
  writeFileSync(join(env.root, 'product.json'), JSON.stringify({ authProviders: [], ...product }))
  vi.resetModules()
  const { getClaudeCodeDownloadSource } = await import('../../../src/main/foundation/product-config')
  return getClaudeCodeDownloadSource()
}

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'halo-product-config-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(env.root, { recursive: true, force: true })
})

describe('getClaudeCodeDownloadSource', () => {
  it('has none unless the build declares one', async () => {
    expect(await sourceFor({})).toBeUndefined()
    expect(await sourceFor({ claudeCodeDownloadSource: { baseUrl: '  ' } })).toBeUndefined()
  })

  it('reads the declared address and name', async () => {
    expect(await sourceFor({ claudeCodeDownloadSource: { name: ' Mirror ', baseUrl: ' http://mirror.example.com/cc ' } }))
      .toEqual({ name: 'Mirror', baseUrl: 'http://mirror.example.com/cc' })
  })

  it('passes on an address that is not text for the reader to refuse, instead of throwing', async () => {
    expect(await sourceFor({ claudeCodeDownloadSource: { baseUrl: 42, name: 7 } })).toEqual({ baseUrl: '42' })
    expect(await sourceFor({ claudeCodeDownloadSource: 'http://mirror.example.com' })).toBeUndefined()
  })
})
