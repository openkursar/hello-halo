/**
 * AppListItem
 *
 * Single row in the App list sidebar. Shows status dot, name, and
 * an alert indicator when the app is waiting for user input.
 */

import { AlertCircle } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { AppStatusDot } from './AppStatusDot'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { appTypeLabel } from './appTypeUtils'

interface AppListItemProps {
  app: InstalledApp
  isSelected: boolean
  /** Space name to display below the app name */
  spaceName?: string
  onClick: () => void
}

export function AppListItem({ app, isSelected, spaceName, onClick }: AppListItemProps) {
  const { t } = useTranslation()
  const runtimeState = useAppsStore(state => state.appStates[app.id])
  const appType = app.spec.type

  const isWaiting = app.status === 'waiting_user'
  const isUninstalled = app.status === 'uninstalled'

  // `availableUpdates` only contains updates the user must see — auto+patch/minor
  // are applied silently and removed from the list before they would reach us.
  const hasUpdate = useAppsPageStore(state =>
    state.availableUpdates.some(u => u.appId === app.id)
  )

  const { name } = resolveSpecI18n(app.spec, getCurrentLanguage())

  return (
    <button
      onClick={onClick}
      className={`
        w-full flex items-center gap-2 px-3 py-2 text-left rounded-md transition-colors text-sm
        ${isSelected
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
        }
        ${isUninstalled ? 'opacity-50' : ''}
      `}
    >
      <AppStatusDot
        status={app.status}
        runtimeStatus={runtimeState?.status}
        size="sm"
        className="flex-shrink-0"
      />

      <div className="flex-1 min-w-0">
        <span className={`block truncate font-medium ${isUninstalled ? 'line-through' : ''}`}>
          {name}
        </span>
        {spaceName && (
          <span className="block text-[11px] text-muted-foreground/70 truncate">
            {spaceName}
          </span>
        )}
      </div>

      {/* Type badge for MCP/Skill apps */}
      {(appType === 'mcp' || appType === 'skill') && (
        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
          {appTypeLabel(appType)}
        </span>
      )}

      {/* Update-available badge */}
      {hasUpdate && !isUninstalled && (
        <span
          title={t('Update available')}
          className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-primary text-primary-foreground uppercase tracking-wide"
        >
          {t('Update')}
        </span>
      )}

      {/* Escalation alert indicator */}
      {isWaiting && (
        <AlertCircle className="flex-shrink-0 w-3.5 h-3.5 text-orange-400" />
      )}
    </button>
  )
}
