/**
 * NewSpaceCard
 *
 * Dashed-border "new workspace" card at the end of the grid on the
 * workspace management page — same footprint as SpaceCard, so it reads as
 * one more item in the wall rather than a separate control. Also doubles
 * as the empty state: with zero dedicated spaces, this card is the whole
 * grid.
 */

import { Plus } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface NewSpaceCardProps {
  onClick: () => void
}

export function NewSpaceCard({ onClick }: NewSpaceCardProps) {
  const { t } = useTranslation()

  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-1.5 min-h-[104px] rounded-lg border border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-secondary/40 transition-colors ease-halo"
    >
      <Plus className="w-5 h-5" />
      <span className="text-sm font-medium">{t('New Workspace')}</span>
    </button>
  )
}
