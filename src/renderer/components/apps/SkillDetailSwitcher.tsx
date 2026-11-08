import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { SkillGroup } from '../../../shared/types/skills'
import { useSkillInventory } from '../../hooks/useSkillInventory'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { selectedSkill, skillDisplay } from '../../utils/skill-presentation'
import { AppTypeIcon } from '../store/AppTypeIcon'
import { DetailSwitcher, type DetailSwitcherItem } from './DetailSwitcher'

interface SkillDetailSwitcherProps {
  spaceId: string | null
  selectedGroup: SkillGroup
  onSelect: (group: SkillGroup) => void
  revision?: number
}

const pageSize = 50

export function SkillDetailSwitcher({ spaceId, selectedGroup, onSelect, revision = 0 }: SkillDetailSwitcherProps) {
  const { t } = useTranslation()
  const collapsed = useAppsPageStore(state => state.switcherCollapsed)
  const [search, setSearch] = useState('')
  const [q, setQuery] = useState('')
  const [page, setPage] = useState({ scope: '', offset: 0 })
  const scope = JSON.stringify([spaceId, q])
  const offset = page.scope === scope ? page.offset : 0
  const { data, loading, error, refresh } = useSkillInventory({ spaceId, q, offset, limit: pageSize })
  const previousRevision = useRef(revision)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision
      refresh()
    }
  }, [revision, refresh])

  const language = getCurrentLanguage()
  const items = useMemo<DetailSwitcherItem[]>(() => (data?.groups ?? []).map(group => {
    const copy = selectedSkill(group)
    const display = copy ? skillDisplay(copy, language) : null
    const name = display?.name ?? group.displayName
    return {
      id: group.name,
      name,
      description: display?.description ?? group.description,
      icon: <AppTypeIcon type="skill" icon={copy?.icon} name={name} size="xs" />,
      dimmed: copy ? !copy.enabled : false,
    }
  }), [data, language])
  const pending = loading || search.trim() !== q
  const notice = error
    ? t('Could not refresh your skills. Please try again.')
    : data?.warnings.length
      ? t('Some skills could not be loaded. Your other skills are still available.')
      : null
  const empty = data && !pending && !notice && data.groups.length === 0
  const paginated = offset > 0 || (data?.total ?? 0) > pageSize
  const footer = (notice || empty || paginated) && (
    <div className={`shrink-0 ${collapsed ? 'w-full px-1 py-2' : 'px-3 pb-3'}`}>
      {notice && (
        <div role={error ? 'alert' : 'status'} className="mb-2 text-xs text-muted-foreground">
          {!collapsed && <p className="mb-1">{notice}</p>}
          <button
            type="button"
            onClick={refresh}
            disabled={pending}
            aria-label={t('Retry')}
            title={notice}
            className="flex min-h-8 items-center justify-center gap-1 rounded-sm px-2 text-primary hover:bg-secondary disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {!collapsed && t('Retry')}
          </button>
        </div>
      )}
      {!collapsed && empty && (
        <p className="py-3 text-center text-xs text-muted-foreground">{t('No matching results found')}</p>
      )}
      {paginated && (
        <div className={`flex items-center ${collapsed ? 'flex-col gap-1' : 'justify-between gap-2'}`}>
          <button
            type="button"
            disabled={pending || offset === 0}
            onClick={() => setPage({ scope, offset: Math.max(0, offset - pageSize) })}
            aria-label={t('Previous')}
            title={t('Previous')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {!collapsed && data && <span className="text-xs tabular-nums text-muted-foreground">{t('{{count}} skills', { count: data.total })}</span>}
          <button
            type="button"
            disabled={pending || !data || offset + data.groups.length >= data.total}
            onClick={() => setPage({ scope, offset: offset + pageSize })}
            aria-label={t('Next')}
            title={t('Next')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )

  return (
    <nav aria-label={t('Skills')} className="flex min-h-0">
      <DetailSwitcher
        title={t('Skills')}
        searchPlaceholder={t('Search skills')}
        items={items}
        selectedId={selectedGroup.name}
        onSelect={id => {
          const group = data?.groups.find(item => item.name === id)
          if (group) onSelect(group)
        }}
        controlledQuery={search}
        onQueryChange={setSearch}
        loading={pending}
        footer={footer}
      />
    </nav>
  )
}
