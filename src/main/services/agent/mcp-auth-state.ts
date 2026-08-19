/**
 * Agent Module - CC MCP auth-state reconciliation
 *
 * The Claude Code CLI keeps a credential store under CLAUDE_CONFIG_DIR that
 * Halo otherwise never touches. When a URL-based MCP server answers any
 * request with 401/403 — including servers that use HTTP 401 to report
 * *business* errors such as a bad tool argument — CC treats it as "this server
 * wants OAuth", runs a discovery round, and persists the resulting state there
 * even when that round fails.
 *
 * The record has no expiry and no retry: every later CC process finds it,
 * skips connecting to that server entirely (not a single request is sent) and
 * exposes only a synthetic `authenticate` tool. Halo's MCP servers
 * authenticate through static headers and never use OAuth, so the record is
 * always stale here and there is no user-facing way to clear it.
 *
 * Removing it is therefore Halo's job. Two properties keep that safe:
 *
 * - Only entries carrying neither an access token nor a refresh token are
 *   removed. A genuinely authorized server always has one of them, so its
 *   record is never a candidate.
 * - Every lookup mirrors a CC-internal format (entry key derivation, keychain
 *   service name). A CC upgrade that changes either one makes the lookup miss,
 *   which degrades to "removed nothing" — never to removing the wrong entry.
 *
 * Cost: one credential-store read per call, ~65ms on macOS (spawns
 * `security`) and sub-millisecond elsewhere. Callers whose server set contains
 * no URL-based entry pay nothing.
 */

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { userInfo } from 'os'
import { join } from 'path'
import { resolveClaudeConfigDir } from '../../foundation/config.service'

// ============================================
// Types
// ============================================

/** The subset of a CC credential entry this module reasons about. */
interface McpOAuthEntry {
  accessToken?: string
  refreshToken?: string
}

/**
 * CC's credential blob. `mcpOAuth` is one of several top-level keys — under
 * configDirMode 'cc' it shares the record with `claudeAiOauth`, the user's real
 * subscription token, which is why the blob is always rewritten wholesale
 * rather than replaced or deleted.
 */
interface CredentialBlob {
  mcpOAuth?: Record<string, McpOAuthEntry>
  [key: string]: unknown
}

/** An MCP server config that CC would route through its OAuth machinery. */
interface UrlServerConfig {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

const KEYCHAIN_TIMEOUT_MS = 5_000
const CREDENTIALS_FILE = '.credentials.json'
/** Owner read/write, matching how CC creates the file. */
const CREDENTIALS_FILE_MODE = 0o600

// ============================================
// CC contract mirrors
// ============================================

/**
 * Derive the `mcpOAuth` entry key for a server.
 *
 * The field order below is part of the contract, not a style choice: CC hashes
 * `JSON.stringify` of an object literal built as `{ type, url, headers }`, so
 * any other order yields a different digest and the entry is never found.
 */
function deriveEntryKey(serverName: string, config: UrlServerConfig): string {
  const payload = JSON.stringify({
    type: config.type,
    url: config.url,
    headers: config.headers ?? {}
  })
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 16)
  return `${serverName}|${digest}`
}

/**
 * Derive the macOS keychain service name for a config directory.
 *
 * CC appends a directory digest only when CLAUDE_CONFIG_DIR is set in its own
 * environment. Halo always sets it (see buildSdkEnv), so the suffixed form is
 * the only one a Halo-spawned CC ever writes.
 */
function deriveKeychainService(configDir: string): string {
  const digest = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${digest}`
}

function keychainAccount(): string {
  try {
    return process.env.USER || userInfo().username
  } catch {
    return 'claude-code-user'
  }
}

// ============================================
// Credential stores
// ============================================

function runSecurity(args: string[], stdin?: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile(
      '/usr/bin/security',
      args,
      { encoding: 'utf-8', timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : (stdout ?? ''))
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

/**
 * `security` returns the password as raw text, or as a hex dump when the value
 * contains bytes it will not print literally. Both forms appear in practice.
 */
function decodeKeychainPayload(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex').toString('utf-8')
  }
  return trimmed
}

async function readKeychain(service: string): Promise<CredentialBlob | null> {
  const raw = await runSecurity(['find-generic-password', '-a', keychainAccount(), '-w', '-s', service])
  if (raw === null) return null
  try {
    return JSON.parse(decodeKeychainPayload(raw)) as CredentialBlob
  } catch {
    return null
  }
}

async function writeKeychain(service: string, blob: CredentialBlob): Promise<boolean> {
  // Mirrors how CC writes: the payload goes in as hex on stdin so the secret
  // never reaches the process table.
  const hex = Buffer.from(JSON.stringify(blob), 'utf-8').toString('hex')
  const command = `add-generic-password -U -a "${keychainAccount()}" -s "${service}" -X "${hex}"\n`
  return (await runSecurity(['-i'], command)) !== null
}

async function readCredentialsFile(configDir: string): Promise<CredentialBlob | null> {
  try {
    return JSON.parse(await readFile(join(configDir, CREDENTIALS_FILE), 'utf-8')) as CredentialBlob
  } catch {
    return null
  }
}

async function writeCredentialsFile(configDir: string, blob: CredentialBlob): Promise<boolean> {
  try {
    const path = join(configDir, CREDENTIALS_FILE)
    await mkdir(configDir, { recursive: true })
    await writeFile(path, JSON.stringify(blob), { encoding: 'utf-8', mode: CREDENTIALS_FILE_MODE })
    // `mode` above only applies when the file is created; chmod covers the
    // rewrite case, matching how CC restricts the file after every write.
    await chmod(path, CREDENTIALS_FILE_MODE)
    return true
  } catch {
    return false
  }
}

// ============================================
// Reconciliation
// ============================================

function collectUrlServers(
  mcpServers: Record<string, unknown> | null | undefined
): Array<{ name: string; config: UrlServerConfig }> {
  if (!mcpServers) return []

  const result: Array<{ name: string; config: UrlServerConfig }> = []
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<UrlServerConfig>
    if (candidate.type !== 'http' && candidate.type !== 'sse') continue
    if (typeof candidate.url !== 'string' || !candidate.url) continue
    result.push({
      name,
      config: { type: candidate.type, url: candidate.url, headers: candidate.headers }
    })
  }
  return result
}

/** An entry is stale exactly when the failed-discovery shape is present. */
function isStale(entry: McpOAuthEntry | undefined): boolean {
  return entry !== undefined && !entry.accessToken && !entry.refreshToken
}

function pruneStaleEntries(blob: CredentialBlob, keys: Set<string>): string[] {
  const records = blob.mcpOAuth
  if (!records) return []

  const removed: string[] = []
  for (const key of keys) {
    if (!isStale(records[key])) continue
    delete records[key]
    removed.push(key)
  }
  return removed
}

/**
 * Serializes purge runs within this process. The credential blob is rewritten
 * wholesale, so two overlapping purges (concurrent session creations, a probe
 * racing a session) could each write back a blob that misses the other's — or
 * a concurrent CC token refresh's — changes. Cross-process writers cannot be
 * locked out, but serializing here keeps each read-prune-write adjacent and
 * removes every race Halo itself can cause.
 */
let purgeChain: Promise<unknown> = Promise.resolve()

/**
 * Drop stale CC OAuth records for the URL-based servers in `mcpServers`.
 *
 * Safe to call on any server set and on any platform; never throws and never
 * touches an entry that holds real tokens.
 *
 * @returns how many records were removed
 */
export function purgeStaleMcpOAuth(
  mcpServers: Record<string, unknown> | null | undefined,
  context: string
): Promise<number> {
  const candidates = collectUrlServers(mcpServers)
  if (candidates.length === 0) return Promise.resolve(0)

  const run = purgeChain.then(() => reconcileStores(candidates, context))
  purgeChain = run
  return run
}

/** Never throws — degrades to "removed nothing" on any failure. */
async function reconcileStores(
  candidates: Array<{ name: string; config: UrlServerConfig }>,
  context: string
): Promise<number> {
  try {
    const configDir = resolveClaudeConfigDir()
    const keys = new Set(candidates.map(c => deriveEntryKey(c.name, c.config)))
    const service = deriveKeychainService(configDir)

    // macOS keeps the blob in the keychain but falls back to the plaintext file
    // when the keychain is unavailable, so both stores can hold a stale record.
    const stores: Array<{
      read: () => Promise<CredentialBlob | null>
      write: (blob: CredentialBlob) => Promise<boolean>
    }> = [
      {
        read: () => readCredentialsFile(configDir),
        write: blob => writeCredentialsFile(configDir, blob)
      }
    ]
    if (process.platform === 'darwin') {
      stores.unshift({
        read: () => readKeychain(service),
        write: blob => writeKeychain(service, blob)
      })
    }

    let total = 0
    for (const store of stores) {
      const blob = await store.read()
      if (!blob) continue

      const removed = pruneStaleEntries(blob, keys)
      if (removed.length === 0) continue

      if (!(await store.write(blob))) {
        console.warn(
          `[McpAuthState] Failed to persist cleanup (${context}): ${removed.join(', ')}`
        )
        continue
      }
      total += removed.length
      console.log(
        `[McpAuthState] Cleared ${removed.length} stale MCP auth record(s) (${context}): ` +
        removed.join(', ')
      )
    }
    return total
  } catch (err) {
    console.error(`[McpAuthState] Cleanup failed (${context}):`, err)
    return 0
  }
}
