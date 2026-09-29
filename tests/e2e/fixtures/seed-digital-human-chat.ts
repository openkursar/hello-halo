/**
 * Digital-human chat seeding.
 *
 * Extends the seeded automation app (seed-app.ts) with what makes its default
 * chat session exist and be listed: a run-log transcript and the session
 * registry record the conversation list reads. Both are plain files, so no
 * worker is needed — but, like every seed, they must be written BEFORE the app
 * launches (the registry is loaded once at startup).
 */

import path from 'path'
import fs from 'fs'
import { seedAutomationApp, type SeededApp } from './seed-app'

export interface SeededDigitalHumanChat extends SeededApp {
  /** Key of the seeded default session. */
  conversationId: string
  /** The transcript file, for tests that write more of it while running. */
  transcriptPath: string
  /** Text of the seeded user / reply messages, oldest first. */
  turns: Array<{ user: string; reply: string }>
}

export interface SeedDigitalHumanChatOptions {
  name?: string
  /** User/reply pairs to write. Default 3. */
  turnCount?: number
}

const iso = (offsetSeconds: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + offsetSeconds * 1000).toISOString()

export function userLine(text: string, at: string): string {
  return JSON.stringify({ _ts: at, type: 'user', _isTrigger: true, message: { role: 'user', content: [{ type: 'text', text }] } })
}

export function replyLine(text: string, at: string, thinking?: string): string {
  const content: Array<Record<string, unknown>> = []
  if (thinking) content.push({ type: 'thinking', thinking })
  content.push({ type: 'text', text })
  return JSON.stringify({ _ts: at, type: 'assistant', message: { role: 'assistant', content } })
}

export function seedDigitalHumanChat(testConfigDir: string, options: SeedDigitalHumanChatOptions = {}): SeededDigitalHumanChat {
  const seeded = seedAutomationApp(testConfigDir, { name: options.name ?? 'E2E Chat Human' })
  const haloDir = path.join(testConfigDir, '.halo')
  const conversationId = `app-chat:${seeded.appId}`

  const turnCount = options.turnCount ?? 3
  const turns = Array.from({ length: turnCount }, (_, i) => ({
    user: `Question number ${i + 1}`,
    reply: `Answer number ${i + 1}, given by the seeded digital human.`,
  }))

  // Run logs live under the space's own directory; halo-temp is `{haloDir}/temp`.
  const runsDir = path.join(haloDir, 'temp', '.halo', 'apps', seeded.appId, 'runs')
  fs.mkdirSync(runsDir, { recursive: true })
  const transcriptPath = path.join(runsDir, 'chat.jsonl')
  const lines: string[] = []
  turns.forEach((turn, i) => {
    lines.push(userLine(turn.user, iso(i * 60)))
    lines.push(replyLine(turn.reply, iso(i * 60 + 30), `Thinking about question ${i + 1}`))
  })
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8')

  // The conversation list only shows a default session that holds messages.
  fs.writeFileSync(path.join(haloDir, 'im-sessions.json'), JSON.stringify([{
    appId: seeded.appId,
    channel: 'native',
    source: 'native',
    instanceId: '',
    chatId: 'default',
    chatType: 'direct',
    displayName: seeded.name,
    lastMessage: turns[turns.length - 1].reply.slice(0, 50),
    messageCount: turnCount * 2,
    proactive: false,
    lastActiveAt: Date.now(),
  }]), 'utf8')

  return { ...seeded, conversationId, transcriptPath, turns }
}
