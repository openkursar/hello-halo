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
 * argv[2] carries { testConfigDir, options }; fd3 carries the complete result.
 * stdout/stderr remain available for service logs, including debounced writes.
 */

import { createConversation, addMessage } from '../../../src/main/services/conversation.service'
import { writeFileSync } from 'node:fs'
import type { SeedConversationOptions, SeededConversation } from './seed-conversation'

/** A reply whose height depends on `n`: from one line to several screens. */
function mixedReply(n: number): string {
  const head = `Seeded answer #${n}.`
  switch (n % 5) {
    case 0:
      return `${head} Short one.`
    case 1:
      return `${head}\n\n` + Array.from({ length: 8 }, (_, k) => `- Point ${k + 1} about item ${n}, with a little detail`).join('\n')
    case 2:
      return `${head}\n\n\`\`\`ts\n` + Array.from({ length: 30 }, (_, k) => `const value${k} = compute(${n}, ${k}) // line ${k + 1}`).join('\n') + '\n```'
    case 3:
      return `${head}\n\n| Key | Value | Note |\n|---|---|---|\n` + Array.from({ length: 12 }, (_, k) => `| k${k} | ${n * k} | row ${k + 1} |`).join('\n')
    default:
      return `${head} ` + 'This paragraph is intentionally long so the reply wraps across many lines at any window width. '.repeat(25)
  }
}

function main(): void {
  const raw = process.argv[2]
  if (!raw) throw new Error('seed-conversation-worker: missing argv[2] payload')
  const { options } = JSON.parse(raw) as { testConfigDir: string; options: SeedConversationOptions }

  const conversation = createConversation('halo-temp', options.title ?? 'S3 seeded conversation')

  const messageCount = options.messageCount ?? 120
  const messageIds: string[] = []
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const content = role === 'user'
      ? `Seeded question #${i + 1} — what is the status of item ${i + 1}?`
      : options.variety === 'mixed'
        ? mixedReply(i + 1)
        : `Seeded answer #${i + 1}. This is a longer assistant reply that spans a couple of sentences ` +
          'so each row has a realistic amount of rendered text, matching a typical real conversation ' +
          'turn rather than a single short line.'
    messageIds.push(addMessage('halo-temp', conversation.id, { role, content }).id)
  }

  const result: SeededConversation = { conversationId: conversation.id, messageIds }
  writeFileSync(3, JSON.stringify(result), 'utf8')
  process.exit(0)
}

main()
