/**
 * SourceChips — knowledge-base citation chips shown under an assistant answer.
 * Each chip opens the cited source document in the Content Canvas.
 * Shared by the main chat (MessageItem) and the KB chat tab (ChatTab).
 */
import { FileText } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useCanvasStore } from '../../stores/canvas.store'
import type { KBSource } from '../../../shared/types/tlon'

interface SourceChipsProps {
  sources: KBSource[]
}

export function SourceChips({ sources }: SourceChipsProps) {
  const { t } = useTranslation()
  const openFile = useCanvasStore(s => s.openFile)

  if (sources.length === 0) return null

  return (
    <div className="mt-2 pt-2 border-t border-border/60 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{t('Sources')}</span>
      {sources.map((s, i) => (
        <button
          key={i}
          onClick={() => void openFile(s.path, s.name)}
          className="inline-flex items-center gap-1 max-w-[200px] px-2 py-0.5 rounded-md bg-secondary hover:bg-secondary/80 text-[11px] text-foreground transition-colors"
          title={t('Open {{name}}', { name: s.name })}
        >
          <FileText className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
          <span className="truncate">{s.name}</span>
        </button>
      ))}
    </div>
  )
}
