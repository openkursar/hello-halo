/**
 * SkillCard
 *
 * Grid card for one installed Skill in the Skill card wall. Skills have no
 * runtime state (they're ambient — ready whenever in scope), so the card
 * surfaces what current list rows never did: the actual trigger command,
 * scope, source, version, and file count.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Globe, MoreHorizontal, FolderInput, Trash2, Check, Power, PowerOff, RotateCcw } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import type { SkillSpec } from '../../../shared/apps/spec-types'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { SpaceAvatar } from '../space/SpaceAvatar'
import { AppTypeIcon } from '../store/AppTypeIcon'
import { Tooltip } from '../ui/Tooltip'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { deriveSkillCommand } from '../../utils/skill-command'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { api } from '../../api'

interface SkillCardProps {
  app: InstalledApp
  spaceMap: Record<string, string>
  /** Digital humans this skill reaches, from the capability inventory. */
  usageCount?: number
  onOpen: () => void
}

/**
 * Records from before `install_source` existed carry no value at all — the
 * field's own doc comment (spec-types.ts) says to treat that as 'store', not
 * as 'manual'. Only an explicit 'manual' means someone actually placed the
 * files there by hand.
 */
function sourceLabel(source: string | undefined, t: (s: string) => string): string {
  switch (source) {
    case 'manual':  return t('Manual')
    case 'builtin': return t('Built-in')
    case 'bundled': return t('Bundled')
    default:        return t('Store')
  }
}

export function SkillCard({ app, spaceMap, usageCount, onOpen }: SkillCardProps) {
  const { t } = useTranslation()
  const { pauseApp, resumeApp, uninstallApp, moveAppToSpace, reinstallApp } = useAppsStore()
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const spaces = useSpaceStore(s => s.spaces)
  const { showConfirm, DialogComponent } = useConfirmDialog()

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuView, setMenuView] = useState<'main' | 'move'>('main')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setMenuView('main')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  const spec = app.spec as SkillSpec
  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
  const command = deriveSkillCommand(spec.name)
  const isEnabled = app.status === 'active'
  const isError = app.status === 'error'
  const isUninstalled = app.status === 'uninstalled'
  const fileCount = Object.keys(spec.skill_files ?? {}).length
  const meta = [
    sourceLabel(spec.store?.install_source, t),
    spec.version ? `v${spec.version}` : null,
    fileCount > 1 ? t('{{count}} files', { count: fileCount }) : null,
    usageCount ? t('Available to {{count}} digital humans', { count: usageCount }) : null,
  ].filter((v): v is string => v !== null)
  const spaceLabel = app.spaceId ? (spaceMap[app.spaceId] ?? app.spaceId) : t('Global')
  const space = app.spaceId
    ? (spaces.find(s => s.id === app.spaceId) ?? (haloSpace?.id === app.spaceId ? haloSpace : undefined))
    : undefined

  const handleToggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    await (isEnabled ? pauseApp(app.id) : resumeApp(app.id))
  }, [app.id, isEnabled, pauseApp, resumeApp])

  const handleOpenFolder = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    await api.appOpenSkillFolder(app.id)
  }, [app.id])

  const handleUninstall = useCallback(async () => {
    setMenuOpen(false)
    const confirmed = await showConfirm({
      title: t('Uninstall this Skill?'),
      message: t('You can reinstall it later from the Uninstalled group.'),
      confirmLabel: t('Uninstall'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (confirmed) await uninstallApp(app.id)
  }, [app.id, showConfirm, t, uninstallApp])

  const handleMoveTo = useCallback(async (newSpaceId: string | null) => {
    setMenuOpen(false)
    setMenuView('main')
    await moveAppToSpace(app.id, newSpaceId)
  }, [app.id, moveAppToSpace])

  const allSpaces = [
    ...(haloSpace ? [haloSpace] : []),
    ...spaces.filter(s => !haloSpace || s.id !== haloSpace.id),
  ]

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter') onOpen() }}
      className={`group relative text-left bg-card border rounded-lg p-4 transition-all cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
        ${isUninstalled
          ? 'border-dashed opacity-60 hover:opacity-100'
          : isError
            ? 'border-halo-error/40'
            : 'border-border/60 hover:border-border hover:shadow-sm'}`}
    >

      <div className="flex items-start gap-2.5">
        <AppTypeIcon type="skill" icon={spec.icon} name={name} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate leading-tight">{name}</h3>
            <Tooltip
              side="bottom"
              className="flex-shrink-0 max-w-[45%]"
              label={app.spaceId
                ? t('Available in this workspace only: {{name}}', { name: spaceLabel })
                : t('Available in every workspace')}
            >
              <span className="truncate text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/70">
                {spaceLabel}
              </span>
            </Tooltip>
          </div>
          <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">{command}</p>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
          {isUninstalled ? (
            <button
              onClick={e => { e.stopPropagation(); void reinstallApp(app.id) }}
              title={t('Reinstall')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={handleToggle}
              title={isEnabled ? t('Disable') : t('Enable')}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              {/* Glyph shows what a click does (same convention as the detail
                  page's Enable/Disable button), not the current state —
                  one Power icon for both left the two states indistinguishable. */}
              {isEnabled
                ? <PowerOff className="w-3.5 h-3.5" />
                : <Power className="w-3.5 h-3.5" />}
            </button>
          )}
          <div ref={menuRef} className="relative">
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
              title={t('More')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div onClick={e => e.stopPropagation()} className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-popover border border-border rounded-lg shadow-lg py-1 text-sm">
                {menuView === 'main' ? (
                  <>
                    <button onClick={handleOpenFolder} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <FolderInput className="w-3.5 h-3.5 text-muted-foreground" /> {t('Open skill folder')}
                    </button>
                    <button onClick={() => setMenuView('move')} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <Globe className="w-3.5 h-3.5 text-muted-foreground" /> {t('Move to workspace')}
                    </button>
                    <div className="my-1 border-t border-border/60" />
                    <button onClick={handleUninstall} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-halo-error hover:bg-halo-error/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" /> {t('Uninstall')}
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => handleMoveTo(null)} className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <span className="flex items-center gap-2"><Globe className="w-[14px] h-[14px] text-muted-foreground" /> {t('Global (all workspaces)')}</span>
                      {app.spaceId === null && <Check className="w-3.5 h-3.5 text-primary" />}
                    </button>
                    {allSpaces.map(s => (
                      <button key={s.id} onClick={() => handleMoveTo(s.id)} className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                        <span className="flex items-center gap-2 min-w-0">
                          <SpaceAvatar space={s} size={14} />
                          <span className="truncate">{s.isTemp ? t('Halo') : s.name}</span>
                        </span>
                        {app.spaceId === s.id && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {description && <p className="mt-2.5 text-xs text-muted-foreground line-clamp-2">{description}</p>}

      {isError && app.errorMessage && (
        <p className="mt-2.5 text-xs text-halo-error truncate">{app.errorMessage}</p>
      )}

      {meta.length > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {meta.map((part, i) => (
            <span key={part}>{i > 0 && <span className="mr-1.5">·</span>}{part}</span>
          ))}
        </div>
      )}

      {DialogComponent}
    </div>
  )
}
