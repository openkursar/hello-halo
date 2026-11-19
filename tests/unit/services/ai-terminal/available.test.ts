/**
 * Tests for the terminal platform-availability gate.
 *
 * The gate must keep the feature out of the capability index / toolset menu /
 * transport on any platform whose node-pty prebuild is not packaged.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

async function availabilityFor(platform: NodeJS.Platform): Promise<boolean> {
  vi.resetModules()
  vi.doMock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>()
    return { ...actual, platform: () => platform }
  })
  const mod = await import('../../../../src/main/services/ai-terminal/available')
  return mod.isTerminalAvailable()
}

afterEach(() => {
  vi.doUnmock('os')
  vi.resetModules()
})

describe('isTerminalAvailable', () => {
  it('is available on macOS', async () => {
    expect(await availabilityFor('darwin')).toBe(true)
  })
  it('is available on Windows', async () => {
    expect(await availabilityFor('win32')).toBe(true)
  })
  it('is available on Linux', async () => {
    expect(await availabilityFor('linux')).toBe(true)
  })
  it('is NOT available on platforms without a packaged prebuild', async () => {
    expect(await availabilityFor('freebsd')).toBe(false)
  })
})
