/**
 * Seeding worker — runs under Electron's own Node runtime (see seed-app.ts
 * for the full rationale on why this can't run in-process).
 *
 * Unlike seed-app-worker.ts (writes directly to the sqlite `installed_apps`
 * table), conversation.service.ts's storage is plain JSON files on disk, so
 * this worker just imports and calls the real `createConversation`/
 * `addMessage` functions — no hand-duplicated schema. `HALO_DATA_DIR` (set
 * by the caller before spawning) makes `getHaloDir()` resolve to the test
 * profile without needing a real `app` object, which `ELECTRON_RUN_AS_NODE=1`
 * replaces with the electron binary path string.
 *
 * Contract: argv[2] is a JSON-encoded { testConfigDir, options }; the seeded
 * { conversationId, testConfigDir } is printed to stdout as the last line.
 */

import { createConversation, addMessage } from '../../../src/main/services/conversation.service'
import type { SeedConversationOptions, SeededConversation } from './seed-conversation'

function main(): void {
  const raw = process.argv[2]
  if (!raw) throw new Error('seed-conversation-worker: missing argv[2] payload')
  const { options } = JSON.parse(raw) as { testConfigDir: string; options: SeedConversationOptions }

  const conversation = createConversation('halo-temp', options.title ?? 'S3 seeded conversation')

  const messageCount = options.messageCount ?? 120
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const content = role === 'user'
      ? `Seeded question #${i + 1} — what is the status of item ${i + 1}?`
      : `Seeded answer #${i + 1}. This is a longer assistant reply that spans a couple of sentences ` +
        'so each row has a realistic amount of rendered text, matching a typical real conversation ' +
        'turn rather than a single short line.'
    addMessage('halo-temp', conversation.id, { role, content })
  }

  const result: SeededConversation = { conversationId: conversation.id }
  // Last stdout line only. conversation.service.ts schedules its index
  // rebuild on a debounce timer (see "[Conversation] Index rebuilt
  // asynchronously" in its own logs) — without a hard exit here, those
  // trailing log lines land after this JSON line and break the
  // last-line-only contract the caller relies on.
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(0)
}

main()
