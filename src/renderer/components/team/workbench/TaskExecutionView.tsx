import { invalidateTeamSessionHistory, loadTeamSessionHistory, matchesTeamHistory, retainTeamSessionHistory } from '../session-history'
import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { api } from '../../../api'
import type { Message } from '../../../types'
import { MessageRow } from '../../chat/MessageRow'
import { StreamingSection } from '../../chat/StreamingSection'
import { useBrowserToolCalls } from '../../chat/useBrowserToolCalls'
import { executionTurns } from './model'
import { TaskTimestamp } from './TaskTimestamp'
import { useExecutionState } from './useExecutionState'

export function TaskExecutionView({ teamId, epochId, appId, spaceId, remote }: {
  teamId: string; epochId: string; appId: string; spaceId: string; remote: boolean
}) {
  const { t } = useTranslation()
  const state = useExecutionState(teamId, epochId, appId, remote)
  const browserTools = useBrowserToolCalls(state.thoughts)
  const [messages, setMessages] = useState<Message[]>([])
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const turns = executionTurns(messages)
  useEffect(() => {
    const release = retainTeamSessionHistory(appId, spaceId, teamId, epochId)
    let disposed = false
    let generation = 0
    const load = async () => {
      const request = ++generation
      try {
        const result = await loadTeamSessionHistory(appId, spaceId, teamId, epochId)
        if (disposed || request !== generation) return
        if (!result.success) throw new Error(String(result.error ?? 'Execution history unavailable'))
        setMessages((result.data ?? []) as Message[])
        setFailed(result.stale === true)
      } catch (error) {
        if (!disposed && request === generation) {
          console.warn('[TaskExecution] History unavailable', { teamId, epochId, appId, error })
          setFailed(true)
        }
      } finally { if (!disposed && request === generation) setLoading(false) }
    }
    invalidateTeamSessionHistory(appId, spaceId, teamId, epochId)
    void load()
    const unsubscribe = api.onTeamMemberHistory(data => {
      const event = data as { teamId?: string; epochId?: string; appId?: string }
      if (matchesTeamHistory(event, teamId, epochId, appId)) { invalidateTeamSessionHistory(appId, spaceId, teamId, epochId); void load() }
    })
    return () => { disposed = true; unsubscribe(); release() }
  }, [teamId, epochId, appId, spaceId, retry, state.active])
  return <div className="min-w-0 space-y-4">
    <p className="text-xs leading-5 text-muted-foreground">{t('Execution records for this member in this task. Expand a record to inspect the original input, thoughts and tool results.')}</p>
    {(failed || state.failed) && <p role="alert" className="text-xs text-halo-warning">{t('Some execution details are unavailable.')} <button onClick={() => setRetry(value => value + 1)} className="underline">{t('Retry')}</button></p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">{t('Loading execution history…')}</p>}
    {state.active && <section className="min-w-0 rounded-xl border border-primary/20 p-3"><h3 className="mb-3 text-sm font-medium">{t('Current execution')}</h3>{state.thoughts.length ? <StreamingSection streamingContent={state.live.streamingContent} isStreaming={state.live.isStreaming} thoughts={state.thoughts} isThinking={state.live.isThinking} browserToolCalls={browserTools} showBrowserViewButton={false} /> : <p className="text-xs text-muted-foreground">{t('No execution events received yet')}</p>}</section>}
    {turns.slice(page * 30, (page + 1) * 30).map(turn => {
      const result = turn.outputs[turn.outputs.length - 1]
      const trigger = turn.input?.metadata?.teamTriggerKind
      const label = !turn.input ? t('Execution result') : !trigger || trigger === 'human_message' ? t('Human request') : trigger === 'message' || trigger === 'reply' ? t('Team message') : t('System notification')
      return <details key={turn.id} onToggle={event => { const open = event.currentTarget.open; setExpanded(current => { const next = new Set(current); if (open) next.add(turn.id); else next.delete(turn.id); return next }) }} className="rounded-xl border border-border bg-background p-3">
        <summary className="cursor-pointer text-xs"><span className="font-medium">{label}</span><TaskTimestamp value={turn.input?.timestamp ?? result?.timestamp} recordId={turn.id} format="datetime" className="ml-2 text-muted-foreground" /><span className="mt-2 block line-clamp-2 break-words leading-5 text-muted-foreground">{result?.error || result?.content || t('View execution')}</span></summary>
        {expanded.has(turn.id) && <div className="mt-3 min-w-0 space-y-3 border-t border-border pt-3 [overflow-wrap:anywhere]">
          {turn.input && <details className="rounded-lg bg-secondary/30 p-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t('View original input')}</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-5">{turn.input.content}</p></details>}
          {turn.outputs.map(message => <MessageRow key={message.id} message={message} hideBrowserViewButton defaultThoughtsExpanded />)}
        </div>}
      </details>
    })}

    {turns.length > 30 && <nav className="flex justify-between text-xs text-primary"><button disabled={(page + 1) * 30 >= turns.length} onClick={() => setPage(value => value + 1)} className="min-h-9 disabled:opacity-40">{t('Older executions')}</button><button disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))} className="min-h-9 disabled:opacity-40">{t('Newer executions')}</button></nav>}
    {!loading && !messages.length && !state.active && <p className="text-sm text-muted-foreground">{t('No execution records in this task yet.')}</p>}
  </div>
}
