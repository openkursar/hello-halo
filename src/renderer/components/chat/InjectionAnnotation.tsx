/**
 * InjectionAnnotation - Permanent annotation for mid-turn injected messages.
 *
 * Displayed at the bottom of an assistant message bubble when the user sent
 * supplementary messages during that response's generation. The injected
 * messages are persisted with `source: 'injection'` and filtered out of the
 * main message list — this component is their only visual representation,
 * reference chips included (an older message's `<attached_paths>` block shows
 * as file chips too, never as raw text).
 *
 * Styled consistently with QueuedMessagesPanel (streaming-time equivalent).
 */

import { useTranslation } from '../../i18n'
import type { Message } from '../../types'
import { messageReferences } from '../../../shared/content-reference'
import { MessageReferenceChips } from '../references'
import { MessageImages } from './ImageAttachmentPreview'

interface InjectionAnnotationProps {
  messages: Message[]
}

export function InjectionAnnotation({ messages }: InjectionAnnotationProps) {
  const { t } = useTranslation()

  if (messages.length === 0) return null

  return (
    <div className="mt-1.5 rounded-lg border border-border/20 bg-muted/10 px-3 py-1.5">
      <div className="flex items-center gap-1.5 mb-0.5 text-[10px] text-muted-foreground/50 select-none uppercase tracking-wide">
        <span>{t('Appended')}</span>
      </div>
      <div className="space-y-0.5">
        {messages.map((msg) => {
          const { text, references } = messageReferences(msg.content ?? '', msg.metadata?.references)
          return (
            <div key={msg.id} className="flex items-start gap-1.5 text-xs text-muted-foreground/60">
              <span className="mt-px shrink-0 select-none">↳</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1 break-words">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 [&_.h-7]:h-6 [&_.text-foreground]:text-inherit [&_.text-muted-foreground]:text-inherit">
                  <MessageReferenceChips references={references} className="min-w-0 max-w-full" />
                  {!!msg.images?.length && <MessageImages images={msg.images} presentation="chips" />}
                  {text.trim() && <span className="min-w-0 whitespace-pre-wrap">{text.trimEnd()}</span>}
                </div>
                {msg.metadata?.inputOutcome === 'stopped' && (
                  <span className="text-[11px] leading-4 text-muted-foreground">{t('Stopped, not handled')}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
