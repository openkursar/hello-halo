/**
 * AppMcpDepsSection
 *
 * Visualizes the external MCP tools an automation digital human depends on.
 *
 * At runtime the automation only receives MCP servers it declares in
 * `requires.mcps` AND that are installed + active in its space (least
 * privilege — see execute.ts getMcpServersForRequires). A missing or paused
 * dependency is otherwise silent: the run just loses those tools. This section
 * makes that state visible — each declared dependency shows a live health
 * badge (connected / disabled / not installed / connection failed), and
 * missing ones are highlighted so the user understands why a run underperforms.
 *
 * Unlike built-in Capabilities (guaranteed present, plain on/off), MCP
 * dependencies may be absent — hence the health-list visual language rather
 * than a switch. The row switch pauses/resumes the underlying MCP server
 * (space-wide); adding/removing a dependency edits this digital human's
 * `requires.mcps` (local to this app).
 *
 * Data is joined entirely on the client from existing stores (installed apps +
 * the agent:mcp-status broadcast) — no new backend surface.
 */

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import {
  Wrench, ChevronDown, ChevronRight, Plus, Loader2, PlugZap,
  ExternalLink, Trash2, AlertTriangle, Download, Info,
} from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore, tabForAppType } from '../../stores/apps-page.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { BUILTIN_MCP_SERVER_IDS } from '../../../shared/apps/builtin-mcp'
import type { McpSpec, McpDependency } from '../../../shared/apps/spec-types'
import type { McpServerStatus } from '../../types'

interface AppMcpDepsSectionProps {
  app: InstalledApp
  appId: string
  /** Raises the visible manual-restart fallback banner (change also auto-applies). */
  onRequireRestart: () => void
}

// ── Health resolution ────────────────────────────────────────────────────────

type Health = 'connected' | 'disabled' | 'not-installed' | 'failed' | 'needs-login' | 'unprobed'

interface ResolvedDep {
  /** Declared dependency spec id */
  specId: string
  /** Author-provided reason for the dependency, if any */
  reason?: string
  /**
   * Whether THIS digital human uses the dependency (per-app switch,
   * requires.mcps[].enabled). Absent flag means enabled.
   */
  enabled: boolean
  /** The installed MCP app backing this dependency, or null if not installed */
  mcpApp: InstalledApp | null
  /** Live SDK/probe status entry, if any */
  sdkEntry?: McpServerStatus
  /** Shared MCP server's own availability/health (independent of `enabled`) */
  health: Health
}

function resolveHealth(mcpApp: InstalledApp | null, sdkEntry?: McpServerStatus): Health {
  if (!mcpApp) return 'not-installed'
  if (mcpApp.status === 'paused') return 'disabled'
  if (mcpApp.status === 'error') return 'failed'
  if (mcpApp.status === 'needs_login') return 'needs-login'
  if (sdkEntry) {
    if (sdkEntry.status === 'failed') return 'failed'
    if (sdkEntry.status === 'needs-auth') return 'needs-login'
    if (sdkEntry.status === 'connected') return 'connected'
  }
  return 'unprobed'
}

function healthDotClass(health: Health): string {
  switch (health) {
    case 'connected':    return 'bg-green-500'
    case 'failed':       return 'bg-red-500'
    case 'needs-login':  return 'bg-amber-500'
    case 'not-installed':return 'bg-amber-500'
    case 'disabled':     return 'bg-muted-foreground/40'
    default:             return 'bg-muted-foreground/40'
  }
}

// ── Add-dependency dropdown ──────────────────────────────────────────────────

function AddDependencyMenu({
  candidates,
  onAdd,
  onBrowseStore,
}: {
  candidates: InstalledApp[]
  onAdd: (specId: string) => void
  onBrowseStore: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        {t('Add dependency')}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] max-h-[280px] overflow-y-auto bg-popover border border-border rounded-lg shadow-lg py-1 text-[12px]">
          {candidates.length > 0 ? (
            candidates.map(mcp => (
              <button
                key={mcp.id}
                onClick={() => { onAdd(mcp.specId); setOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors text-foreground"
              >
                <Wrench className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{mcp.spec.name}</span>
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-muted-foreground">
              {t('No other MCP servers installed in this space.')}
            </p>
          )}
          <div className="my-1 border-t border-border/50" />
          <button
            onClick={() => { onBrowseStore(); setOpen(false) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors text-primary"
          >
            <Download className="w-3 h-3 flex-shrink-0" />
            {t('Browse MCP store')}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Single dependency row ────────────────────────────────────────────────────

function DepRow({
  dep,
  onRemove,
  onSetEnabled,
  onInstall,
  onOpenDetail,
}: {
  dep: ResolvedDep
  onRemove: (specId: string) => void
  onSetEnabled: (specId: string, enabled: boolean) => Promise<void> | void
  onInstall: () => void
  onOpenDetail: (mcpApp: InstalledApp) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  const { mcpApp, sdkEntry, health, reason, enabled } = dep
  const name = mcpApp ? resolveSpecI18n(mcpApp.spec, getCurrentLanguage()).name : dep.specId
  const server = mcpApp?.spec.type === 'mcp' ? (mcpApp.spec as McpSpec).mcp_server : undefined
  const toolCount = sdkEntry?.tools?.length ?? 0
  const isMissing = health === 'not-installed'
  // Shared server paused space-wide: its tools cannot be injected regardless of
  // this digital human's own switch, so the switch must read as inactive (gray).
  const serverUnavailable = health === 'disabled'

  // Server-side availability text — independent of the per-app enable switch.
  // Empty for an installed-but-unprobed server (no news is good news).
  const statusText = (() => {
    switch (health) {
      case 'connected':    return toolCount > 0 ? t('Connected · {{count}} tools', { count: toolCount }) : t('Connected')
      case 'disabled':     return t('MCP server globally disabled')
      case 'failed':       return t('Connection failed')
      case 'needs-login':  return t('Needs login')
      case 'not-installed':return t('Not installed')
      default:             return ''
    }
  })()

  async function handleToggle() {
    if (toggling) return
    setToggling(true)
    try {
      await onSetEnabled(dep.specId, !enabled)
    } finally {
      setToggling(false)
    }
  }

  async function handleTest() {
    if (!mcpApp || testing) return
    setTesting(true)
    setTestError(null)
    try {
      const res = await api.probeMcpApp(mcpApp.id)
      if (!res.success) setTestError(res.error ?? t('Connection test failed'))
    } catch (e) {
      setTestError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={`rounded-lg border transition-colors ${
      isMissing && enabled ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-secondary/40'
    }`}>
      {/* Row header */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${enabled ? healthDotClass(health) : 'bg-muted-foreground/30'}`} />
        <button
          onClick={() => setExpanded(v => !v)}
          className={`flex items-center gap-1.5 min-w-0 flex-1 text-left ${enabled ? '' : 'opacity-50'}`}
        >
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
          <span className="text-sm text-foreground truncate">{name}</span>
        </button>
        {statusText && (
          <span className={`text-xs flex-shrink-0 ${
            !enabled ? 'text-muted-foreground/50'
            : health === 'connected' ? 'text-green-600 dark:text-green-400'
            : health === 'failed' ? 'text-red-500'
            : (health === 'needs-login' || health === 'not-installed') ? 'text-amber-500'
            : 'text-muted-foreground'
          }`}>
            {statusText}
          </span>
        )}

        {/* Why-disabled explainer: the shared server is paused space-wide, so
            spell out the consequence and point to where to re-enable it. */}
        {serverUnavailable && mcpApp && (
          <Popover>
            <PopoverTrigger
              title={t('Why disabled?')}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Info className="w-3.5 h-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3 text-xs space-y-2">
              <p className="text-muted-foreground leading-relaxed">
                {t('The MCP server is disabled globally, so this digital human will not inject its tools at runtime.')}
              </p>
              <button
                onClick={() => onOpenDetail(mcpApp)}
                className="flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="w-3 h-3 flex-shrink-0" />
                {t('Open MCP management to enable')}
              </button>
            </PopoverContent>
          </Popover>
        )}

        {/* Per-digital-human switch: does THIS digital human use the dependency.
            Never touches the shared MCP server's own status. */}
        <button
          type="button"
          role="switch"
          aria-label={enabled ? t('Disable for this digital human') : t('Enable for this digital human')}
          aria-checked={enabled}
          disabled={toggling}
          onClick={handleToggle}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors disabled:opacity-50
            ${enabled && !serverUnavailable ? 'bg-primary' : 'bg-muted'}`}
        >
          {toggling ? (
            <Loader2 className="absolute inset-0 m-auto w-3 h-3 animate-spin text-white/70" />
          ) : (
            <span className={`inline-block h-4 w-4 rounded-full bg-background shadow-sm transform transition-transform mt-0.5
              ${enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
          )}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-border/50">
          {reason && (
            <div className="text-xs">
              <span className="text-muted-foreground">{t('Reason')}: </span>
              <span className="text-foreground">{reason}</span>
            </div>
          )}

          {isMissing ? (
            <div className="space-y-2">
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                {t('This dependency is declared but not installed in this space. Runs will be missing its tools until it is installed.')}
              </p>
              <button
                onClick={onInstall}
                className="flex items-center gap-1 px-2 py-1 text-xs text-amber-600 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 rounded transition-colors"
              >
                <Download className="w-3 h-3" />
                {t('Install')}
              </button>
            </div>
          ) : (
            <>
              {server && (
                <div className="text-xs font-mono bg-secondary rounded-md p-2 space-y-1">
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-16 flex-shrink-0">{t('Transport')}</span>
                    <span className="text-foreground">{server.transport ?? 'stdio'}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-16 flex-shrink-0">
                      {(server.transport === 'sse' || server.transport === 'streamable-http') ? t('URL') : t('Command')}
                    </span>
                    <span className="text-foreground break-all">{server.command}</span>
                  </div>
                </div>
              )}

              {sdkEntry?.tools && sdkEntry.tools.length > 0 && (
                <div className="text-xs">
                  <span className="text-muted-foreground">{t('Tools')}: </span>
                  <span className="text-foreground font-mono break-all">{sdkEntry.tools.join(', ')}</span>
                </div>
              )}

              {(health === 'failed' || health === 'needs-login') && sdkEntry?.errorDetail && (
                <p className="text-[11px] font-mono text-red-500/80 break-all">{sdkEntry.errorDetail}</p>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors disabled:opacity-50"
                >
                  {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlugZap className="w-3 h-3" />}
                  {t('Test connection')}
                </button>
                {mcpApp && (
                  <button
                    onClick={() => onOpenDetail(mcpApp)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {t('Open MCP detail')}
                  </button>
                )}
              </div>
              {testError && <p className="text-[11px] text-red-500">{testError}</p>}
            </>
          )}

          {/* Scope note + remove this dependency declaration */}
          <div className="pt-1 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground/60">
              {t('The switch only affects this digital human — it never changes the MCP server itself.')}
            </p>
            <button
              onClick={() => onRemove(dep.specId)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 rounded transition-colors flex-shrink-0"
            >
              <Trash2 className="w-3 h-3" />
              {t('Remove')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main section ─────────────────────────────────────────────────────────────

export function AppMcpDepsSection({ app, appId, onRequireRestart }: AppMcpDepsSectionProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const { updateAppSpec } = useAppsStore()
  const mcpStatus = useAppStore(s => s.mcpStatus)

  // Full declared list — the source of truth we write back to (preserves any
  // built-in entries the spec documents, so edits never silently drop them).
  const allDeclaredMcps: McpDependency[] = useMemo(
    () => (app.spec.requires?.mcps ?? []),
    [app.spec.requires?.mcps]
  )

  // External MCP dependencies only, for display. Built-in capability ids
  // (ai-browser, etc.) are filtered out — they belong to the Capabilities
  // section, not here, and must never show as "not installed".
  const declaredMcps: McpDependency[] = useMemo(
    () => allDeclaredMcps.filter(dep => !BUILTIN_MCP_SERVER_IDS.has(dep.id)),
    [allDeclaredMcps]
  )

  // Effective MCP apps for this space: space-scoped ∪ global, space overrides
  // global by specId. Mirrors manager.listEffectiveByType('mcp', spaceId).
  const effectiveMcpApps = useMemo(() => {
    const spaceId = app.spaceId
    const usable = apps.filter(a => a.spec.type === 'mcp' && a.status !== 'uninstalled')
    const spaceApps = usable.filter(a => a.spaceId === spaceId)
    const spaceSpecIds = new Set(spaceApps.map(a => a.specId))
    const globalApps = usable.filter(a => a.spaceId === null && !spaceSpecIds.has(a.specId))
    return [...spaceApps, ...globalApps]
  }, [apps, app.spaceId])

  const resolvedDeps: ResolvedDep[] = useMemo(
    () => declaredMcps.map(dep => {
      const mcpApp = effectiveMcpApps.find(a => a.specId === dep.id) ?? null
      const sdkEntry = mcpStatus.find(s => s.name === dep.id)
      return {
        specId: dep.id,
        reason: dep.reason,
        enabled: dep.enabled !== false,
        mcpApp,
        sdkEntry,
        health: resolveHealth(mcpApp, sdkEntry),
      }
    }),
    [declaredMcps, effectiveMcpApps, mcpStatus]
  )

  // Installed MCP servers not yet declared as dependencies (candidates to add)
  const addCandidates = useMemo(() => {
    const declared = new Set(declaredMcps.map(d => d.id))
    return effectiveMcpApps.filter(a => !declared.has(a.specId))
  }, [effectiveMcpApps, declaredMcps])

  // Persist requires.mcps. The backend auto-restarts this app's chat session on
  // the change so it applies next message; the fallback banner is surfaced too.
  const writeMcps = useCallback(async (next: McpDependency[]) => {
    const ok = await updateAppSpec(appId, {
      requires: { ...(app.spec.requires ?? {}), mcps: next },
    })
    if (ok) onRequireRestart()
  }, [appId, app.spec.requires, updateAppSpec, onRequireRestart])

  const handleAdd = useCallback((specId: string) => {
    if (allDeclaredMcps.some(d => d.id === specId)) return
    writeMcps([...allDeclaredMcps, { id: specId }])
  }, [allDeclaredMcps, writeMcps])

  const handleRemove = useCallback((specId: string) => {
    writeMcps(allDeclaredMcps.filter(d => d.id !== specId))
  }, [allDeclaredMcps, writeMcps])

  // Per-digital-human enable switch — writes requires.mcps[].enabled on THIS
  // app's own spec. Enabling drops the flag (clean YAML, default = enabled);
  // disabling sets enabled:false. The shared MCP server is never touched.
  const setDepEnabled = useCallback((specId: string, enabled: boolean) => {
    const next = allDeclaredMcps.map(d => {
      if (d.id !== specId) return d
      if (enabled) {
        const { enabled: _drop, ...rest } = d
        return rest
      }
      return { ...d, enabled: false }
    })
    return writeMcps(next)
  }, [allDeclaredMcps, writeMcps])

  const openStore = useCallback(() => {
    void useAppsPageStore.getState().openMarketplaceFilteredBy('mcp')
  }, [])

  const openMcpDetail = useCallback((mcpApp: InstalledApp) => {
    // Switch the tab too, otherwise the detail panel shows the MCP while the
    // left list + tab highlight stay on the digital-humans tab (mismatch).
    const store = useAppsPageStore.getState()
    store.setCurrentTab(tabForAppType('mcp'))
    store.selectApp(mcpApp.id, 'mcp', mcpApp.spaceId ?? undefined)
  }, [])

  // Warn only for dependencies this digital human actually uses (enabled).
  const missingCount = resolvedDeps.filter(d => d.enabled && d.health === 'not-installed').length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5" />
          {t('MCP Tools')}
          {resolvedDeps.length > 0 && (
            <span className="text-muted-foreground/60 font-normal normal-case tracking-normal">
              ({resolvedDeps.length})
            </span>
          )}
        </h3>
        <AddDependencyMenu candidates={addCandidates} onAdd={handleAdd} onBrowseStore={openStore} />
      </div>

      {missingCount > 0 && (
        <p className="text-xs text-amber-500 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {t('{{count}} declared MCP dependency is not installed in this space.', { count: missingCount })}
        </p>
      )}

      {resolvedDeps.length > 0 ? (
        <div className="space-y-1.5">
          {resolvedDeps.map(dep => (
            <DepRow
              key={dep.specId}
              dep={dep}
              onRemove={handleRemove}
              onSetEnabled={setDepEnabled}
              onInstall={openStore}
              onOpenDetail={openMcpDetail}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-4 text-center space-y-2">
          <p className="text-xs text-muted-foreground">
            {t('This digital human declares no external MCP dependencies.')}
          </p>
          <div className="flex items-center justify-center gap-2">
            {addCandidates.length > 0 && (
              <AddDependencyMenu candidates={addCandidates} onAdd={handleAdd} onBrowseStore={openStore} />
            )}
            <button
              onClick={openStore}
              className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              {t('Browse MCP store')}
            </button>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/60 flex items-start gap-1">
        <span>{t('Only declared MCP servers are injected at runtime (least privilege).')}</span>
      </p>
    </div>
  )
}
