/**
 * Host-side request identity factory. The SDK's Anthropic provider forwards
 * whatever this returns — every identity value is built here.
 */

import type { RequestIdentity } from '@hello-halo/agent-sdk'
import {
  CLAUDE_CODE_USER_AGENT,
  buildAttributionLine,
  extractFirstUserMessageText,
} from '../../openai-compat-router'

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type PlatformName =
  | 'MacOS' | 'Linux' | 'Windows' | 'FreeBSD' | 'OpenBSD'
  | 'iOS' | 'Android' | `Other:${string}` | 'Unknown'

type Arch = 'x32' | 'x64' | 'arm' | 'arm64' | `other:${string}` | 'unknown'

function normalizePlatform(platform: string): PlatformName {
  const p = platform.toLowerCase()
  if (p.includes('ios')) return 'iOS'
  if (p === 'android') return 'Android'
  if (p === 'darwin') return 'MacOS'
  if (p === 'win32') return 'Windows'
  if (p === 'freebsd') return 'FreeBSD'
  if (p === 'openbsd') return 'OpenBSD'
  if (p === 'linux') return 'Linux'
  if (p) return `Other:${p}`
  return 'Unknown'
}

function normalizeArch(arch: string): Arch {
  if (arch === 'x32') return 'x32'
  if (arch === 'x86_64' || arch === 'x64') return 'x64'
  if (arch === 'arm') return 'arm'
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64'
  if (arch) return `other:${arch}`
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_SDK_PACKAGE_VERSION = '0.74.0'

interface IdentityParams {
  sdkPackageVersion?: string
  deviceId?: string
  sessionId?: string
  accountUuid?: string
}

export function buildRequestIdentity(params: IdentityParams): RequestIdentity {
  const pkgVer = params.sdkPackageVersion ?? DEFAULT_SDK_PACKAGE_VERSION

  return {
    headers: {
      'accept': 'application/json',
      'user-agent': CLAUDE_CODE_USER_AGENT,
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(params.sessionId
        ? { 'x-claude-code-session-id': params.sessionId }
        : {}),
      'x-stainless-arch': normalizeArch(process.arch),
      'x-stainless-lang': 'js',
      'x-stainless-os': normalizePlatform(process.platform),
      'x-stainless-package-version': pkgVer,
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': process.version,
      'x-stainless-timeout': '600',
    },

    headersForAttempt: (attempt: number) => ({
      'x-stainless-retry-count': String(attempt),
    }),

    systemPrefix: (messages) => ({
      type: 'text',
      text: buildAttributionLine(extractFirstUserMessageText(messages)),
    }),

    metadata: {
      user_id: JSON.stringify({
        device_id: params.deviceId ?? '',
        // Always emitted, empty when the caller holds no account uuid: dropping
        // the key would change the payload shape.
        account_uuid: params.accountUuid ?? '',
        session_id: params.sessionId ?? '',
      }),
    },

    betaQueryParam: true,

    contextManagement: {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    },
  }
}
