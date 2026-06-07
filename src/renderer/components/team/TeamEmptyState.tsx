/**
 * TeamEmptyState — right-pane placeholder for the team tab.
 *
 * Shown when no team is selected. For brand-new users (no teams at all) it
 * surfaces a "create your first office" CTA; otherwise it prompts the user to
 * pick a team from the list.
 */

import { Plus } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface TeamEmptyStateProps {
  hasTeams: boolean
  onNewTeam: () => void
}

/** A small stylized org-chart illustration (theme-aware, no raster asset). */
function OrgChartGlyph() {
  return (
    <svg viewBox="0 0 120 96" className="h-24 w-28" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="team-empty-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.18" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.04" />
        </linearGradient>
      </defs>
      {/* connectors */}
      <path d="M60 30 V46 M28 64 V56 H92 V64" fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
      {/* lead */}
      <rect x="42" y="10" width="36" height="20" rx="5" fill="url(#team-empty-fade)" stroke="hsl(var(--primary))" strokeWidth="1.3" />
      {/* members */}
      <rect x="12" y="64" width="32" height="20" rx="5" fill="hsl(var(--background))" stroke="hsl(var(--border))" strokeWidth="1.2" />
      <rect x="44" y="64" width="32" height="20" rx="5" fill="hsl(var(--background))" stroke="hsl(var(--border))" strokeWidth="1.2" />
      <rect x="76" y="64" width="32" height="20" rx="5" fill="hsl(var(--background))" stroke="hsl(var(--border))" strokeWidth="1.2" />
    </svg>
  )
}

export function TeamEmptyState({ hasTeams, onNewTeam }: TeamEmptyStateProps) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <OrgChartGlyph />
      {hasTeams ? (
        <p className="max-w-sm text-sm text-muted-foreground">
          {t('Select a team to view its status and artifacts, or create a new office.')}
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className="text-base font-medium text-foreground">{t('Create your first office')}</p>
            <p className="max-w-md text-sm text-muted-foreground">
              {t('Group a set of digital humans into a team and describe a goal in plain words — a lead will break it down and coordinate them to get it done.')}
            </p>
          </div>
          <button
            onClick={onNewTeam}
            className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('New office')}
          </button>
        </>
      )}
    </div>
  )
}
