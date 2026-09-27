/**
 * CapabilitySwitcher — DetailSwitcher rows for installed skills or MCP
 * servers, in install order (the card wall groups by status, which would
 * move rows as items are enabled or disabled).
 */

import { useMemo } from 'react'
import { useAppsStore } from '../../stores/apps.store'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { AppTypeIcon } from '../store/AppTypeIcon'
import { DetailSwitcher, type DetailSwitcherItem } from './DetailSwitcher'

interface CapabilitySwitcherProps {
  type: 'skill' | 'mcp'
  selectedAppId: string
  onSelect: (appId: string) => void
}

export function CapabilitySwitcher({ type, selectedAppId, onSelect }: CapabilitySwitcherProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)

  const language = getCurrentLanguage()
  const items = useMemo<DetailSwitcherItem[]>(
    () => apps
      .filter(app => app.spec.type === type && app.status !== 'uninstalled')
      .map(app => {
        const name = resolveSpecI18n(app.spec, language).name || app.id
        return {
          id: app.id,
          name,
          icon: <AppTypeIcon type={type} icon={app.spec.icon} name={name} size="xs" />,
          dimmed: app.status === 'paused',
        }
      }),
    [apps, type, language]
  )

  return (
    <DetailSwitcher
      title={type === 'skill' ? t('Skills') : t('MCP connections')}
      searchPlaceholder={type === 'skill' ? t('Search skills') : t('Search MCP servers or tools')}
      items={items}
      selectedId={selectedAppId}
      onSelect={onSelect}
    />
  )
}
