/**
 * KBList — card-wall grid of knowledge bases.
 *
 * Responsive grid: 1 col < 640px, 2 cols ≥ 640px, 3 cols ≥ 1280px.
 * Includes a "+ New" dashed card at the end.
 */

import { useTranslation } from '../../i18n'
import { Plus } from 'lucide-react'
import { useTlonStore } from '../../stores/tlon.store'
import { KBListItem } from './KBListItem'

interface KBListProps {
  onCreate: () => void
}

export function KBList({ onCreate }: KBListProps) {
  const { t } = useTranslation()
  const kbs = useTlonStore(s => s.kbs)
  const selectKB = useTlonStore(s => s.selectKB)

  return (
    <div className="flex-1 overflow-y-auto px-6 sm:px-10 pb-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5 auto-rows-max">
        {kbs.map(kb => (
          <KBListItem
            key={kb.id}
            kb={kb}
            onOpen={() => selectKB(kb.id)}
          />
        ))}

        {/* New knowledge base card (dashed border) */}
        <button
          onClick={onCreate}
          className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg p-4 min-h-[160px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
        >
          <Plus className="w-6 h-6" />
          <span className="text-sm font-medium">{t('New knowledge base')}</span>
        </button>
      </div>
    </div>
  )
}