/**
 * CLI Config Section Component
 *
 * Advanced section for Claude CLI integration:
 * - Config directory mode (Halo Default / CC Default / Custom)
 * - Migrate Skills from ~/.claude/skills/ to Halo
 * - Migrate MCP servers from ~/.claude.json to Halo
 *
 * Desktop-only (not shown in remote mode).
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FolderInput,
  Package,
  Settings2,
  Check,
  X,
  RefreshCw,
  ArrowRightLeft,
  Loader2
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { cn } from '../../lib/utils'
import { useMigration } from '../../hooks/useMigration'
import type {
  CliConfigPaths,
  CliSkillEntry,
  CliMcpEntry,
  CliSkillAction,
  CliMcpAction,
  CliMigrateResult,
  ConfigDirMode,
} from '../../types'

// ─── Sub-component: Collapsible panel ────────────────────────────────────────

function Panel({
  title,
  icon,
  badge,
  children,
  defaultOpen = false
}: {
  title: string
  icon: React.ReactNode
  badge?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-muted-foreground">{icon}</span>
          <span className="font-medium text-sm">{title}</span>
          {badge}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="p-4 border-t border-border space-y-3">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Sub-component: Status chip ──────────────────────────────────────────────

function StatusChip({ status }: { status: CliMigrateResult['status'] }) {
  const { t } = useTranslation()
  const map: Record<CliMigrateResult['status'], { label: string; cls: string }> = {
    migrated: { label: t('Migrated'), cls: 'bg-green-500/10 text-green-600 dark:text-green-400' },
    renamed: { label: t('Renamed'), cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
    merged: { label: t('Merged'), cls: 'bg-green-500/10 text-green-600 dark:text-green-400' },
    skipped: { label: t('Skipped'), cls: 'bg-muted text-muted-foreground' },
    error: { label: t('Error'), cls: 'bg-destructive/10 text-destructive' },
  }
  const m = map[status]
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', m.cls)}>
      {m.label}
    </span>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Public export: renders nothing in remote/web mode.
 * All hook logic lives in the inner component to respect Rules of Hooks.
 */
export function CLIConfigSection() {
  if (!isElectron()) return null
  return <CLIConfigSectionInner />
}

function CLIConfigSectionInner() {
  const { t } = useTranslation()

  // Config dir state
  const [paths, setPaths] = useState<CliConfigPaths | null>(null)
  const [configMode, setConfigMode] = useState<ConfigDirMode>('halo')
  const [customDir, setCustomDir] = useState('')
  const [configDirSaving, setConfigDirSaving] = useState(false)
  const [configDirResult, setConfigDirResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [showCcConfirm, setShowCcConfirm] = useState(false)

  // Skills migration (via useMigration hook)
  const skillsMigration = useMigration<CliSkillEntry, CliSkillAction>(useMemo(() => ({
    scan: () => api.cliConfigScanSkills(),
    extractItems: (data) => (data as { skills: CliSkillEntry[] }).skills,
    defaultAction: (item) => item.exists ? 'skip' : 'overwrite',
    getKey: (item) => item.name,
    migrate: (actions) => api.cliConfigMigrateSkills(actions),
    extractResults: (data) => (data as { results: CliMigrateResult[] }).results,
    scanFailedMessage: t('Scan failed'),
    migrateFailedMessage: t('Migration failed'),
  }), [t]))

  // MCP migration (via useMigration hook)
  const mcpMigration = useMigration<CliMcpEntry, CliMcpAction>(useMemo(() => ({
    scan: () => api.cliConfigScanMcp(),
    extractItems: (data) => (data as { servers: CliMcpEntry[] }).servers,
    defaultAction: (item) => item.exists ? 'skip' : 'overwrite',
    getKey: (item) => item.name,
    migrate: (actions) => api.cliConfigMigrateMcp(actions),
    extractResults: (data) => (data as { results: CliMigrateResult[] }).results,
    scanFailedMessage: t('Scan failed'),
    migrateFailedMessage: t('Migration failed'),
  }), [t]))

  // Load paths on mount
  useEffect(() => {
    api.cliConfigGetPaths().then(res => {
      if (res.success && res.data) {
        const p = res.data as CliConfigPaths
        setPaths(p)
        setConfigMode(p.configDirMode ?? 'halo')
        setCustomDir(p.customConfigDir ?? '')
      }
    })
  }, [])

  // ── Config dir handlers ────────────────────────────────────────────────

  const handleModeChange = useCallback((mode: ConfigDirMode) => {
    if (mode === 'cc') {
      setShowCcConfirm(true)
      return
    }
    setConfigMode(mode)
    setConfigDirResult(null)
  }, [])

  const confirmCcMode = useCallback(() => {
    setShowCcConfirm(false)
    setConfigMode('cc')
    setConfigDirResult(null)
  }, [])

  const handleSaveConfigDir = useCallback(async () => {
    setConfigDirSaving(true)
    setConfigDirResult(null)
    try {
      const res = await api.cliConfigSetConfigDir(configMode, configMode === 'custom' ? customDir : undefined)
      if (res.success) {
        const newPaths = await api.cliConfigGetPaths()
        if (newPaths.success && newPaths.data) {
          setPaths(newPaths.data as CliConfigPaths)
        }
        setConfigDirResult({ ok: true, msg: t('Saved. Restart any active conversation to apply.') })
      } else {
        setConfigDirResult({ ok: false, msg: res.error ?? t('Failed to save') })
      }
    } catch (e: unknown) {
      setConfigDirResult({ ok: false, msg: (e as Error).message })
    } finally {
      setConfigDirSaving(false)
    }
  }, [configMode, customDir, t])

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="border-t border-border pt-4 mt-4 space-y-3">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <ArrowRightLeft className="w-4 h-4 text-muted-foreground" />
        <p className="font-medium text-sm">{t('Claude CLI Integration')}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('Manage config directory and migrate skills / MCP servers from your existing Claude CLI installation.')}
      </p>

      {/* ── 1. Config Directory ─────────────────────────────────────────── */}
      <Panel
        title={t('Config Directory')}
        icon={<FolderInput className="w-4 h-4" />}
      >
        <p className="text-xs text-muted-foreground mb-3">
          {t('Choose where Halo reads Claude CLI config (skills, settings, MCP). Changing this affects all future conversations.')}
        </p>

        <div className="space-y-2">
          {/* Halo Default */}
          <label className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            'hover:bg-muted/50',
            configMode === 'halo' ? 'border-primary bg-primary/5' : 'border-border'
          )}>
            <input
              type="radio"
              name="configDirMode"
              value="halo"
              checked={configMode === 'halo'}
              onChange={() => handleModeChange('halo')}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{t('Halo Default')} <span className="ml-1 text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded-full">{t('Recommended')}</span></p>
              <p className="text-xs text-muted-foreground mt-0.5">{t("Halo's isolated config directory. Won't interfere with your standalone Claude CLI.")}</p>
              {paths && (
                <p className="text-xs font-mono text-muted-foreground mt-1 truncate">{paths.haloDefault}</p>
              )}
            </div>
          </label>

          {/* CC Default */}
          <label className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            'hover:bg-muted/50',
            configMode === 'cc' ? 'border-amber-500 bg-amber-500/5' : 'border-border'
          )}>
            <input
              type="radio"
              name="configDirMode"
              value="cc"
              checked={configMode === 'cc'}
              onChange={() => handleModeChange('cc')}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-medium text-sm">{t('Claude CLI Default')}</p>
                <span className="text-xs px-1.5 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-full flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {t('High Risk')}
                </span>
                <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full">
                  {t('Not Recommended')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{t("Share Claude CLI's ~/.claude directory. Not recommended — skills and settings are shared, but changes in Claude CLI will affect Halo and you may run into unexpected problems.")}</p>
              {paths && (
                <p className="text-xs font-mono text-muted-foreground mt-1 truncate">{paths.ccDefault}</p>
              )}
            </div>
          </label>

          {/* Custom */}
          <label className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            'hover:bg-muted/50',
            configMode === 'custom' ? 'border-primary bg-primary/5' : 'border-border'
          )}>
            <input
              type="radio"
              name="configDirMode"
              value="custom"
              checked={configMode === 'custom'}
              onChange={() => handleModeChange('custom')}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{t('Custom Path')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t('Use a custom directory path for Claude CLI config.')}</p>
              {configMode === 'custom' && (
                <input
                  type="text"
                  value={customDir}
                  onChange={e => { setCustomDir(e.target.value); setConfigDirResult(null) }}
                  placeholder={paths?.haloDefault ?? '/path/to/claude-config'}
                  className="mt-2 w-full px-3 py-1.5 text-xs font-mono bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                  onClick={e => e.stopPropagation()}
                />
              )}
            </div>
          </label>
        </div>

        {/* Current effective path */}
        {paths && (
          <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2 mt-2">
            <span className="font-medium">{t('Current effective path:')}</span>{' '}
            <span className="font-mono">{paths.current}</span>
          </div>
        )}

        {/* Save button */}
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={handleSaveConfigDir}
            disabled={configDirSaving}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {configDirSaving ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            {t('Apply')}
          </button>
          {configDirResult && (
            <span className={cn(
              'text-xs flex items-center gap-1',
              configDirResult.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'
            )}>
              {configDirResult.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
              {configDirResult.msg}
            </span>
          )}
        </div>
      </Panel>

      {/* ── 2. Migrate Skills ───────────────────────────────────────────── */}
      <Panel
        title={t('Migrate Skills from Claude CLI')}
        icon={<Package className="w-4 h-4" />}
        badge={skillsMigration.items.length > 0 && !skillsMigration.results ? (
          <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full">
            {skillsMigration.items.length}
          </span>
        ) : undefined}
      >
        <p className="text-xs text-muted-foreground">
          {t('Copy skills from your Claude CLI installation (~/.claude/skills/) into Halo\'s skill directory.')}
        </p>

        {/* Scan button */}
        {(skillsMigration.phase === 'idle' || skillsMigration.phase === 'error') && (
          <button
            type="button"
            onClick={skillsMigration.doScan}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            {t('Scan')}
          </button>
        )}

        {skillsMigration.phase === 'scanning' && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('Scanning...')}
          </div>
        )}

        {skillsMigration.error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <X className="w-3 h-3" /> {skillsMigration.error}
          </p>
        )}

        {/* Skills list with conflict resolution */}
        {skillsMigration.phase === 'scanned' && skillsMigration.items.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('No skills found in ~/.claude/skills/')}</p>
        )}

        {skillsMigration.phase === 'scanned' && skillsMigration.items.length > 0 && (
          <>
            <div className="space-y-1.5">
              {skillsMigration.items.map(skill => (
                <div key={skill.name} className="flex items-center justify-between gap-2 p-2 bg-muted/30 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono font-medium truncate">{skill.name}</p>
                    {skill.exists && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">{t('Already exists in Halo')}</p>
                    )}
                  </div>
                  <select
                    value={skillsMigration.actions[skill.name] ?? 'skip'}
                    onChange={e => skillsMigration.setAction(skill.name, e.target.value as CliSkillAction)}
                    className="text-xs bg-secondary border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    <option value="skip">{t('Skip')}</option>
                    <option value="overwrite">{t('Overwrite')}</option>
                    {skill.exists && <option value="rename">{t('Rename (+cc)')}</option>}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={skillsMigration.doMigrate}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Check className="w-3 h-3" />
                {t('Migrate')}
              </button>
              <button
                type="button"
                onClick={skillsMigration.reset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"
              >
                {t('Cancel')}
              </button>
            </div>
          </>
        )}

        {skillsMigration.phase === 'migrating' && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('Migrating...')}
          </div>
        )}

        {/* Results */}
        {skillsMigration.phase === 'done' && skillsMigration.results && (
          <>
            <div className="space-y-1.5">
              {skillsMigration.results.map(r => (
                <div key={r.name} className="flex items-center justify-between p-2 bg-muted/30 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono truncate">{r.name}{r.dest && r.dest !== r.name ? ` → ${r.dest}` : ''}</p>
                    {r.error && <p className="text-xs text-destructive">{r.error}</p>}
                  </div>
                  <StatusChip status={r.status} />
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={skillsMigration.reset}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary hover:bg-secondary/80 transition-colors mt-2"
            >
              <RefreshCw className="w-3 h-3" /> {t('Scan Again')}
            </button>
          </>
        )}
      </Panel>

      {/* ── 3. Migrate MCP ─────────────────────────────────────────────── */}
      <Panel
        title={t('Migrate MCP Servers from Claude CLI')}
        icon={<Settings2 className="w-4 h-4" />}
        badge={mcpMigration.items.length > 0 && !mcpMigration.results ? (
          <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full">
            {mcpMigration.items.length}
          </span>
        ) : undefined}
      >
        <p className="text-xs text-muted-foreground">
          {t('Import MCP server configurations from your Claude CLI (~/.claude.json) into Halo\'s MCP settings.')}
        </p>

        {(mcpMigration.phase === 'idle' || mcpMigration.phase === 'error') && (
          <button
            type="button"
            onClick={mcpMigration.doScan}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            {t('Scan')}
          </button>
        )}

        {mcpMigration.phase === 'scanning' && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('Scanning...')}
          </div>
        )}

        {mcpMigration.error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <X className="w-3 h-3" /> {mcpMigration.error}
          </p>
        )}

        {mcpMigration.phase === 'scanned' && mcpMigration.items.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('No MCP servers found in ~/.claude.json')}</p>
        )}

        {mcpMigration.phase === 'scanned' && mcpMigration.items.length > 0 && (
          <>
            <div className="space-y-1.5">
              {mcpMigration.items.map(s => (
                <div key={s.name} className="flex items-center justify-between gap-2 p-2 bg-muted/30 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono font-medium truncate">{s.name}</p>
                    {s.exists && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">{t('Already exists in Halo')}</p>
                    )}
                  </div>
                  <select
                    value={mcpMigration.actions[s.name] ?? 'skip'}
                    onChange={e => mcpMigration.setAction(s.name, e.target.value as CliMcpAction)}
                    className="text-xs bg-secondary border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    <option value="skip">{t('Skip')}</option>
                    <option value="overwrite">{t('Overwrite')}</option>
                  </select>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={mcpMigration.doMigrate}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Check className="w-3 h-3" />
                {t('Migrate')}
              </button>
              <button
                type="button"
                onClick={mcpMigration.reset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"
              >
                {t('Cancel')}
              </button>
            </div>
          </>
        )}

        {mcpMigration.phase === 'migrating' && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('Migrating...')}
          </div>
        )}

        {mcpMigration.phase === 'done' && mcpMigration.results && (
          <>
            <div className="space-y-1.5">
              {mcpMigration.results.map(r => (
                <div key={r.name} className="flex items-center justify-between p-2 bg-muted/30 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono truncate">{r.name}</p>
                    {r.error && <p className="text-xs text-destructive">{r.error}</p>}
                  </div>
                  <StatusChip status={r.status} />
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={mcpMigration.reset}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary hover:bg-secondary/80 transition-colors mt-2"
            >
              <RefreshCw className="w-3 h-3" /> {t('Scan Again')}
            </button>
          </>
        )}
      </Panel>

      {/* ── CC Mode Confirmation Dialog ─────────────────────────────────── */}
      {showCcConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full space-y-4">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <p className="font-semibold">{t('High Risk: Shared Config')}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('Using Claude CLI\'s default directory means Halo and your standalone Claude CLI will share the same skills, settings, and MCP config.')}
            </p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
              <li>{t('Changes made by Claude CLI will immediately affect Halo')}</li>
              <li>{t('Skills installed in Halo will appear in Claude CLI')}</li>
              <li>{t('MCP server changes are shared bidirectionally')}</li>
              <li>{t('If your standalone Claude CLI has a custom API key or endpoint configured, it will take priority over the model selected in Halo, which may break chat')}</li>
            </ul>
            <p className="text-sm font-medium">{t('Are you sure you want to proceed?')}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={confirmCcMode}
                className="flex-1 py-2 text-sm font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
              >
                {t('Use Shared Config')}
              </button>
              <button
                type="button"
                onClick={() => setShowCcConfirm(false)}
                className="flex-1 py-2 text-sm font-medium rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
