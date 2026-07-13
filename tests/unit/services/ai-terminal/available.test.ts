/**
 * Tests for the terminal platform-availability gate.
 *
 * Linux desktop is intentionally excluded (node-pty prebuilds not packaged);
 * the gate must keep the feature out of the capability index / toolset menu /
 * transport there. macOS and Windows are supported.
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
  it('is NOT available on Linux (prebuilds excluded)', async () => {
    expect(await availabilityFor('linux')).toBe(false)
  })
})
