export const RECOMMENDED_VERSION = '0.128.0'

export const CODEX_PLATFORMS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', triple: 'x86_64-apple-darwin' },
  'linux-x64': { os: 'linux', cpu: 'x64', triple: 'x86_64-unknown-linux-musl' },
  'win32-x64': { os: 'win32', cpu: 'x64', triple: 'x86_64-pc-windows-msvc' }
} as const

export type CodexPlatform = keyof typeof CODEX_PLATFORMS

// Official registry payload metadata checked on 2026-11-16; these pins do not assert behavioral verification.
export const RECOMMENDED_INTEGRITY: Record<CodexPlatform, string> = {
  'darwin-arm64': 'sha512-w+6zohfHx/kHBdles/CyFKaY57u9I3nK8QI9+NrdwMliKA0b7xn13yblRNkMpe09j6vL1oAWoxYsMOQ/vjBGug==',
  'darwin-x64': 'sha512-SDbn6fO22Puy8xmMIbZi4f2znMrUEPwABApke4mo+4ihaauwuVjeqzXvW5SPJz5ty/bG11/mSupQgReT7T8BBw==',
  'linux-x64': 'sha512-2lnSPA05CRRuKAzFW8BCmmNCSieDcToLwfC2ALLbBYilGLgzhRibjlDglK9F1BkEzfohSSWJu4PBbRu/aG60lQ==',
  'win32-x64': 'sha512-k3jmUAFrzkUtvjGTXvSKjQqJLLlzjxp/VoHJDYedgmXUn6j70HxK38IwapzmnYfiBiTuzETvGwjXHzZgzKjhoQ=='
}

export function requiredComponents(platform: CodexPlatform): string[] {
  const prefix = `vendor/${CODEX_PLATFORMS[platform].triple}`
  return platform === 'win32-x64'
    ? [`${prefix}/codex/codex.exe`, `${prefix}/codex/codex-windows-sandbox-setup.exe`, `${prefix}/codex/codex-command-runner.exe`, `${prefix}/path/rg.exe`]
    : [`${prefix}/codex/codex`, `${prefix}/path/rg`]
}
