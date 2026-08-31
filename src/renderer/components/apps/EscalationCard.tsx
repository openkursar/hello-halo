/**
 * EscalationCard
 *
 * Renders an escalation activity entry that requires user action.
 * - Unresolved: shows the question, preset choices, and a free-text input
 * - Resolved: shows a summary of the question + the user's choice
 */

import { useState } from 'react'
import { Loader2, MessageSquare, CheckCircle2, FileText, FolderOpen } from 'lucide-react'
import type { ActivityEntry } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { useDataContent } from '../../hooks/useDataContent'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { api } from '../../api'

interface EscalationCardProps {
  entry: ActivityEntry
  appId: string
}

export function EscalationCard({ entry, appId }: EscalationCardProps) {
  const { t } = useTranslation()
  const { respondToEscalation } = useAppsStore()
  const [customText, setCustomText] = useState('')
  const [showTextInput, setShowTextInput] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const resolved = !!entry.userResponse
  const question = entry.content.question ?? entry.content.summary
  const choices = entry.content.choices ?? []
  const data = useDataContent(entry.content)

  async function handleChoice(choice: string) {
    setIsSubmitting(true)
    await respondToEscalation(appId, entry.id, { choice })
    setIsSubmitting(false)
  }

  async function handleCustomSubmit() {
    if (!customText.trim()) return
    setIsSubmitting(true)
    await respondToEscalation(appId, entry.id, { text: customText.trim() })
    setIsSubmitting(false)
  }

  if (resolved) {
    const userAnswer = entry.userResponse?.choice ?? entry.userResponse?.text ?? ''
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="w-3.5 h-3.5 text-green-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="italic">「{question}」</p>
            <p className="mt-0.5">
              {t('Your response')}: <span className="text-foreground font-medium">{userAnswer}</span>
            </p>
          </div>
        </div>
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
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 border border-orange-400/40 rounded-lg p-3 bg-orange-400/5">
      {/* Question + data scroll when long, so the actions below stay in view.
          break-words keeps unbroken tokens (constant names, URLs) inside the card. */}
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto break-words">
        {/* Question */}
        <div className="flex items-start gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-orange-400 mt-0.5 flex-shrink-0" />
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
              disabled={isSubmitting}
              className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-secondary transition-colors disabled:opacity-50"
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
