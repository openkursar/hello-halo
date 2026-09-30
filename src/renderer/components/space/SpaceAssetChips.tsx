/**
 * SpaceAssetChips
 *
 * Shortcuts into what a workspace holds: files, digital humans, skills, MCP —
 * in the same order as the resource rail's tabs, each opening the rail on its
 * own tab. No counts: they would cost a scan of every workspace on open.
 */

import { FileText, Bot } from 'lucide-react'
import type { ArtifactRailTab } from '../../types'
import { APP_TYPE_GLYPH } from '../store/app-type-glyph'
import { useTranslation } from '../../i18n'

interface SpaceAssetChipsProps {
  onSelectTab: (tab: ArtifactRailTab) => void
}

export function SpaceAssetChips({ onSelectTab }: SpaceAssetChipsProps) {
  const { t } = useTranslation()

  const chips = [
    { tab: 'files' as const, Icon: FileText, label: t('Files') },
    { tab: 'digital-humans' as const, Icon: Bot, label: t('Digital Humans') },
    // The store's type glyphs, so the same asset reads the same everywhere.
    { tab: 'skill' as const, Icon: APP_TYPE_GLYPH.skill, label: t('Skill') },
    { tab: 'mcp' as const, Icon: APP_TYPE_GLYPH.mcp, label: t('MCP') },
  ]

  return (
    <div className="flex items-center flex-wrap gap-0.5 -ml-1.5">
      {chips.map(({ tab, Icon, label }) => (
        <button
          key={tab}
          type="button"
          onClick={(e) => { e.stopPropagation(); onSelectTab(tab) }}
          title={label}
          aria-label={label}
          className="flex items-center gap-1 px-1.5 py-1 rounded-sm text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo"
        >
          <Icon className="w-3.5 h-3.5 flex-shrink-0 text-subtle-foreground" />
        </button>
      ))}
    </div>
  )
}
