/**
 * Host-side request identity factory. The SDK's Anthropic provider forwards
 * whatever this returns — every identity value is built here.
 */

import { createHash } from 'node:crypto'
import type { RequestIdentity } from '@hello-halo/agent-sdk'

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
// Fingerprint
// ---------------------------------------------------------------------------

/** Constant across installs; changing it changes the value on every request. */
const FINGERPRINT_SALT = '59cf53e54c78'

function computeFingerprint(firstUserMessageText: string, version: string): string {
  const chars = [4, 7, 20].map(i => firstUserMessageText[i] || '0').join('')
  const input = `${FINGERPRINT_SALT}${chars}${version}`
  return createHash('sha256').update(input).digest('hex').slice(0, 3)
}

function extractFirstUserMessageText(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const userMsg = messages.find(m => m.role === 'user')
  if (!userMsg) return ''
  const content = userMsg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (b: Record<string, unknown>) => b.type === 'text',
    )
    if (textBlock && typeof (textBlock as Record<string, unknown>).text === 'string') {
      return (textBlock as Record<string, unknown>).text as string
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Pinned rather than read from the installed packages: such a read can throw,
 * and a throw here costs the whole identity, not just the version.
 * `CLAUDE_CODE_COMPAT_USER_AGENT` in `openai-compat-router/server/request-handler.ts`
 * pins the same value and must move with this one.
 */
const DEFAULT_CC_VERSION = '2.1.278'
const DEFAULT_SDK_PACKAGE_VERSION = '0.74.0'

interface IdentityParams {
  ccVersion?: string
  sdkPackageVersion?: string
  deviceId?: string
  sessionId?: string
  accountUuid?: string
}

export function buildRequestIdentity(params: IdentityParams): RequestIdentity {
  const ccVersion = params.ccVersion ?? DEFAULT_CC_VERSION
  const pkgVer = params.sdkPackageVersion ?? DEFAULT_SDK_PACKAGE_VERSION

  return {
    headers: {
      'accept': 'application/json',
      'user-agent': `claude-cli/${ccVersion} (external, cli)`,
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

    systemPrefix: (messages) => {
      const fingerprint = computeFingerprint(
        extractFirstUserMessageText(messages),
        ccVersion,
      )
      const version = `${ccVersion}.${fingerprint}`
      return {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli; cch=00000;`,
      }
    },

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
