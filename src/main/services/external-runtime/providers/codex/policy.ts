// Builds signed before 2026-05-12, including 0.128.0, carry a signing certificate revoked on 2026-06-30; macOS kills them at launch.
export const RECOMMENDED_VERSION = '0.132.0'

export const CODEX_PLATFORMS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', triple: 'x86_64-apple-darwin' },
  'linux-x64': { os: 'linux', cpu: 'x64', triple: 'x86_64-unknown-linux-musl' },
  'win32-x64': { os: 'win32', cpu: 'x64', triple: 'x86_64-pc-windows-msvc' }
} as const

export type CodexPlatform = keyof typeof CODEX_PLATFORMS

// Official registry payload metadata checked on 2026-11-17; these pins do not assert behavioral verification.
export const RECOMMENDED_INTEGRITY: Record<CodexPlatform, string> = {
  'darwin-arm64': 'sha512-EVD6XaKSN4fD7Z9HrQIjOFFLbL6cu1PWA6a2hzFwMomAjHlZelGOLtS4faFWOmLUZnO7TYtnJJXk8VNfdGqefg==',
  'darwin-x64': 'sha512-RGaiBLwM9UkuB0tOHXjhwTJzMi/FCk/TQaKai97WIodIrvmRzL+j43hqVsXMV8jjYxTFwdyYooGMmCI7cQbKXw==',
  'linux-x64': 'sha512-aGJPB+QkgtYQNQMlRGmE7oZstULu7k4trpux5r3CCZGPun4Xtwx3swtZXm7cWOVeTUkNfGCqdtCQ0bv6SKRiLA==',
  'win32-x64': 'sha512-TnAoOBWbFSCqR+4AkgwSKOVQJtGUdBCqROOEyAKylbIug55xzrLPLNQ7Mnd9l1yFIUnU2NqvPeHtIYqGImzCqA=='
}

export function requiredComponents(platform: CodexPlatform): string[] {
  const prefix = `vendor/${CODEX_PLATFORMS[platform].triple}`
  return platform === 'win32-x64'
    ? [`${prefix}/codex/codex.exe`, `${prefix}/codex/codex-windows-sandbox-setup.exe`, `${prefix}/codex/codex-command-runner.exe`, `${prefix}/path/rg.exe`]
    : [`${prefix}/codex/codex`, `${prefix}/path/rg`]
}

// Executables a release may ship beside the CLI; Linux builds since 0.129.0 bundle bubblewrap for the sandbox.
export function optionalComponents(platform: CodexPlatform): string[] {
  return platform === 'linux-x64' ? [`vendor/${CODEX_PLATFORMS[platform].triple}/codex-resources/bwrap`] : []
}
