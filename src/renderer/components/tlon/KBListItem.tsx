/**
 * KBListItem — one row in the knowledge-base list.
 */

import { useTranslation } from '../../i18n'
import { FileText, NotebookText, BookOpen } from 'lucide-react'
import type { KnowledgeBaseEntry } from '../../../shared/types/tlon'

interface KBListItemProps {
  kb: KnowledgeBaseEntry
  active: boolean
  onClick: () => void
}

const STATUS_DOT: Record<KnowledgeBaseEntry['status'], string> = {
  active: 'bg-emerald-500',
  paused: 'bg-muted-foreground',
  error: 'bg-destructive',
}

export function KBListItem({ kb, active, onClick }: KBListItemProps) {
  const { t } = useTranslation()

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
        active ? 'bg-primary/10 border border-primary/30' : 'hover:bg-secondary border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <BookOpen className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="font-medium text-sm truncate flex-1">{kb.name}</span>
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[kb.status]}`}
          title={
            kb.status === 'active' ? t('Active')
              : kb.status === 'paused' ? t('Paused')
                : t('Error')
          }
        />
      </div>
      <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <FileText className="w-3 h-3" />
          {t('{{count}} files', { count: kb.stats.rawFileCount })}
        </span>
        <span className="inline-flex items-center gap-1">
          <NotebookText className="w-3 h-3" />
          {t('{{count}} notes', { count: kb.stats.wikiPageCount })}
        </span>
      </div>
    </button>
  )
}
