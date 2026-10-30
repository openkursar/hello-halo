import { describe, expect, it } from 'vitest'
import { getVerifiedVersionsForPlatform, isRecommendedVersion, isVerifiedRuntime } from '../../../src/main/services/cc-runtime/policy'

describe('CC release verification evidence', () => {
  it('limits verified claims to the tested platform, architecture and distribution', () => {
    expect(isVerifiedRuntime('2.1.89', 'javascript', 'darwin', 'arm64')).toBe(true)
    expect(isVerifiedRuntime('2.1.89', 'native', 'darwin', 'arm64')).toBe(true)
    expect(isVerifiedRuntime('2.1.310', 'native', 'darwin', 'arm64')).toBe(true)
    expect(isVerifiedRuntime('2.1.310', 'javascript', 'darwin', 'arm64')).toBe(false)
    expect(isVerifiedRuntime('2.1.310', 'native', 'darwin', 'x64')).toBe(false)
    expect(isVerifiedRuntime('2.1.310', 'native', 'win32', 'arm64')).toBe(false)
    expect(isVerifiedRuntime('2.1.310', 'native', 'linux', 'arm64')).toBe(false)
    expect(isVerifiedRuntime('2.1.311', 'native', 'darwin', 'arm64')).toBe(false)
  })

  it('lists only locally verified releases without conflating the recommended range', () => {
    expect(getVerifiedVersionsForPlatform('darwin', 'arm64')).toEqual(['2.1.89', '2.1.310'])
    expect(getVerifiedVersionsForPlatform('win32', 'x64')).toEqual([])
    expect(getVerifiedVersionsForPlatform('linux', 'x64')).toEqual([])
    expect(isRecommendedVersion('2.1.310')).toBe(true)
    expect(isRecommendedVersion('2.1.311')).toBe(true)
  })
})
