import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, ChevronDown, AlertCircle, FileText } from 'lucide-react'
import type { ActivityEntry, EscalationAnswer } from '../../../shared/apps/app-types'
import { getEscalationQuestions, formatEscalationAnswer } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { useTranslation } from '../../i18n'
import { useDataContent } from '../../hooks/useDataContent'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { api } from '../../api'

interface EscalationCardProps {
  entry: ActivityEntry
  appId: string
  onResolved?: (entry: ActivityEntry) => void
  compactResolved?: boolean
}

export function EscalationCard({ entry, appId, onResolved, compactResolved = false }: EscalationCardProps) {
  const { t } = useTranslation()
  const cached = useAppsStore(state => state.activityEntries[appId]?.find(item => item.id === entry.id))
  const current = cached ?? entry
  const questions = getEscalationQuestions(current.content)
  const key = `${appId}:${entry.id}`
  const drafts = usePeopleViewStore(state => state.drafts[key]) ?? []
  const saveDraft = usePeopleViewStore(state => state.saveDraft)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [fileError, setFileError] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const response = current.userResponse
  const resolution = current.content.resolution
  const resolved = !!response || !!resolution
  const data = useDataContent(current.content)
  const continuation = current.continuation
  const complete = questions.every((_, index) => !!(drafts[index]?.choice || drafts[index]?.text?.trim()))
  const refresh = () => Promise.all([useAppsStore.getState().loadActivity(appId), useAppsStore.getState().loadPending(appId), useAppsStore.getState().loadAppState(appId)])
  const changeAnswer = (index: number, answer: EscalationAnswer) => saveDraft(key, questions.map((_, position) => position === index ? answer : drafts[position] ?? {}))
  useEffect(() => { setError(false) }, [entry.id])
  const submit = async () => {
    setOperationFailed(false)
    if (submitting || !complete || resolved) return
    setSubmitting(true); setError(false)
    try {
      const answers = questions.map((_, index) => ({ ...drafts[index], ...(drafts[index]?.text ? { text: drafts[index].text!.trim() } : {}) }))
      const ok = await useAppsStore.getState().respondToEscalation(appId, entry.id, questions.length > 1 ? { answers } : answers[0])
      setError(!ok)
      if (ok) {
        usePeopleViewStore.getState().clearDraft(key)
        const saved = useAppsStore.getState().activityEntries[appId]?.find(item => item.id === entry.id)
        if (saved) onResolved?.(saved)
      }
    } finally { setSubmitting(false) }
  }
  const perform = async (operation: () => Promise<{ success: boolean; error?: string }>) => {
    setOperationFailed(true)
    if (submitting) return
    setSubmitting(true); setError(false)
    try {
      const result = await operation()
      if (!result.success) {
        console.warn('[EscalationCard] Decision operation rejected', { appId, entryId: entry.id, error: result.error })
        setError(true)
      }
      await refresh()
    } catch (cause) {
      console.warn('[EscalationCard] Decision operation failed', { appId, entryId: entry.id, cause })
      setError(true)
    } finally { setSubmitting(false) }
  }
  if (resolved) return <div className="space-y-3">
    <details open={compactResolved ? undefined : true} className="group/decision rounded-xl border border-border bg-secondary/20">
      <summary className="cursor-pointer list-none rounded-xl p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 size={15} className={resolution ? 'text-muted-foreground' : 'text-halo-success'} /><span>{resolution ? resolution.reason === 'expired' ? t('Expired') : t('Closed') : t('Answered')}</span><span className="ml-auto">{new Date(response?.ts ?? resolution!.ts).toLocaleString()}</span><ChevronDown size={14} /></span>
        <span className="mt-2 block whitespace-pre-wrap break-words text-sm">{resolution ? resolution.reason === 'expired' ? t('The deadline passed without an answer.') : resolution.reason === 'legacy_system_closed' ? t('Historical closure (source unverified)') : t('This request was closed when the task ended.') : <>{t('Your response')}: {formatEscalationAnswer(questions, response!)}</>}</span>
      </summary><div className="space-y-3 border-t border-border p-3 text-sm"><p className="whitespace-pre-wrap break-words">{current.content.summary}</p>{resolution?.legacyText && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{t('Original record')}: {resolution.legacyText}</p>}{questions.length > 1 && questions.map((question, index) => <p key={index} className="whitespace-pre-wrap">{question.question}</p>)}{data && <MarkdownRenderer content={data} className="text-sm" />}</div>
    </details>
    {response && <div role="status" className="rounded-lg bg-secondary/40 p-3 text-xs text-muted-foreground">{continuation?.status === 'queued' ? t('Answer received. Waiting to continue the original work.') : continuation?.status === 'running' ? t('Answer received. The original work is continuing.') : continuation?.status === 'failed' ? t('Your answer is saved, but the work could not continue.') : continuation?.status === 'completed' ? t('The work continued after your answer.') : continuation?.status === 'cancelled' ? t('Your answer is saved. The task has since closed.') : t('Your answer has been received.')}
      {continuation?.status === 'failed' && <><p className="mt-2 break-words">{continuation.error}</p><button disabled={submitting} onClick={() => void perform(() => api.appRetryEscalationContinuation(appId, entry.id))} className="mt-2 min-h-8 text-primary disabled:opacity-50">{t('Retry continuing')}</button></>}
    </div>}
    {drafts.some(answer => answer.text || answer.choice) && <details className="text-xs text-muted-foreground"><summary>{t('Your unsent draft was preserved')}</summary><p className="whitespace-pre-wrap break-words">{drafts.map(answer => answer.text ?? answer.choice).join('\n')}</p></details>}
    {error && <p role="alert" className="text-xs text-destructive">{t('Could not apply this action. Please try again.')}</p>}
  </div>
  return <div className="space-y-4 rounded-xl border border-halo-warning/30 bg-halo-warning/5 p-4">
    <p className="whitespace-pre-wrap break-words text-sm font-medium">{current.content.summary}</p>
    {current.content.dataPath && <button onClick={async () => {
      setFileError(false)
      try {
        if (api.isRemoteMode()) api.downloadArtifact(current.content.dataPath!)
        else { const result = await api.showArtifactInFolder(current.content.dataPath!); if (!result.success) throw new Error(result.error ?? 'File opening rejected') }
      } catch (cause) { console.warn('[EscalationCard] Evidence file could not open', { appId, entryId: entry.id, cause }); setFileError(true) }
    }} className="flex min-h-8 max-w-full items-center gap-2 text-xs text-primary"><FileText size={14} className="shrink-0" /><span className="truncate">{current.content.dataPath.split('/').pop()}</span></button>}
    {data && <MarkdownRenderer content={data} className="text-sm" />}
    {fileError && <p role="alert" className="text-xs text-destructive">{t('Could not open this file. Please try again.')}</p>}
    {current.content.deadlineReviewRequired && <div className="space-y-3 rounded-lg border border-halo-warning/30 bg-background p-3"><p className="flex items-start gap-2 text-xs text-halo-warning"><AlertCircle size={15} className="shrink-0" />{t('This request has a deadline from an earlier version. Confirm a new deadline before answering.')}</p><input type="datetime-local" aria-label={t('New deadline')} value={deadline} onChange={event => setDeadline(event.target.value)} className="max-w-full rounded border border-border bg-background p-2 text-xs" /><div className="flex flex-wrap gap-3"><button disabled={submitting || !deadline || new Date(deadline).getTime() <= Date.now()} onClick={() => void perform(() => api.appConfirmEscalationDeadline(appId, entry.id, new Date(deadline).getTime()))} className="min-h-8 text-xs text-primary disabled:opacity-50">{t('Confirm new deadline')}</button><button disabled={submitting} onClick={() => void perform(() => api.appConfirmEscalationDeadline(appId, entry.id, null))} className="min-h-8 text-xs text-primary">{t('Keep without a deadline')}</button></div></div>}
    {!current.content.deadlineReviewRequired && questions.map((question, index) => <div key={index} className="space-y-2">{questions.length > 1 && <p className="text-sm">{question.question}</p>}<div className="flex flex-wrap gap-2">{question.choices?.map(choice => <button key={choice} aria-pressed={drafts[index]?.choice === choice} disabled={submitting} onClick={() => changeAnswer(index, { choice })} className={`min-h-9 rounded-lg border px-3 py-2 text-left text-xs ${drafts[index]?.choice === choice ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}>{choice}</button>)}</div><textarea aria-label={question.question} placeholder={t('Type your response...')} value={drafts[index]?.text ?? ''} disabled={submitting} onChange={event => changeAnswer(index, { text: event.target.value })} rows={2} className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm" /></div>)}
    {error && <p role="alert" className="text-xs text-destructive">{operationFailed ? t('Could not apply this change. Your answer and draft are preserved. Check the current status and retry.') : t('Could not confirm receipt of your answer. Your draft is preserved. Check the current status and retry.')}</p>}
    {!current.content.teamContext && current.content.source?.kind !== 'team' && <div className="border-t border-border pt-3 text-xs">{confirmClose ? <><p className="mb-2 text-muted-foreground">{t('Close this independent work and all its unanswered requests? Other work is unaffected.')}</p><button disabled={submitting} onClick={() => void perform(() => api.appCloseRun(appId, entry.runId))} className="mr-4 min-h-8 text-destructive">{t('Close this work')}</button><button onClick={() => setConfirmClose(false)} className="min-h-8 text-muted-foreground">{t('Cancel')}</button></> : <button onClick={() => setConfirmClose(true)} className="min-h-8 text-muted-foreground hover:text-destructive">{t('Close this work…')}</button>}</div>}
    <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{questions.length > 1 && !complete ? t('Answer every question to send') : t('Only this work will continue. Automatic tasks remain unchanged.')}</span><button disabled={submitting || !complete || !!current.content.deadlineReviewRequired} onClick={() => void submit()} className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{submitting && <Loader2 size={14} className="animate-spin" />}{submitting ? t('Sending your answer…') : t('Submit and continue this work')}</button></div>
  </div>
}
