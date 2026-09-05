/**
 * Long-Conversation Seeding Helper
 *
 * S3 (long-list scroll) needs 100+ messages already in a conversation before
 * the app ever opens it — going through the chat UI to send/receive that many
 * turns would be slow, flaky, and would itself burn the AI quota this harness
 * is trying to avoid depending on (see WP9 mock rationale). Real messages
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
import { execFileSync } from 'child_process'
import esbuild from 'esbuild'
import electronPath from 'electron'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface SeededConversation {
  conversationId: string
}

export interface SeedConversationOptions {
  title?: string
  /** Defaults to 120 — comfortably over the "100+" S3 spec threshold. */
  messageCount?: number
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
    outfile,
    external: ['better-sqlite3', 'electron'],
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
  const worker = getBundledWorker()
  const payload = JSON.stringify({ testConfigDir, options })
  const haloDataDir = path.join(testConfigDir, '.halo')

  const output = execFileSync(electronPath as unknown as string, [worker, payload], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HALO_DATA_DIR: haloDataDir },
    encoding: 'utf-8',
  })

  const lastLine = output.trim().split('\n').pop() ?? ''
  return JSON.parse(lastLine) as SeededConversation
}
