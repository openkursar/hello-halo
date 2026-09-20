/**
 * SpaceAssetChips / SpaceSummaryLine
 *
 * What a workspace holds: files, digital humans, skills, MCP — in the same
 * order as the resource rail's tabs, so the chip strip reads as a cover of
 * that rail (`SpaceAssetChips`, management-page cards, clickable). The
 * dropdown row's second line (`SpaceSummaryLine`) shows a lighter read-only
 * variant instead: conversation count plus the three installed-asset counts,
 * no files. Both share the same count formatting (cap only, zero renders as
 * "0") and the same space+global total for skill/MCP, so the two surfaces
 * cannot drift apart.
 */

import { FileText, Bot } from 'lucide-react'
import type { SpaceSummary, ArtifactRailTab } from '../../types'
import { APP_TYPE_GLYPH } from '../store/app-type-glyph'
import { useTranslation } from '../../i18n'

/** Cap mirrors the backend's — a summary never reports past it. */
const COUNT_CAP = 999

function formatAssetCount(count: number | undefined): string {
  if (count === undefined) return ''
  return count >= COUNT_CAP ? `${COUNT_CAP}+` : String(count)
}

interface SpaceAssetChipsProps {
  /** Absent while the summary is still loading — chips render without a number. */
  summary?: SpaceSummary
  onSelectTab: (tab: ArtifactRailTab) => void
}

/** Clickable strip for the management-page card: all four assets, each
 * opening the resource rail on its own tab. */
export function SpaceAssetChips({ summary, onSelectTab }: SpaceAssetChipsProps) {
  const { t } = useTranslation()

  const chips = [
    { tab: 'files' as const, Icon: FileText, label: t('Files'), count: summary?.fileCount },
    { tab: 'digital-humans' as const, Icon: Bot, label: t('Digital Humans'), count: summary?.digitalHumanCount },
    // Skill and MCP use the store's type glyphs, so the same asset reads the
    // same everywhere it appears. Count is space-scoped + global combined —
    // one number for "how many can I use here", not a breakdown.
    { tab: 'skill' as const, Icon: APP_TYPE_GLYPH.skill, label: t('Skill'), count: summary && summary.skillCount + summary.globalSkillCount },
    { tab: 'mcp' as const, Icon: APP_TYPE_GLYPH.mcp, label: t('MCP'), count: summary && summary.mcpCount + summary.globalMcpCount },
  ]

  return (
    <div className="flex items-center flex-wrap gap-0.5 -ml-1.5">
      {chips.map(({ tab, Icon, label, count }) => (
        <button
          key={tab}
          type="button"
          onClick={(e) => { e.stopPropagation(); onSelectTab(tab) }}
          title={label}
          aria-label={label}
          className="flex items-center gap-1 px-1.5 py-1 rounded-sm text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo"
        >
          <Icon className="w-3.5 h-3.5 flex-shrink-0 text-subtle-foreground" />
          <span className="tabular-nums">{formatAssetCount(count)}</span>
        </button>
      ))}
    </div>
  )
}

interface SpaceSummaryLineProps {
  summary?: SpaceSummary
}

/** Read-only second line for a workspace dropdown row: conversation count
 * first (what actually distinguishes "which workspace was this" while
 * picking), then the installed-asset counts. Files is left out here — the
 * row already implies a folder, and there isn't room in a 288px dropdown for
 * a fifth number. */
export function SpaceSummaryLine({ summary }: SpaceSummaryLineProps) {
  const { t } = useTranslation()

  const items = [
    { key: 'conversations', node: t('{{count}} conversations', { count: summary?.conversationCount ?? 0 }) },
    { key: 'digital-humans', Icon: Bot, count: summary?.digitalHumanCount },
    { key: 'skill', Icon: APP_TYPE_GLYPH.skill, count: summary && summary.skillCount + summary.globalSkillCount },
    { key: 'mcp', Icon: APP_TYPE_GLYPH.mcp, count: summary && summary.mcpCount + summary.globalMcpCount },
  ]

  return (
    <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-0.5">
          {'node' in item ? item.node : (
            <>
              <item.Icon className="w-3 h-3 flex-shrink-0" />
              <span className="tabular-nums">{formatAssetCount(item.count)}</span>
            </>
          )}
        </span>
      ))}
    </div>
  )
}
