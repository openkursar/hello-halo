/**
 * KBList — the master list of knowledge bases (left rail on desktop,
 * full-width on mobile when nothing is selected).
 */

import { useTranslation } from '../../i18n'
import { Plus } from 'lucide-react'
import { useTlonStore } from '../../stores/tlon.store'
import { KBListItem } from './KBListItem'

interface KBListProps {
  selectedKBId: string | null
  onSelect: (kbId: string) => void
  onCreate: () => void
}

export function KBList({ selectedKBId, onSelect, onCreate }: KBListProps) {
  const { t } = useTranslation()
  const kbs = useTlonStore(s => s.kbs)

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border flex-shrink-0">
        <span className="text-sm font-medium text-muted-foreground">{t('Knowledge Bases')}</span>
        <button
          onClick={onCreate}
          className="flex items-center gap-1 px-2 py-1 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
          title={t('New knowledge base')}
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">{t('New')}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {kbs.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('No knowledge bases yet')}
          </p>
        ) : (
          kbs.map(kb => (
            <KBListItem
              key={kb.id}
              kb={kb}
              active={kb.id === selectedKBId}
              onClick={() => onSelect(kb.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}
