/**
 * TurnErrorBubble - The red card a failed turn leaves in the chat.
 *
 * Shows one readable reason; the raw error (often a provider's JSON body)
 * stays behind a toggle, formatted and copyable. Callers own the placement.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { copyToClipboard } from '../../utils/clipboard'
import { describeAgentError, formatAgentErrorDetail } from './agent-error-text'

interface TurnErrorBubbleProps {
  error: string
  /** The card sits under the turn's own reply instead of standing alone. */
  inline?: boolean
  /** Extra lines under the reason, e.g. a pointer to a notice below. */
  children?: ReactNode
}

export function TurnErrorBubble({ error, inline = false, children }: TurnErrorBubbleProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const detailId = useId()

  const summary = useMemo(() => describeAgentError(error, t), [error, t])
  // Only an opened card pays for indenting the payload.
  const detail = useMemo(() => (expanded ? formatAgentErrorDetail(error) : ''), [expanded, error])

  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(error)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (err) {
      console.warn('[TurnErrorBubble] Copy failed:', err)
    }
  }, [error])

  return (
    <div
      className={`${inline ? 'mt-2 rounded-xl px-3 py-2.5' : 'rounded-2xl px-4 py-3'} min-w-0 bg-destructive/10 border border-destructive/30`}
    >
      <div className="flex items-center gap-2 text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-sm font-medium">{t('Something went wrong')}</span>
      </div>
      <p className="mt-1.5 text-sm text-destructive/80 whitespace-pre-wrap [overflow-wrap:anywhere]">{summary.text}</p>
      {children}

      {summary.expandable && (
        <div className="mt-1.5 flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setExpanded(open => !open)}
            aria-expanded={expanded}
            aria-controls={detailId}
            className="flex min-h-7 items-center gap-0.5 rounded px-1 text-destructive/70 transition-colors hover:text-destructive"
          >
            {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            {expanded ? t('Collapse') : t('Expand full error')}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            title={t('Copy error message')}
            aria-label={t('Copy error message')}
            className="flex min-h-7 items-center gap-1 rounded px-1.5 text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            <span>{copied ? t('Copied') : t('Copy')}</span>
          </button>
        </div>
      )}

      {expanded && (
        <pre
          id={detailId}
          className="mt-1.5 max-h-48 overflow-auto rounded-md border border-destructive/20 bg-background/60 px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {detail}
        </pre>
      )}
    </div>
  )
}
