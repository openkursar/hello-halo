import { api } from '../../api'
import type { Message } from '../../types'

type HistoryResult = Awaited<ReturnType<typeof api.teamChatMessages>>
type HistorySource = { readers: number; messages: Message[] | null; cursor: number; dirty: boolean; pending?: Promise<HistoryResult> }
const sources = new Map<string, HistorySource>()
const keyFor = (appId: string, spaceId: string, teamId: string, epochId: string) => JSON.stringify([appId, spaceId, teamId, epochId])
function sourceFor(key: string) {
  let source = sources.get(key)
  if (!source) { source = { readers: 0, messages: null, cursor: 0, dirty: false }; sources.set(key, source) }
  return source
}

/** A transcript is retained only while at least one team surface observes it. */
export function retainTeamSessionHistory(appId: string, spaceId: string, teamId: string, epochId: string) {
  const key = keyFor(appId, spaceId, teamId, epochId)
  const source = sourceFor(key)
  source.readers++
  return () => {
    source.readers--
    if (!source.readers && sources.get(key) === source) sources.delete(key)
  }
}

/** Chat, reports and the inspector share one incremental transcript source. */
export function loadTeamSessionHistory(...args: Parameters<typeof api.teamChatMessages>) {
  const [appId, spaceId, teamId, epochId] = args
  const key = keyFor(appId, spaceId, teamId, epochId)
  const source = sourceFor(key)
  if (source.pending) return source.pending
  const request = Promise.resolve().then(async () => {
    let result: HistoryResult
    do {
      source.dirty = false
      const since = source.messages && source.cursor > 1 ? source.cursor - 1 : undefined
      result = await api.teamChatMessages(appId, spaceId, teamId, epochId, since)
      if (!result.success) return result
      const batch = (result.data ?? []) as Message[]
      const seqOf = (message: Message) => (message as Message & { seq?: number }).seq
      if (since !== undefined && source.messages) {
        const rows = new Map(source.messages.map(message => [seqOf(message) ?? message.id, message]))
        for (const message of batch) rows.set(seqOf(message) ?? message.id, message)
        source.messages = [...rows.values()]
      } else source.messages = batch
      source.cursor = source.messages.reduce((max, message) => Math.max(max, seqOf(message) ?? 0), 0)
    } while (source.dirty && source.readers > 0)
    return { ...result, data: source.messages }
  })
  source.pending = request
  const release = () => {
    if (source.pending === request) source.pending = undefined
    if (!source.readers && sources.get(key) === source) sources.delete(key)
  }
  void request.then(release, release)
  return request
}

export function matchesTeamHistory(event: { teamId?: string; epochId?: string; appId?: string }, teamId: string, epochId: string, appId?: string) {
  return event.teamId === teamId && event.epochId === epochId && (!appId || event.appId === appId)
}

export function invalidateTeamSessionHistory(appId: string, spaceId: string, teamId: string, epochId: string) {
  const source = sources.get(keyFor(appId, spaceId, teamId, epochId))
  if (source) source.dirty = true
}
