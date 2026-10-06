/**
 * Where a build gets its holiday calendar: the public one unless product.json
 * names its own, and none at all when it names an empty address.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const env = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({ app: { getAppPath: () => env.root, isPackaged: true } }))

async function urlFor(product: Record<string, unknown>): Promise<string | undefined> {
  writeFileSync(join(env.root, 'product.json'), JSON.stringify({ authProviders: [], ...product }))
  vi.resetModules()
  const { getWorkdayCalendarUrl } = await import('../../../src/main/foundation/product-config')
  return getWorkdayCalendarUrl()
}

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'halo-product-config-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(env.root, { recursive: true, force: true })
})

describe('getWorkdayCalendarUrl', () => {
  it('uses the public calendar when the build names none', async () => {
    expect(await urlFor({})).toMatch(/^https:\/\/.+\.ics$/)
  })

  it('uses the address the build names', async () => {
    expect(await urlFor({ workdayCalendarUrl: ' https://intranet.example/holidays/cn.ics ' })).toBe('https://intranet.example/holidays/cn.ics')
  })

  it('provides no calendar when the build names an empty address', async () => {
    expect(await urlFor({ workdayCalendarUrl: '' })).toBeUndefined()
  })
})
