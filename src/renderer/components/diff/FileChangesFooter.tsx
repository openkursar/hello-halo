/**
 * FileChangesFooter - "Changed N files · +A −D · View changes" under an AI
 * reply that edited files. Opens the reply's edits in the canvas changes view.
 *
 * The counts come from the message metadata (shown at once), or from the
 * reply's thoughts when they are already loaded; the diffs themselves are read
 * by the changes view when it opens.
 */

import { useMemo } from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import { extractFileChanges, hasFileChanges, summaryToFileChanges } from './utils'
import type { Thought, FileChangesSummary } from '../../types'
import { useCanvasActions } from '../../hooks/useCanvasLifecycle'
import { useTranslation } from '../../i18n'

interface FileChangesFooterProps {
  fileChangesSummary?: FileChangesSummary  // From metadata: immediate stats display
  thoughts?: Thought[] | null              // From message: exact stats once loaded
  /** The reply these changes belong to; without it they cannot be opened. */
  reply?: { spaceId: string; conversationId: string; messageId: string; timestamp: string }
}

export function FileChangesFooter({ fileChangesSummary, thoughts, reply }: FileChangesFooterProps) {
  const { t, i18n } = useTranslation()
  const { openChanges } = useCanvasActions()

  const changes = useMemo(() => {
    if (Array.isArray(thoughts) && thoughts.length > 0) {
      const extracted = extractFileChanges(thoughts)
      if (hasFileChanges(extracted)) return extracted
    }
    if (fileChangesSummary) return summaryToFileChanges(fileChangesSummary)
    return null
  }, [fileChangesSummary, thoughts])

  if (!changes) return null

  const open = () => {
    if (!reply) return
    const at = Date.parse(reply.timestamp)
    const time = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(Number.isNaN(at) ? Date.now() : at)
    void openChanges({
      kind: 'message',
      spaceId: reply.spaceId,
      conversationId: reply.conversationId,
      messageId: reply.messageId,
      title: t('Reply {{time}}', { time }),
      replyAt: Number.isNaN(at) ? Date.now() : at,
    })
  }

  const format = (value: number) => new Intl.NumberFormat(i18n.language).format(value)

  return (
    <button
      type="button"
      onClick={open}
      disabled={!reply}
      className="group mt-3 flex w-fit max-w-full items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:cursor-default disabled:hover:border-border disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <FileDiff size={14} className="shrink-0 text-faint-foreground" aria-hidden />
      <span className="truncate">{t('Changed {{count}} files', { count: changes.totalFiles })}</span>
      <span className="shrink-0 font-mono text-[11.5px]">
        <span className="text-diff-add">+{format(changes.totalAdded)}</span>{' '}
        <span className="text-diff-del">−{format(changes.totalRemoved)}</span>
      </span>
      {reply && (
        <span className="flex shrink-0 items-center gap-0.5 text-primary">
          {t('View changes')}
          <ChevronRight size={13} className="transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      )}
    </button>
  )
}
