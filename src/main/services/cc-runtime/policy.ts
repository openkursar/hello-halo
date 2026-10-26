import type { CcDownloadSource } from '../../../shared/types/cc-runtime'

export const RECOMMENDED_RANGE = '>=2.1.89 <2.2.0'
export const RECOMMENDED_VERSION = '2.1.310'
export const MINIMUM_VERSION = '2.1.89'
const VERIFIED_RELEASES = [
  { platform: 'darwin', arch: 'arm64', kind: 'native', versions: ['2.1.89', '2.1.310'] },
  { platform: 'darwin', arch: 'arm64', kind: 'javascript', versions: ['2.1.89'] }
] as const

export function getVerifiedVersionsForPlatform(platform: string = process.platform, arch: string = process.arch): string[] {
  return [...new Set(VERIFIED_RELEASES.filter(item => item.platform === platform && item.arch === arch).flatMap(item => [...item.versions]))]
}

export function isVerifiedRuntime(version: string, kind: 'native' | 'javascript', platform: string = process.platform, arch: string = process.arch): boolean {
  return VERIFIED_RELEASES.some(item => item.platform === platform && item.arch === arch && item.kind === kind && (item.versions as readonly string[]).includes(version))
}
export const OFFICIAL_SOURCE: CcDownloadSource = {
  id: 'official',
  name: 'Anthropic',
  baseUrl: 'https://downloads.claude.ai/claude-code-releases'
}
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function compareVersion(left: string, right: string): number {
  const a = left.split(/[.-]/).slice(0, 3).map(Number)
  const b = right.split(/[.-]/).slice(0, 3).map(Number)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function isRecommendedVersion(version: string): boolean {
  return !version.includes('-') && compareVersion(version, MINIMUM_VERSION) >= 0 && compareVersion(version, '2.2.0') < 0
}
