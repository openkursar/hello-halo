import { createTurnGate } from '../../platform/turn-gate'
import { onAgentEvent, emitAgentEvent, formatCanvasContext } from '../../services/agent'
import type { AppChatRequest } from './app-chat'
import type { TranscriptMessage } from '../../../shared/types/transcript'
import {
  appChatMessageIdentity,
  getAppChatTurnIdentity,
  injectIntoAppChatBatch,
  isAppChatConversationGenerating,
  keepStoppedInputs,
  onAppChatConversationChange,
  refreshAppChatTurnStarts,
  type UnwrittenStoppedInput,
} from './app-chat-live-turn'
import { getImPermissionContext } from './im-permission-registry'
import { getAppChatConversationId } from '../../../shared/apps/im-keys'
import { peekAppChatSink, type AppChatRoundHandle } from './app-chat-sink'
import { isBorrowedTeamTurn } from './capability-policy'

interface PendingChatMessage {
  request: AppChatRequest
  resolve(): void
  reject(error: unknown): void
  cancelled?: boolean
}

interface ChatDelivery {
  identity: string
  messages: PendingChatMessage[]
}

const STOPPED_UNREAD = 'stopped before it was read'

/** The owner's own words to this chat; anything a teammate, a reminder, a guest or another machine sent is not. */
export function isPersonRequest(request: AppChatRequest): boolean {
  const team = request.teamContext
  return (!team || (team.kind === 'human_message' && !team.origin)) && !request.refreshBeforeDelivery
    && !request.recorded?.provenance && request.imPermission?.isOwner !== false
}

/** Handed back after a stop: delivered again later, recorded once, its earlier callers already answered. */
function takenBack(message: PendingChatMessage, recorded: boolean, recordedInputIds: readonly string[] = []): PendingChatMessage {
  return {
    request: recorded ? {
      ...message.request, inputRecorded: true,
      recordedInputIds: [...new Set([...message.request.recordedInputIds ?? [], ...recordedInputIds])],
    } : message.request,
    resolve: () => {},
    reject: () => {},
  }
}

/** Records written for `request` when it opens a turn: none once its record stands. */
function recordCount(request: AppChatRequest): number {
  return request.inputRecorded ? 0 : request.recordedMessages?.length ?? 1
}

/** What keeps a person's own message a stop voided before anything was written for it. */
function unwrittenInput(request: AppChatRequest): UnwrittenStoppedInput {
  const team = request.teamContext
  return {
    content: request.recorded?.content ?? request.message,
    images: request.images,
    provenance: request.recorded?.provenance,
    references: request.references,
    teamOrigin: team ? { kind: team.kind ?? 'human_message', correlationId: team.correlationId } : undefined,
  }
}

/** Chat assembly stays at the entry point; admission and batching use the shared mailbox. */
export function createAppChatDelivery(run: (request: AppChatRequest) => Promise<void>) {
  let disposed = false
  const reportAdmissionFailure = (request: AppChatRequest, error: unknown): void => {
    emitAgentEvent('agent:error', request.spaceId, request.conversationId ?? getAppChatConversationId(request.appId), {
      type: 'error', error: error instanceof Error ? error.message : String(error),
    })
  }
  const dispatches = new Map<string, symbol>()
  const releaseDispatch = (conversationId: string, generation: symbol): void => {
    if (dispatches.get(conversationId) !== generation) return
    dispatches.delete(conversationId)
    gate.release(conversationId)
    if (!disposed) gate.drain(conversationId)
  }
  const authorityOf = (request: AppChatRequest): string => {
    const team = request.teamContext
    return appChatMessageIdentity(request.imPermission, team && isBorrowedTeamTurn(team, !!request.imSession) ? team.origin : undefined)
  }
  const stillRelevant = (message: PendingChatMessage): boolean => {
    if (message.cancelled) return false
    if (!message.request.canStart || message.request.canStart()) return true
    console.log('[AppChatDelivery] Cancelled pending notice: its source is no longer active')
    message.cancelled = true
    message.resolve()
    return false
  }
  const gate = createTurnGate<ChatDelivery>({
    isBusy: isAppChatConversationGenerating,
    getJobIdentity: job => job.identity,
    getActiveIdentity: getAppChatTurnIdentity,
    mergeJobs: jobs => ({ identity: jobs[0].identity, messages: jobs.flatMap(job => job.messages) }),
    refreshJob: job => {
      const messages = job.messages.filter(message => {
        const refresh = message.request.refreshBeforeDelivery
        if (refresh) {
          const current = refresh()
          if (!current) {
            console.log('[AppChatDelivery] Cancelled deferred notice: destination or authorization changed')
            message.cancelled = true
            message.resolve()
            return false
          }
          const oldKey = message.request.conversationId ?? getAppChatConversationId(message.request.appId)
          const newKey = current.conversationId ?? getAppChatConversationId(current.appId)
          if (oldKey !== newKey || current.appId !== message.request.appId) {
            console.warn(`[AppChatDelivery] Deferred notice changed destination; cancelled: conversation=${oldKey}`)
            message.cancelled = true
            message.resolve()
            return false
          }
          message.request = { ...current, refreshBeforeDelivery: refresh, inputRecorded: message.request.inputRecorded, recordedInputIds: message.request.recordedInputIds }
        }
        return stillRelevant(message)
      })
      if (messages.length === 0) return undefined
      return { identity: messages[0].request.refreshBeforeDelivery ? authorityOf(messages[0].request) : job.identity, messages }
    },
    deliverMidTurn: (conversationId, job) => {
      const messages = job.messages.filter(stillRelevant)
      if (messages.length === 0) return true
      const sink = peekAppChatSink(conversationId)
      if (!sink?.canObserveLiveTurn(messages.length)) return false
      // Restricted file grants are part of session assembly, not a text supplement.
      if (job.identity !== 'owner' && messages.some(({ request }) => request.attachedFiles?.length)) return false
      const observations: AppChatRoundHandle[] = []
      if (!injectIntoAppChatBatch(conversationId, messages.map(({ request }) => ({
        text: formatCanvasContext(request.canvasContext) + request.message,
        recorded: request.recorded,
        references: request.references,
        images: request.images,
        recordedMessages: request.recordedMessages,
        inputRecorded: request.inputRecorded,
        recordedInputIds: request.recordedInputIds,
        personal: isPersonRequest(request),
      })), (indexes, recordedInputIds) => {
        // The stopped turn never read these: its reply is not their answer.
        for (const index of indexes) observations[index]?.cancel()
        gate.putBack(conversationId, [{ identity: job.identity, messages: indexes.map(index => takenBack(messages[index], true, recordedInputIds?.[index])) }])
      })) return false
      for (const message of messages) {
        const observation = sink.observeLiveTurn({ onReply: message.request.onReply, onResult: message.request.onResult, onProgress: message.request.onProgress })
        observations.push(observation)
        void observation.done.then(message.resolve, message.reject)
        try {
          message.request.onMessageAccepted?.()
        } catch (error) {
          console.error(`[AppChatDelivery] Accepted-message callback failed: conversation=${conversationId}`, error)
        }
      }
      return true
    },
    dispatch: async (conversationId, job) => {
      if (disposed) throw new Error('Chat delivery is shut down')
      const generation = Symbol(conversationId)
      dispatches.set(conversationId, generation)
      const live = job.messages.filter(stillRelevant)
      const requests = live.map(message => message.request)
      if (requests.length === 0) {
        releaseDispatch(conversationId, generation)
        return
      }
      // A person's stop held the batch back before the engine got it: the
      // person's own words are void, everything else waits for the next turn.
      const heldBack = (records: readonly TranscriptMessage[], recordedInputIds: readonly (string | undefined)[] = []): void => {
        const returned: PendingChatMessage[] = []
        const voided: TranscriptMessage[] = []
        const unwritten: UnwrittenStoppedInput[] = []
        let at = 0
        for (const message of live) {
          const count = recordCount(message.request)
          const written = records.slice(at, at + count)
          const inputIds = recordedInputIds.slice(at, at + count).filter((id): id is string => Boolean(id))
          at += count
          if (!isPersonRequest(message.request)) returned.push(takenBack(message, written.length > 0, inputIds))
          else if (written.length) voided.push(...written)
          else if (!message.request.inputRecorded) unwritten.push(unwrittenInput(message.request))
        }
        keepStoppedInputs(conversationId, voided, unwritten)
        if (returned.length) gate.putBack(conversationId, [{ identity: job.identity, messages: returned }])
      }
      const first = requests[0]
      const notify = (call: (item: AppChatRequest) => void): void => {
        for (const item of requests) {
          try { call(item) } catch (error) {
            console.error(`[AppChatDelivery] Delivery callback failed: conversation=${conversationId}`, error)
          }
        }
      }
      const request: AppChatRequest = requests.length === 1 ? first : {
        ...first,
        message: requests.map(item => formatCanvasContext(item.canvasContext) + item.message).join('\n\n'),
        canvasContext: undefined,
        images: requests.flatMap(item => item.images ?? []),
        references: requests.flatMap(item => item.references ?? []),
        attachedFiles: requests.flatMap(item => item.attachedFiles ?? []),
        recordedMessages: requests.flatMap(item => item.inputRecorded ? [] : item.recordedMessages ?? [{
          content: item.recorded?.content ?? item.message,
          images: item.images,
          provenance: item.recorded?.provenance,
          references: item.references,
          teamOrigin: item.teamContext,
        }]),
        inputRecorded: undefined,
        recordedInputIds: requests.flatMap(item => item.recordedInputIds ?? []),
        onMessageAccepted: () => notify(item => item.onMessageAccepted?.()),
        onProgress: event => notify(item => item.onProgress?.(event)),
        onResult: (content, ending) => notify(item => item.onResult?.(content, ending)),
        // Every merged item shares this conversation's chat: push the one reply once.
        onReply: (content, ending) => {
          const target = requests.find(item => item.onReply)
          try { target?.onReply?.(content, ending) } catch (error) {
            console.error(`[AppChatDelivery] Delivery callback failed: conversation=${conversationId}`, error)
          }
        },
      }
      void run({ ...request, onHeldBack: heldBack, onSessionRetired: () => releaseDispatch(conversationId, generation) }).then(
        () => { for (const message of job.messages) message.resolve() },
        error => { for (const message of job.messages) message.reject(error) },
      ).finally(() => releaseDispatch(conversationId, generation))
    },
  }, {
    getCoalescingKey: job => job.messages.length === 1 ? job.messages[0].request.coalescingKey : undefined,
    describeJob: job => `messages=${job.messages.length}`,
    onDiscard: (job, reason) => {
      for (const message of job.messages) {
        if (reason === 'superseded' || reason === 'no longer valid' || reason === STOPPED_UNREAD) message.resolve()
        else message.reject(new Error(`Pending chat message cancelled: ${reason}`))
      }
    },
  })

  const events = onAgentEvent(event => {
    if (event.channel === 'agent:turn-start' && !event.relayed) gate.notifyReady(event.conversationId)
  })
  const stopChanges = onAppChatConversationChange(conversationId => {
    if (disposed || !gate.hasBuffered(conversationId)) return
    setImmediate(() => { if (!disposed) gate.drain(conversationId) })
  })

  return {
    pendingRecordedInputIds(conversationId: string): readonly string[] {
      return gate.bufferedJobs(conversationId).flatMap(job => job.messages.flatMap(message => message.request.recordedInputIds ?? []))
    },
    send(request: AppChatRequest): Promise<void> {
      if (disposed) {
        const error = new Error('Chat delivery is shut down')
        reportAdmissionFailure(request, error)
        return Promise.reject(error)
      }
      const conversationId = request.conversationId ?? getAppChatConversationId(request.appId)
      const imPermission = request.imPermission
        ?? (!request.teamContext || request.imSession ? getImPermissionContext(conversationId) : undefined)
      refreshAppChatTurnStarts(conversationId)
      const identity = authorityOf({ ...request, imPermission })
      return new Promise((resolve, reject) => {
        void gate.deliver(conversationId, {
          identity,
          messages: [{ request: { ...request, imPermission }, resolve, reject }],
        }).catch(error => {
          reportAdmissionFailure(request, error)
          reject(error)
        })
      })
    },
    discard(conversationId: string): void {
      // A clear or restart holds back what was sent to this chat and has not
      // started. A due reminder or a teammate's message waiting for it still
      // arrives afterwards, as it did before these waited in this mailbox.
      const outlivesStop = (request: AppChatRequest): boolean => !!request.refreshBeforeDelivery || !!request.teamContext
      gate.discardJobs((key, job) => key === conversationId && !job.messages.some(({ request }) => outlivesStop(request)),
        'conversation stopped or cleared')
    },
    /**
     * A person stopped this chat: their own messages still waiting are void and
     * stay in the record marked as such; what others sent waits, without waking
     * anything, for the next turn of this chat.
     */
    holdAfterStop(conversationId: string): void {
      const voided: PendingChatMessage[] = []
      gate.discardJobs((key, job) => {
        if (key !== conversationId || !job.messages.every(({ request }) => isPersonRequest(request))) return false
        voided.push(...job.messages)
        return true
      }, STOPPED_UNREAD)
      keepStoppedInputs(conversationId, [], voided.map(({ request }) => unwrittenInput(request)))
      gate.park(conversationId)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      events.dispose()
      stopChanges()
      gate.discard(() => true, 'runtime shut down')
      dispatches.clear()
    },
  }
}
