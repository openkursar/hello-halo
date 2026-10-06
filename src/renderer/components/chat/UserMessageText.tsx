/**
 * A user message's text in its bubble. A long one (a pasted log, a long
 * prompt) shows its first lines until the user opens it, and an open one can
 * be folded again from its top or its end. Whether it is open is not kept.
 *
 * The text sits in its own `[data-message-content]` element, remounted when
 * it opens or folds: search highlighting rewrites that element's HTML, and
 * the fold buttons stay outside it so they keep working afterwards.
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { foldUserMessage } from './user-message-fold'

interface UserMessageTextProps {
  messageId: string
  text: string
}

export function UserMessageText({ messageId, text }: UserMessageTextProps) {
  const { t } = useTranslation()
  const fold = useMemo(() => foldUserMessage(text), [text])
  const [open, setOpen] = useState(false)

  // A search jumping to this message opens it, so the match can be lit up.
  useEffect(() => {
    if (!fold) return
    const openOnSearch = (event: Event) => {
      if ((event as CustomEvent<{ messageId?: string }>).detail?.messageId === messageId) setOpen(true)
    }
    window.addEventListener('search:navigate-to-message', openOnSearch)
    return () => window.removeEventListener('search:navigate-to-message', openOnSearch)
  }, [fold, messageId])

  const content = (shown: string) => (
    <div key={open ? 'open' : 'folded'} className="break-words leading-relaxed" data-message-content>
      <span className="whitespace-pre-wrap">{shown}</span>
    </div>
  )
  if (!fold) return content(text)

  const foldButton = (className: string) => (
    <button
      type="button"
      aria-expanded
      onClick={() => setOpen(false)}
      className={`flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ${className}`}
    >
      <ChevronUp size={12} />
      <span>{t('Collapse')}</span>
    </button>
  )

  if (open) {
    return (
      <>
        {foldButton('mb-1.5')}
        {content(text)}
        {foldButton('mt-1.5')}
      </>
    )
  }
  return (
    <>
      {content(`${fold.preview}…`)}
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown size={12} />
        <span>{fold.lineCount > 1 ? t('Show all ({{count}} lines)', { count: fold.lineCount }) : t('Show all')}</span>
      </button>
    </>
  )
}
