/**
 * Space memory for space chat.
 *
 * Every conversation in a space shares one memory (platform/memory, scope
 * `space`), on unless the space turned it off. Two pieces reach a session:
 *
 * - Session setup: the memory instructions (system prompt) and the write guard.
 *   Stable per conversation, so a warmed session and the first real turn agree.
 * - First turn only: the memory itself, rendered ahead of the user's message.
 *   A resumed conversation already holds it in its transcript. memory.md is
 *   given its skeleton here if it has none, so the first thing a space ever
 *   records is an Edit, like everything after it.
 *
 * Consolidation after turns is services/memory-consolidation's, triggered from
 * the turn-end event — not from here.
 */

import {
  buildMemorySnapshot,
  renderMemorySection,
  MEMORY_SECTION_LIMITS,
  formatMemoryUsage,
  generatePromptInstructions,
  ensureMemoryFile,
  type MemoryLayout,
  type MemoryWriteGuardConfig,
} from '../../platform/memory'
import { getSpaceMemoryLayout, isSpaceMemoryEnabled } from '../space.service'

export interface SpaceMemorySession {
  layout: MemoryLayout
  instructions: string
  guard: MemoryWriteGuardConfig
  /**
   * What the session was built with, for session reuse: a session warmed with
   * memory on must not serve a turn after it was turned off, or the reverse.
   */
  contextKey: string
}

/** null when the space has memory off or cannot be resolved. */
export function resolveSpaceMemorySession(spaceId: string, conversationId: string): SpaceMemorySession | null {
  if (!isSpaceMemoryEnabled(spaceId)) return null
  const layout = getSpaceMemoryLayout(spaceId)
  if (!layout) return null
  return {
    layout,
    // The paths ride along so a conversation resumed without its opening
    // memory block still knows where the memory is.
    instructions: generatePromptInstructions('session', {
      owner: 'space', layout, authorTag: spaceChatInstanceTag(conversationId),
    }),
    guard: { writable: [layout], label: `chat:${conversationId.slice(0, 8)}` },
    contextKey: `space-memory:${layout.file}`,
  }
}

/** The signature this conversation writes on its `# History` entries. */
export function spaceChatInstanceTag(conversationId: string): string {
  return `chat#${conversationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4)}`
}

/**
 * The block that opens a new conversation's first message. Best-effort: a
 * memory read fault costs the turn its memory, never the turn.
 */
export async function buildSpaceMemoryPreamble(layout: MemoryLayout, conversationId: string): Promise<string> {
  try {
    if (await ensureMemoryFile(layout, 'space')) {
      console.log(`[Agent][${conversationId}] Space memory created: ${layout.file}`)
    }
    const snapshot = await buildMemorySnapshot(layout)
    console.log(`[Agent][${conversationId}] Space memory loaded: ${formatMemoryUsage(snapshot)}`)
    const section = renderMemorySection(snapshot, {
      ...MEMORY_SECTION_LIMITS.space,
      framing:
        'This memory is shared by every conversation in this space, written over time ' +
        'by many of them. A line describing work in progress was written by whichever ' +
        'conversation was doing it — verify before relying on it.',
    })
    return `${section}\n\n`
  } catch (err) {
    console.error(`[Agent][${conversationId}] Space memory snapshot failed, continuing without it:`, err)
    return ''
  }
}
