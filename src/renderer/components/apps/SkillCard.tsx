import { useEffect, useRef, useState } from 'react'
import { Check, FolderOpen, Globe, Loader2, MoreHorizontal, Power, PowerOff, Trash2 } from 'lucide-react'
import type { SkillGroup } from '../../../shared/types/skills'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { isElectron } from '../../api/transport'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useSpaceStore } from '../../stores/space.store'
import { useSkillActions } from '../../hooks/useSkillActions'
import { selectedSkill, skillDisplay, skillSourceLabel } from '../../utils/skill-presentation'
import { AppTypeIcon } from '../store/AppTypeIcon'
import { useStoreUpdateFlow } from '../store/useStoreUpdateFlow'

interface SkillCardProps {
  group: SkillGroup
  spaceMap: Record<string, string>
  contextSpaceId: string | null
  onOpen: () => void
  onChanged: () => void
}

export function SkillCard({ group, spaceMap, contextSpaceId, onOpen, onChanged }: SkillCardProps) {
  const { t } = useTranslation()
  const copy = selectedSkill(group)
  const display = copy ? skillDisplay(copy, getCurrentLanguage()) : { name: group.displayName, description: group.description }
  const actions = useSkillActions({ spaceId: contextSpaceId, id: copy?.id ?? '' }, onChanged)
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const update = useAppsPageStore(state => state.availableUpdates.find(item => item.appId === copy?.appId))
  const updateFlow = useStoreUpdateFlow(update?.entry, update, undefined, onChanged)
  const [menu, setMenu] = useState<'main' | 'move' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    function close(event: MouseEvent) { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null) } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [menu])
  const unavailable = !copy || ['missing', 'invalid'].includes(copy.availability)
  const scope = copy?.spaceId ? spaceMap[copy.spaceId] ?? t('Workspace') : t('Global')
  const allSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]
  const iconButton = 'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40'
  const menuItem = 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-secondary disabled:opacity-40'

  return <div role="button" tabIndex={0} onClick={onOpen}
    onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } }}
    className="group relative flex min-w-0 cursor-pointer flex-col rounded-lg border border-border-soft bg-card p-4 text-left transition-all hover:border-border hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <div className="flex items-start gap-2.5">
      <AppTypeIcon type="skill" icon={copy?.icon} name={display.name} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="truncate text-sm font-semibold leading-tight text-foreground" title={display.name}>{display.name}</h3>
          <span className="max-w-[45%] truncate rounded bg-secondary/70 px-1.5 py-0.5 text-[10px] text-muted-foreground" title={copy?.scope === 'global' ? t('Available in every workspace') : scope}>{scope}</span>
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">/{group.name}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <button type="button" title={copy?.enabled ? t('Disable') : t('Enable')} aria-label={copy?.enabled ? t('Disable') : t('Enable')} disabled={!copy || (unavailable && !copy.enabled) || actions.busy || group.conflict}
          onClick={() => void actions.toggle()} className={iconButton}>
          {actions.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : copy?.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
        </button>
        <div ref={menuRef} className="relative">
          <button type="button" aria-label={t('More')} aria-expanded={menu !== null} onClick={() => setMenu(value => value ? null : 'main')} className={iconButton}><MoreHorizontal className="h-3.5 w-3.5" /></button>
          {menu && <div className="absolute right-0 top-full z-20 mt-1 min-w-[180px] max-w-[240px] rounded-lg border border-border bg-popover py-1 shadow-lg">
            {menu === 'main' ? <>
              {isElectron() && <button className={menuItem} disabled={actions.busy || !copy || copy.availability === 'missing'} onClick={() => { setMenu(null); void actions.openFolder() }}><FolderOpen className="h-3.5 w-3.5" />{t('Open skill folder')}</button>}
              <button className={menuItem} disabled={actions.busy || unavailable} onClick={() => setMenu('move')}><Globe className="h-3.5 w-3.5" />{t('Move to workspace')}</button>
              <div className="my-1 border-t border-border-soft" />
              <button className={`${menuItem} text-halo-error`} disabled={actions.busy || !copy} onClick={() => { setMenu(null); void actions.remove() }}><Trash2 className="h-3.5 w-3.5" />{t('Delete')}</button>
            </> : <>
              <button className={menuItem} onClick={() => { setMenu(null); void actions.move(null, t('Global (all spaces)')) }}><Globe className="h-3.5 w-3.5" />{t('Global (all spaces)')}{!copy?.spaceId && <Check className="ml-auto h-3.5 w-3.5" />}</button>
              {allSpaces.map(space => <button key={space.id} className={menuItem} onClick={() => { setMenu(null); void actions.move(space.id, space.isTemp ? t('Halo') : space.name) }}><span className="truncate">{space.isTemp ? t('Halo') : space.name}</span>{copy?.spaceId === space.id && <Check className="ml-auto h-3.5 w-3.5" />}</button>)}
            </>}
          </div>}
        </div>
      </div>
    </div>
    {display.description && <p className="mt-2.5 line-clamp-2 text-xs text-muted-foreground">{display.description}</p>}
    {actions.error && <p role="alert" className="mt-2 text-xs text-halo-error">{actions.error}</p>}
    <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-2.5 text-[11px] text-muted-foreground">
      <span className="truncate">{copy && skillSourceLabel(copy, t)}</span>
      {copy && !copy.enabled && <span className="rounded bg-secondary px-1.5 py-0.5">{t('Disabled')}</span>}
      {(unavailable || group.conflict) && <span className="text-halo-error">{group.conflict ? t('Name conflict') : t('Needs attention')}</span>}
      {copy?.version && <span className="ml-auto shrink-0 font-mono">v{copy.version}</span>}
      {update && <button type="button" disabled={updateFlow.busy} onClick={event => { event.stopPropagation(); updateFlow.start() }} className="shrink-0 rounded-full border border-halo-success/30 bg-halo-success/10 px-1.5 py-0.5 text-halo-success hover:bg-halo-success/20">{t('Update to v{{version}}', { version: update.latestVersion })}</button>}
    </div>
    <div onClick={event => event.stopPropagation()}>{actions.DialogComponent}{updateFlow.dialogs}</div>
  </div>
}
