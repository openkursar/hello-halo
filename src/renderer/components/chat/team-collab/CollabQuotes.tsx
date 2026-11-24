/**
 * The expanded body of a sender or dispatch line, on the thought panel's faint
 * fill so the messages read apart from the reply. Opening the line is the
 * request to read them, so they are shown in full.
 */

import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n'
import { formatTimeAgo } from '../../../utils/format-time'
import { MarkdownRenderer } from '../MarkdownRenderer'

export interface CollabQuote {
  key: string
  /** Where search and references address the message, if they do. */
  messageId?: string
  label: string
  /** Opens the other party's side of this message. */
  onOpen?: () => void
  at: number
  content: string
}

export function CollabQuotes({ quotes, footer }: { quotes: readonly CollabQuote[]; footer: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="-mx-3 mt-1 rounded-lg bg-card/50 px-3 py-2.5 animate-slide-down">
      <div className="space-y-3">
        {quotes.map(quote => (
          <div key={quote.key} data-message-id={quote.messageId}>
            <div className="mb-1 flex min-w-0 items-center gap-1.5 text-xs">
              {quote.onOpen
                ? <button onClick={quote.onOpen} className="min-w-0 truncate text-left font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{quote.label}</button>
                : <span className="min-w-0 truncate font-medium text-foreground">{quote.label}</span>}
              <span className="shrink-0 text-faint-foreground">{formatTimeAgo(quote.at, t)}</span>
            </div>
            <MarkdownRenderer content={quote.content} className="break-words text-[13px] text-foreground/80" />
          </div>
        ))}
      </div>
      {footer != null && footer !== false && <div className="mt-2.5 border-t border-dashed border-border-faint pt-1.5 flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        {footer}
      </div>}
    </div>
  )
}
