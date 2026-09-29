/**
 * apps/runtime -- a digital human's scheduled runs as cross-conversation senders
 *
 * A run that has conversation collaboration acts under its own sender key
 * (`app-run:{appId}:{runId}`), never its digital human's default chat: what it
 * sends is a ONE-WAY NOTICE. Nothing sent back can reach the digital human's
 * chats — a reply would otherwise land in the owner's default chat and start a
 * turn there. The one way back is a `waitForReply` the run is blocked in, which
 * the conversation directory settles before looking at writability.
 *
 * So this source is neither readable nor writable: its runs are never listed
 * or read, and a plain send to one is refused with a reason. `getMeta` names a
 * live run to its recipients (`<name> · scheduled run (<time> run)`) and lets a
 * pending reply reach it — addressed by the exact key the frame of a waiting send
 * hands the recipient, since nothing else resolves to a run. A recently finished
 * run answers `unavailable`, so a late reply is refused with a reason.
 * Registered at bootstrap next to the digital-human chat source.
 */

import { toDisposable } from '../../platform/event'
import type { ConversationSource, SourceConversation } from '../../services/conversation-interop'
import { buildRunSenderKey, parseRunSenderKey } from '../../../shared/apps/im-keys'
import { isConversationCollabEnabled } from '../../../shared/apps/app-types'
import { getAppManager } from '../manager'
import { COLLAB_OFF_REASON } from './conversation-collab'

const LOG_TAG = '[RunConversations]'

export const RUN_SOURCE_KIND = 'scheduled-run'

const RUN_FINISHED_REASON =
  'it was a one-way notice from a scheduled run of a digital human; the run takes no replies (it may already have finished)'

interface LiveRun {
  appId: string
  spaceId: string
  title: string
  startedAt: number
}

const liveRuns = new Map<string, LiveRun>()

/** Space of recently finished runs, so a late reply to one is refused with a reason and only within its own space. */
const CLOSED_RUN_MEMORY = 500
const closedRunSpaces = new Map<string, string>()

/** Local time as `YYYY-MM-DD HH:mm`: unambiguous inside an English sentence, whatever the OS locale. */
function formatRunTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function runTitle(name: string, startedAt: number): string {
  return `${name} · scheduled run (${formatRunTime(startedAt)} run)`
}

/**
 * The sender key a run acts under while it is alive. Pair with
 * {@link closeRunSender} when the run ends, whatever the outcome.
 */
export function openRunSender(run: { appId: string; runId: string; spaceId: string; name: string; startedAt: number }): string {
  const key = buildRunSenderKey(run.appId, run.runId)
  liveRuns.set(key, { appId: run.appId, spaceId: run.spaceId, title: runTitle(run.name, run.startedAt), startedAt: run.startedAt })
  return key
}

export function closeRunSender(key: string): void {
  const run = liveRuns.get(key)
  liveRuns.delete(key)
  if (!run) return
  closedRunSpaces.set(key, run.spaceId)
  if (closedRunSpaces.size > CLOSED_RUN_MEMORY) closedRunSpaces.delete(closedRunSpaces.keys().next().value as string)
}

export function createRunConversationSource(): ConversationSource {
  return {
    kind: RUN_SOURCE_KIND,
    capabilities: { readable: false, writable: false },
    whyNotWritable: 'it is a one-way notice from a scheduled run of a digital human; the run takes no replies',

    owns: (conversationId) => parseRunSenderKey(conversationId) !== null,

    list: () => [],

    // A live run is addressable (the frame of a waiting send hands out its key); a
    // recently finished one answers with why nothing reaches it. Both only in the
    // space the run belonged to.
    getMeta(spaceId, conversationId): SourceConversation | null {
      if (!parseRunSenderKey(conversationId)) return null
      const run = liveRuns.get(conversationId)
      if (!run) {
        return closedRunSpaces.get(conversationId) === spaceId
          ? { id: conversationId, title: 'scheduled run', updatedAt: new Date(0).toISOString(), messageCount: 0, unavailable: RUN_FINISHED_REASON }
          : null
      }
      if (run.spaceId !== spaceId) return null
      // Read per call: switching collaboration off mid-run stops replies to a waiting run too.
      const app = getAppManager()?.getApp(run.appId)
      const enabled = !!app && isConversationCollabEnabled(app)
      return {
        id: conversationId,
        title: run.title,
        updatedAt: new Date(run.startedAt).toISOString(),
        messageCount: 0,
        ...(enabled ? {} : { unavailable: COLLAB_OFF_REASON }),
      }
    },

    shortRef: (conversationId) => conversationId,

    readTranscript: () => null,

    isBusy: () => false,
    hasLiveSession: () => false,

    dispatch: (_spaceId, conversationId) =>
      Promise.reject(new Error(`a scheduled run takes no messages: ${conversationId}`)),

    onTurnEnd: () => toDisposable(() => undefined),

    writeNotice(_spaceId, conversationId, content) {
      // A run has no transcript another conversation writes into; its log is where the pause shows.
      console.log(`${LOG_TAG} notice for ${conversationId}: ${content}`)
    },
  }
}
