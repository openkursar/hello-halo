/**
 * EscalationCard
 *
 * Renders an escalation activity entry that requires user action.
 * - Unresolved: shows the question, preset choices, and a free-text input
 * - Resolved: shows a summary of the question + the user's choice
 */

import { useState } from 'react'
import { Loader2, MessageSquare, CheckCircle2, ChevronDown, FileText, FolderOpen } from 'lucide-react'
import type { ActivityEntry } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
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
  const { respondToEscalation } = useAppsStore()
  const [customText, setCustomText] = useState('')
  const [showTextInput, setShowTextInput] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null)

  const [savedEntry, setSavedEntry] = useState<ActivityEntry | null>(null)
  const response = entry.userResponse ?? savedEntry?.userResponse
  const closed = !!entry.content.resolution
  const resolved = !!response || closed
  const question = entry.content.question ?? entry.content.summary
  const choices = entry.content.choices ?? []
  const data = useDataContent(entry.content)

  async function submit(response: { choice?: string; text?: string }) {
    if (isSubmitting) return
    setIsSubmitting(true)
    setSubmitError(false)
    try {
      const ok = await respondToEscalation(appId, entry.id, response)
      setSubmitError(!ok)
      if (ok) {
        const answered = { ...entry, userResponse: { ts: Date.now(), ...response } }
        setSavedEntry(answered)
        onResolved?.(answered)
      }
    } finally { setIsSubmitting(false) }
  }

  async function handleChoice(choice: string) { setSelectedChoice(choice); await submit({ choice }) }
  async function handleCustomSubmit() {
    if (customText.trim()) await submit({ text: customText.trim() })
  }

  if (resolved) {
    const userAnswer = response?.choice ?? response?.text ?? ''
    return <details open={compactResolved ? undefined : true} className="group/decision rounded-xl border border-border bg-secondary/20">
      <summary className="cursor-pointer list-none rounded-xl p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 size={15} className={closed ? "shrink-0 text-muted-foreground" : "shrink-0 text-halo-success"} />
          <span>{closed ? t('Closed') : t('Answered')}</span>
          {response && Number.isFinite(new Date(response.ts).getTime()) && <time dateTime={new Date(response.ts).toISOString()} title={new Date(response.ts).toLocaleString()} className="ml-auto tabular-nums">{new Date(response.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
          <ChevronDown size={14} className="shrink-0 transition-transform group-open/decision:rotate-180" />
        </span>
        <span className="mt-2 block whitespace-pre-wrap break-words text-sm">{closed ? t('This request was closed when the task ended.') : <>{t('Your response')}: <span className="font-medium">{userAnswer}</span></>}</span>
        <span className="mt-2 block text-xs text-primary group-open/decision:hidden">{t('View original question')}</span>
      </summary>
      <div className="space-y-3 border-t border-border p-3 text-sm [overflow-wrap:anywhere]">
        <p className="whitespace-pre-wrap">{question}</p>
        {entry.content.dataPath && <button onClick={() => api.showArtifactInFolder(entry.content.dataPath!)} className="flex max-w-full items-center gap-2 rounded-lg bg-secondary px-2 py-1 text-xs text-muted-foreground"><FileText size={13} className="shrink-0" /><span className="truncate">{entry.content.dataPath.split('/').pop()}</span><FolderOpen size={13} className="shrink-0" /></button>}
        {data && <MarkdownRenderer content={data} className="text-sm" />}
      </div>
    </details>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 border border-halo-warning/40 rounded-lg p-3 bg-halo-warning/5">
      {isSubmitting && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />{t('Sending your answer…')}</p>}
      {submitError && <p role="alert" className="text-xs text-destructive">{t('Could not send your answer. Please try again.')}</p>}
      {/* Question + data scroll when long, so the actions below stay in view.
          break-words keeps unbroken tokens (constant names, URLs) inside the card. */}
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto break-words">
        {/* Question */}
        <div className="flex items-start gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-halo-warning mt-0.5 flex-shrink-0" />
          <p className="min-w-0 text-sm text-foreground">{question}</p>
        </div>

        {/* Detailed context data */}
        {entry.content.dataPath ? (
          <div className="rounded-md border border-border overflow-hidden">
            <button
              onClick={() => api.showArtifactInFolder(entry.content.dataPath!)}
              title={entry.content.dataPath}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5
                bg-secondary/60 hover:bg-secondary text-muted-foreground
                text-[11px] font-mono transition-colors group border-b border-border"
            >
              <FileText className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{entry.content.dataPath.split('/').pop()}</span>
              <FolderOpen className="w-3 h-3 flex-shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
            {data && (
              <div className="p-3">
                <MarkdownRenderer content={data} className="text-sm" />
              </div>
            )}
          </div>
        ) : data ? (
          <MarkdownRenderer content={data} className="text-sm" />
        ) : null}
      </div>

      {/* Preset choices */}
      {choices.length > 0 && !showTextInput && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {choices.map(choice => (
            <button
              key={choice}
              onClick={() => handleChoice(choice)}
              aria-pressed={selectedChoice === choice}
              disabled={isSubmitting}
              className={`px-3 py-1.5 text-xs border rounded-lg hover:bg-secondary transition-colors disabled:opacity-50 ${selectedChoice === choice ? 'border-primary bg-primary/5' : 'border-border'}`}
            >
              {choice}
            </button>
          ))}
          <button
            onClick={() => setShowTextInput(true)}
            disabled={isSubmitting}
            className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-secondary transition-colors text-muted-foreground disabled:opacity-50"
          >
            {t('Type a response')} ▾
          </button>
        </div>
      )}

      {/* Free text input (no preset choices or after expanding) */}
      {(choices.length === 0 || showTextInput) && (
        <div className="shrink-0 space-y-2">
          <textarea
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            placeholder={t('Type your response...')}
            rows={2}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
            disabled={isSubmitting}
            autoFocus={showTextInput}
          />
          <div className="flex items-center gap-2">
            {choices.length > 0 && (
              <button
                onClick={() => { setShowTextInput(false); setCustomText('') }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← {t('Back')}
              </button>
            )}
            <button
              onClick={handleCustomSubmit}
              disabled={isSubmitting || !customText.trim()}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
              {t('Send')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
