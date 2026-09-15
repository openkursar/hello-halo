import { useState } from 'react'
import { ArrowRight, ChevronDown, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import type { Message } from '../../../types'
import { useTranslation } from '../../../i18n'
import { MessageRow } from '../../chat/MessageRow'
import { StreamingSection } from '../../chat/StreamingSection'
import { useBrowserToolCalls } from '../../chat/useBrowserToolCalls'
import { useExecutionState } from './useExecutionState'
import { taskTime } from './time'
import { TaskTimestamp } from './TaskTimestamp'

export function ExecutionStatus({ teamId, epochId, appId, remote, busy, latestResult, onOpen }: {
  teamId: string; epochId: string; appId: string; remote: boolean; busy: boolean; latestResult?: Message; onOpen: () => void
}) {
  const { t } = useTranslation()
  const state = useExecutionState(teamId, epochId, appId, remote)
  const browserTools = useBrowserToolCalls(state.thoughts)
  const [expanded, setExpanded] = useState(false)
  if (!busy && !state.active && !state.failed && !state.live.error && !latestResult) return null
  const last = state.thoughts[state.thoughts.length - 1]
  const at = taskTime(last?.timestamp)
  const pendingTool = last?.type === 'tool_use' && !last.toolResult ? last : undefined
  const executionError = state.live.error || (!state.active ? latestResult?.error : undefined)
  const unavailable = state.failed || (busy && !state.available)
  const label = executionError ? t('Failed') : unavailable ? t('Execution details are currently unavailable')
    : state.active ? pendingTool ? t('Executing tool: {{name}}', { name: pendingTool.toolName ?? t('Tool') }) : t('Processing this task')
      : t('Execution ended')
  const duration = latestResult?.thoughtsSummary?.duration
  return <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} className="group/execution mt-3 min-w-0 rounded-xl border border-border text-xs">
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-3 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {executionError || unavailable ? <AlertCircle size={14} className="shrink-0 text-halo-warning" /> : state.active ? <Loader2 size={14} className="shrink-0 animate-spin text-primary" /> : <CheckCircle2 size={14} className="shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {!state.active && duration !== undefined && Number.isFinite(duration) && <span className="text-muted-foreground">{t('{{seconds}}s', { seconds: Math.round(duration) })}</span>}
      {!state.active && latestResult && <TaskTimestamp value={latestResult.timestamp} recordId={latestResult.id} format="datetime" className="shrink-0 text-[11px] text-muted-foreground" />}
      <ChevronDown size={14} className="shrink-0 text-muted-foreground transition-transform group-open/execution:rotate-180" />
    </summary>
    {executionError && <p role="alert" className="px-3 pb-3 text-halo-warning">{executionError}</p>}
    {expanded && <div className="min-w-0 space-y-3 border-t border-border p-3 [overflow-wrap:anywhere]">
      {state.active ? <>
        <p className="text-[11px] text-muted-foreground">{at === null ? t('No execution events received yet') : t('Last execution event {{seconds}} seconds ago', { seconds: Math.max(0, Math.floor((state.now - at) / 1000)) })}</p>
        <StreamingSection streamingContent={state.live.streamingContent} isStreaming={state.live.isStreaming} thoughts={state.thoughts} isThinking={state.live.isThinking} browserToolCalls={browserTools} showBrowserViewButton={false} />
      </> : latestResult ? <MessageRow message={latestResult} hideBrowserViewButton defaultThoughtsExpanded /> : <p className="text-muted-foreground">{t('No execution events received yet')}</p>}
      <button onClick={onOpen} className="flex min-h-9 w-full items-center justify-center gap-1 rounded text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('View execution history')}<ArrowRight size={13} /></button>
    </div>}
  </details>
}
