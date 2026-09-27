/**
 * EmptyState
 *
 * Right-pane informational state for the AppsPage list+detail layout.
 * Shown when no app is selected (either because the user hasn't picked one,
 * or because the current tab has no apps at all).
 *
 * The CTAs for installing/adding apps live in each card wall's own empty
 * state — this component intentionally does NOT duplicate those buttons.
 *
 * Variants control the per-tab copy and icon:
 *   - 'automation' (default)
 *   - 'skill'
 *   - 'mcp'
 */

import { Blocks, BookOpen, Server } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'

export type EmptyStateVariant = 'automation' | 'skill' | 'mcp'

interface EmptyStateProps {
  hasApps: boolean
  variant?: EmptyStateVariant
}

interface VariantCopy {
  selectText: string
  selectHint: string
  icon: LucideIcon
  emptyTitle: string
  emptyHint: string
}

function useVariantCopy(variant: EmptyStateVariant): VariantCopy {
  const { t } = useTranslation()
  switch (variant) {
    case 'skill':
      return {
        selectText: t('Select a Skill to view details'),
        selectHint: t('Choose a Skill to view details'),
        icon: BookOpen,
        emptyTitle: t('No Skills installed yet'),
        emptyHint: t('Browse the marketplace or add one manually'),
      }
    case 'mcp':
      return {
        selectText: t('Select an MCP server to view details'),
        selectHint: t('Choose an MCP server to view details'),
        icon: Server,
        emptyTitle: t('No MCP servers connected yet'),
        emptyHint: t('Browse the marketplace or add one manually'),
      }
    case 'automation':
    default:
      return {
        selectText: t('Select a digital human to view details'),
        selectHint: t('Choose a digital human to view details'),
        icon: Blocks,
        emptyTitle: t('No digital humans yet'),
        emptyHint: t('Use the sidebar to create your first digital human'),
      }
  }
}

export function EmptyState({ hasApps, variant = 'automation' }: EmptyStateProps) {
  const copy = useVariantCopy(variant)
  const Icon = copy.icon

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 sm:p-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
        <Icon className="w-6 h-6 text-muted-foreground" />
      </div>

      {hasApps ? (
        <div>
          <p className="text-sm font-medium text-foreground">{copy.selectText}</p>
          <p className="text-xs text-muted-foreground mt-1">{copy.selectHint}</p>
        </div>
      ) : (
        <div>
          <p className="text-sm font-medium text-foreground">{copy.emptyTitle}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">{copy.emptyHint}</p>
        </div>
      )}
    </div>
  )
}
