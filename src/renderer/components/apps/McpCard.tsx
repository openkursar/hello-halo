/**
 * McpCard
 *
 * Grid card for one installed MCP server. Connection health is the server's
 * actual runtime state (unlike Skill, which has none) — the card surfaces it
 * directly instead of making users open the detail page to find out whether
 * a server is even reachable.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { PlugZap, Globe, MoreHorizontal, FolderInput, Trash2, Check, Loader2, Power, PowerOff, RotateCcw } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import type { McpSpec } from '../../../shared/apps/spec-types'
import type { McpServerStatus } from '../../types'
import { useAppsStore, useMcpDependents } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { SpaceAvatar } from '../space/SpaceAvatar'
import { Tooltip } from '../ui/Tooltip'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { deriveMcpHealth, mcpHealthText, mcpHealthDotClass, type McpHealth } from '../../utils/mcpStatus'
import { formatTimeAgo } from '../../utils/format-time'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { api } from '../../api'

interface McpCardProps {
  app: InstalledApp
  sdkEntry?: McpServerStatus
  spaceMap: Record<string, string>
  /** Digital humans declaring this server, from the capability inventory. */
  declaredBy?: number
  onOpen: () => void
}

function healthTextClass(health: McpHealth): string {
  switch (health) {
    case 'connected':     return 'text-green-600 dark:text-green-400'
    case 'failed':        return 'text-halo-error'
    case 'needs-login':
    case 'session-stale': return 'text-halo-warning'
    case 'disabled':      return 'text-subtle-foreground'
    default:               return 'text-muted-foreground'
  }
}

export function McpCard({ app, sdkEntry, spaceMap, declaredBy, onOpen }: McpCardProps) {
  const { t } = useTranslation()
  const { pauseApp, resumeApp, uninstallApp, moveAppToSpace, reinstallApp } = useAppsStore()
  const dependents = useMcpDependents()
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const spaces = useSpaceStore(s => s.spaces)
  const { showConfirm, DialogComponent } = useConfirmDialog()

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuView, setMenuView] = useState<'main' | 'move'>('main')
  const [testing, setTesting] = useState(false)
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

  const spec = app.spec as McpSpec
  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
  const health = deriveMcpHealth(app, sdkEntry)
  const isPaused = app.status === 'paused'
  const isUninstalled = app.status === 'uninstalled'
  const tools = sdkEntry?.tools ?? []
  const usedByCount = (dependents[app.specId] ?? []).length
  const spaceLabel = app.spaceId ? (spaceMap[app.spaceId] ?? app.spaceId) : t('Global')
  const needsAttention = health === 'failed' || health === 'needs-login' || health === 'session-stale'

  const handleTest = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (testing) return
    setTesting(true)
    try {
      await api.probeMcpApp(app.id)
    } finally {
      setTesting(false)
    }
  }, [app.id, testing])

  const handleToggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    await (isPaused ? resumeApp(app.id) : pauseApp(app.id))
  }, [app.id, isPaused, pauseApp, resumeApp])

  const handleUninstall = useCallback(async () => {
    setMenuOpen(false)
    const confirmed = await showConfirm({
      title: t('Uninstall this MCP server?'),
      message: usedByCount > 0
        ? t('{{count}} digital humans depend on it — they will lose access to its tools. You can reinstall it later from the Uninstalled group.', { count: usedByCount })
        : t('You can reinstall it later from the Uninstalled group.'),
      confirmLabel: t('Uninstall'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (confirmed) await uninstallApp(app.id)
  }, [app.id, showConfirm, t, uninstallApp, usedByCount])

  const handleMoveTo = useCallback(async (newSpaceId: string | null) => {
    setMenuOpen(false)
    setMenuView('main')
    await moveAppToSpace(app.id, newSpaceId)
  }, [app.id, moveAppToSpace])

  const allSpaces = [
    ...(haloSpace ? [haloSpace] : []),
    ...spaces.filter(s => !haloSpace || s.id !== haloSpace.id),
  ]

  const shownTools = tools.slice(0, 3)
  const overflowCount = tools.length - shownTools.length

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
          : needsAttention
            ? 'border-halo-error/40'
            : 'border-border/60 hover:border-border hover:shadow-sm'}`}
    >

      <div className="flex items-start gap-2.5">
        <div className="flex-shrink-0 w-9 h-9 rounded-md bg-secondary flex items-center justify-center">
          <PlugZap className="w-4 h-4 text-muted-foreground" />
        </div>
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
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${mcpHealthDotClass(health)}`} />
            <p className={`text-xs truncate ${healthTextClass(health)}`}>
              {mcpHealthText(health, t, tools.length) || t('Not yet tested')}
            </p>
          </div>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[10px] px-1.5 py-px rounded-full bg-secondary text-muted-foreground">
              {spec.mcp_server?.transport ?? 'stdio'}
            </span>
          </div>
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
          ) : !isPaused && (
            <button
              onClick={handleTest}
              disabled={testing}
              title={t('Test connection')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors disabled:opacity-40"
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={handleToggle}
            title={isPaused ? t('Enable') : t('Disable')}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {/* Glyph shows what a click does (same convention as SkillCard's
                toggle), not the current state. */}
            {isPaused
              ? <Power className="w-3.5 h-3.5" />
              : <PowerOff className="w-3.5 h-3.5" />}
          </button>
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
                    <button onClick={() => { setMenuOpen(false); onOpen() }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      {t('Edit configuration')}
                    </button>
                    <button onClick={() => setMenuView('move')} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <FolderInput className="w-3.5 h-3.5 text-muted-foreground" /> {t('Move to workspace')}
                    </button>
                    <div className="my-1 border-t border-border/60" />
                    <button onClick={handleUninstall} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-red-500/10 text-red-500 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" /> {t('Uninstall')}
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => handleMoveTo(null)} className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <span className="flex items-center gap-2"><Globe className="w-3.5 h-3.5 text-muted-foreground" /> {t('Global (all workspaces)')}</span>
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

      {shownTools.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {shownTools.map(tool => (
            <span key={tool} className="text-[10px] px-1.5 py-px rounded bg-secondary/70 text-muted-foreground font-mono truncate max-w-[100px]">
              {tool}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="text-[10px] text-muted-foreground">+{overflowCount}</span>
          )}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {sdkEntry?.lastCheckedAt != null && <span>{formatTimeAgo(sdkEntry.lastCheckedAt, t)}</span>}
        {sdkEntry?.latencyMs != null && <><span>·</span><span className="tabular-nums">{sdkEntry.latencyMs}ms</span></>}
        {declaredBy ? <span className="ml-auto">{t('Declared by {{count}} digital humans', { count: declaredBy })}</span> : null}
      </div>

      {DialogComponent}
    </div>
  )
}
