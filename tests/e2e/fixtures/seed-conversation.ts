/**
 * Long-Conversation Seeding Helper
 *
 * S3 (long-list scroll) needs 100+ messages already in a conversation before
 * the app ever opens it — going through the chat UI to send/receive that many
 * turns would be slow, flaky, and would itself burn the AI quota this harness
 * is trying to avoid depending on (see the mock rationale below). Real messages
 * scroll and render identically to seeded ones since MessageList reads the
 * same JSON conversation file regardless of how it was written.
 *
 * Must run BEFORE `electronApp` launches, same ordering constraint as
 * seed-app.ts: conversation.service.ts uses an in-memory read/write cache
 * keyed by file path, so writing to the same file after the app has already
 * opened it would race the app's own cache.
 *
 * The actual write happens in a spawned subprocess (seed-conversation-worker.ts)
 * run under Electron's own Node binary, importing the real `createConversation`/
 * `addMessage` from conversation.service.ts (a plain JSON-file store, not
 * sqlite — see that file's module docblock) so seeded conversations are
 * schema-identical to what the chat UI would have written.
 */

import path from 'path'
import fs from 'fs'
import { spawnSync } from 'child_process'
import esbuild from 'esbuild'
import electronPath from 'electron'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface SeededConversation {
  conversationId: string
  /** Ids of the seeded messages, in order. */
  messageIds: string[]
}

export interface SeedConversationOptions {
  title?: string
  /** Defaults to 120 — comfortably over the "100+" S3 spec threshold. */
  messageCount?: number
  /**
   * `mixed` gives replies widely varying heights (lists, code, tables, long
   * prose) — the shape that stresses transcript scrolling. Defaults to uniform.
   */
  variety?: 'uniform' | 'mixed'
  /**
   * Give every reply a token usage record, so the usage count renders under
   * it. The n-th message (1-based) reads `${600 + n}K`, telling replies apart.
   */
  tokenUsage?: boolean
}

let bundledWorkerPath: string | null = null

/** Bundles seed-conversation-worker.ts once per test run and caches the output path. */
function getBundledWorker(): string {
  if (bundledWorkerPath && fs.existsSync(bundledWorkerPath)) return bundledWorkerPath

  // Output must live under the project tree (not os.tmpdir()) so `electron`
  // (marked external) resolves via normal node_modules walk-up at run time.
  const outDir = path.join(__dirname, '.e2e-seed-tmp')
  fs.mkdirSync(outDir, { recursive: true })
  const outfile = path.join(outDir, `seed-conversation-worker-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'seed-conversation-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile,
    // Native addons load at run time from node_modules; esbuild cannot bundle them.
    external: ['better-sqlite3', 'electron', '@parcel/watcher'],
    logLevel: 'silent',
  })

  bundledWorkerPath = outfile
  return outfile
}

/**
 * Seed one conversation with `options.messageCount` messages into a fresh
 * test profile's `halo-temp` space.
 *
 * @param testConfigDir The E2E profile root (same value passed to
 *   `launchElectronApp()`). `HALO_DATA_DIR` is derived as `{testConfigDir}/.halo`,
 *   matching `getHaloDir()`'s env-var override.
 */
export function seedLongConversation(testConfigDir: string, options: SeedConversationOptions = {}): SeededConversation {
  const expectedMessages = options.messageCount ?? 120
  if (!Number.isInteger(expectedMessages) || expectedMessages < 0) throw new Error('Conversation seed messageCount must be a non-negative integer')
  const worker = getBundledWorker()
  const payload = JSON.stringify({ testConfigDir, options })
  const haloDataDir = path.join(testConfigDir, '.halo')

  const result = spawnSync(electronPath as unknown as string, [worker, payload], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HALO_DATA_DIR: haloDataDir },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw new Error(`Conversation seed worker could not complete: ${result.error.message}`, { cause: result.error })
  if (result.status !== 0 || result.signal) {
    throw new Error(`Conversation seed worker failed (status=${result.status}, signal=${result.signal ?? 'none'}):\n${result.stderr?.slice(-16000) ?? ''}\n${result.stdout?.slice(-16000) ?? ''}`)
  }
  const response = result.output[3]
  if (typeof response !== 'string' || !response.length) throw new Error('Conversation seed worker returned no result on its dedicated channel')
  let parsed: unknown
  try { parsed = JSON.parse(response) }
  catch (error) { throw new Error('Conversation seed worker returned invalid JSON on its dedicated channel', { cause: error }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Conversation seed worker returned an invalid result object')
  const value = parsed as Partial<SeededConversation>
  const messageIds = value.messageIds
  if (Object.keys(parsed).length !== 2 || typeof value.conversationId !== 'string' || !value.conversationId.trim() ||
      !Array.isArray(messageIds) || messageIds.length !== expectedMessages ||
      messageIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(messageIds).size !== expectedMessages) {
    throw new Error('Conversation seed worker result does not match the requested conversation/message structure')
  }
  return { conversationId: value.conversationId, messageIds }
}
