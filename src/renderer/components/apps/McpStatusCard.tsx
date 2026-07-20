/**
 * McpStatusCard
 *
 * Right-panel detail view for an MCP-type app.
 * Shows connection status, enable/disable toggle, and full inline editing
 * (visual + JSON modes) matching the quality of the old Settings > MCP page.
 *
 * Enable/Disable maps to app:pause / app:resume.
 * Edit saves via updateAppSpec({ mcp_server: ... }).
 */

import { useState, useCallback } from 'react'
import {
  Wrench, Unplug, Loader2, AlertTriangle, Pencil, X, Check,
  Plus, Settings2, Code, AlertCircle, ChevronDown, ChevronRight, PlugZap
} from 'lucide-react'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useAppStore } from '../../stores/app.store'
import { AppStatusDot } from './AppStatusDot'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import {
  internalMcpServerToJsonConfig,
  keyValueLinesToRecord,
  mcpJsonConfigToInternal,
  recordToKeyValueLines,
} from '../../utils/mcpConfigCompat'
import type { AppStatus } from '../../../shared/apps/app-types'
import type { McpSpec, McpServerConfig } from '../../../shared/apps/spec-types'

interface McpStatusCardProps {
  appId: string
}

// ── Types ──────────────────────────────────────────────────────────────────

type Transport = 'stdio' | 'sse' | 'streamable-http'

interface EditableConfig {
  transport: Transport
  command: string   // command (stdio) or URL (sse / streamable-http)
  args: string[]    // only used for stdio
  envText: string   // KEY=VALUE lines
  headersText: string // KEY=VALUE lines for http/sse headers
}

// ── Helpers ────────────────────────────────────────────────────────────────

function statusLabel(status: AppStatus, t: (s: string) => string, installed?: boolean): string {
  if (installed && status === 'active') return t('Installed')
  switch (status) {
    case 'active':      return t('Connected')
    case 'paused':      return t('Disabled')
    case 'error':       return t('Connection error')
    case 'needs_login': return t('Needs login')
    default:            return String(status)
  }
}

function mcpServerToEditable(mcpServer: McpServerConfig): EditableConfig {
  const transport: Transport = mcpServer.transport ?? 'stdio'
  const command = mcpServer.command ?? ''
  const args: string[] = mcpServer.args ?? []
  const envText = recordToKeyValueLines(mcpServer.env)
  const headersText = recordToKeyValueLines(mcpServer.headers)
  return { transport, command, args, envText, headersText }
}

function editableToMcpServer(edit: EditableConfig): McpServerConfig {
  return {
    transport: edit.transport,
    command: edit.command.trim(),
    ...(edit.transport === 'stdio' && edit.args.length > 0 ? { args: edit.args.filter(a => a.trim()) } : {}),
    ...(keyValueLinesToRecord(edit.envText) ? { env: keyValueLinesToRecord(edit.envText)! } : {}),
    ...(edit.transport !== 'stdio' && keyValueLinesToRecord(edit.headersText) ? { headers: keyValueLinesToRecord(edit.headersText)! } : {}),
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ArgList({
  args,
  onChange,
  t,
}: {
  args: string[]
  onChange: (args: string[]) => void
  t: (s: string) => string
}) {
  const update = (i: number, v: string) => {
    const next = [...args]; next[i] = v; onChange(next)
  }
  const remove = (i: number) => onChange(args.filter((_, idx) => idx !== i))
  const add = () => onChange([...args, ''])

  return (
    <div className="space-y-2">
      {args.map((arg, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={arg}
            onChange={e => update(i, e.target.value)}
            className="flex-1 px-3 py-1.5 border border-border rounded-lg bg-input text-foreground text-sm font-mono focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
            placeholder={t('Argument value')}
          />
          <button
            onClick={() => remove(i)}
            className="p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        {t('Add argument')}
      </button>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export function McpStatusCard({ appId }: McpStatusCardProps) {
  const { t } = useTranslation()
  const { apps, pauseApp, resumeApp, uninstallApp, updateAppSpec } = useAppsStore()
  const { mcpStatus } = useAppStore()
  const app = apps.find(a => a.id === appId)

  // Toggle state
  const [toggling, setToggling]       = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  // Connection test state (result arrives via the agent:mcp-status broadcast)
  const [testing, setTesting]     = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  // Edit state
  const [isEditing, setIsEditing] = useState(false)
  const [editMode, setEditMode] = useState<'visual' | 'json'>('visual')
  const [editConfig, setEditConfig] = useState<EditableConfig>({ transport: 'stdio', command: '', args: [], envText: '', headersText: '' })
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Tools section collapse
  const [toolsExpanded, setToolsExpanded] = useState(false)

  if (!app) return null

  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
  const mcpServer: McpServerConfig | undefined = app.spec.type === 'mcp'
    ? (app.spec as McpSpec).mcp_server
    : undefined

  // Connection status
  const status = app.status
  const isPaused  = status === 'paused'
  const isEnabled = status === 'active'
  const canToggle = status === 'active' || status === 'paused' || status === 'error'

  const sdkEntry = mcpStatus.find(s => s.name === app.specId)
  let displayStatus: AppStatus = status
  let neverConnected = false
  if (status === 'active') {
    if (sdkEntry) {
      if (sdkEntry.status === 'failed') displayStatus = 'error'
      else if (sdkEntry.status === 'needs-auth') displayStatus = 'needs_login'
    } else {
      neverConnected = true
    }
  }
  const isError = displayStatus === 'error'

  // Init edit state when entering edit mode
  const startEditing = useCallback(() => {
    if (!mcpServer) return
    const cfg = mcpServerToEditable(mcpServer)
    setEditConfig(cfg)
    setJsonText(JSON.stringify(internalMcpServerToJsonConfig(mcpServer), null, 2))
    setJsonError(null)
    setHasChanges(false)
    setSaveError(null)
    setEditMode('visual')
    setIsEditing(true)
  }, [mcpServer])

  const cancelEditing = () => {
    setIsEditing(false)
    setJsonError(null)
    setSaveError(null)
  }

  // Visual field updaters
  const updateField = useCallback((field: keyof EditableConfig, value: any) => {
    setEditConfig(prev => {
      const next = { ...prev, [field]: value }
      setJsonText(JSON.stringify(internalMcpServerToJsonConfig(editableToMcpServer(next)), null, 2))
      setHasChanges(true)
      return next
    })
  }, [])

  // When transport changes, reset args (only for stdio)
  const handleTransportChange = useCallback((transport: Transport) => {
    setEditConfig(prev => {
      const next = { ...prev, transport, args: transport === 'stdio' ? prev.args : [] }
      setJsonText(JSON.stringify(internalMcpServerToJsonConfig(editableToMcpServer(next)), null, 2))
      setHasChanges(true)
      return next
    })
  }, [])

  // JSON mode handler — syncs back to visual
  const handleJsonChange = useCallback((text: string) => {
    setJsonText(text)
    setHasChanges(true)
    try {
      const parsed = JSON.parse(text)
      const result = mcpJsonConfigToInternal(parsed)
      if (result.error) {
        setJsonError(t(result.error))
        return
      }
      setJsonError(null)
      setEditConfig(mcpServerToEditable(result.data!))
    } catch (e) {
      setJsonError(t('Invalid JSON: {{message}}', { message: (e as Error).message }))
    }
  }, [t])

  // Switch modes — sync JSON → visual and visual → JSON
  const switchMode = (mode: 'visual' | 'json') => {
    if (mode === 'json' && !jsonError) {
      setJsonText(JSON.stringify(internalMcpServerToJsonConfig(editableToMcpServer(editConfig)), null, 2))
    }
    setEditMode(mode)
  }

  const handleSave = async () => {
    let serverConfig: McpServerConfig
    if (editMode === 'json') {
      try {
        const result = mcpJsonConfigToInternal(JSON.parse(jsonText))
        if (result.error || !result.data) {
          setJsonError(t(result.error ?? 'Invalid MCP configuration'))
          return
        }
        serverConfig = result.data
      } catch (e) {
        setJsonError(t('Invalid JSON: {{message}}', { message: (e as Error).message }))
        return
      }
    } else {
      serverConfig = editableToMcpServer(editConfig)
    }

    setIsSaving(true)
    setSaveError(null)
    try {
      const ok = await updateAppSpec(appId, { mcp_server: serverConfig })
      if (ok) {
        setIsEditing(false)
        setHasChanges(false)
      } else {
        setSaveError(t('Save failed. Please try again.'))
      }
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setIsSaving(false)
    }
  }

  const handleToggle = async () => {
    if (!canToggle || toggling) return
    setToggling(true)
    setToggleError(null)
    try {
      await (isEnabled ? pauseApp(appId) : resumeApp(appId))
    } catch (e) {
      setToggleError((e as Error).message)
    } finally {
      setToggling(false)
    }
  }

  // Run a native connection probe. The main process updates the shared
  // status cache and broadcasts agent:mcp-status, which refreshes this card.
  const handleTestConnection = async () => {
    if (testing) return
    setTesting(true)
    setTestError(null)
    try {
      const res = await api.probeMcpApp(appId)
      if (!res.success) setTestError(res.error ?? t('Connection test failed'))
    } catch (e) {
      setTestError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  // Env display (masked values for security)
  const envEntries = mcpServer?.env ? Object.entries(mcpServer.env) : []
  const headerEntries = mcpServer?.headers ? Object.entries(mcpServer.headers) : []

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground truncate">{name}</h2>
          {description && (
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AppStatusDot status={displayStatus} size="sm" />
              <span>{statusLabel(displayStatus, t, neverConnected)}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-label={isEnabled ? t('Disable') : t('Enable')}
              aria-checked={isEnabled}
              disabled={!canToggle || toggling}
              onClick={handleToggle}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
                disabled:opacity-50 disabled:cursor-not-allowed
                ${isEnabled ? 'bg-primary' : 'bg-muted'}`}
            >
              {toggling ? (
                <Loader2 className="absolute inset-0 m-auto w-3.5 h-3.5 animate-spin text-white/70" />
              ) : (
                <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm
                  transform transition-transform duration-200 mt-0.5
                  ${isEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              )}
            </button>
          </div>
          {toggleError && (
            <div className="flex items-center gap-1 text-[11px] text-red-500">
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              <span>{toggleError}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Connection failure details + retry ── */}
      {(isError || displayStatus === 'needs_login') && (
        <div className="px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-2.5">
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-red-400">
                  {displayStatus === 'needs_login'
                    ? t('Authentication was rejected by the MCP server. Update the token in the configuration below, then test again.')
                    : t('The MCP server failed to connect.')}
                </p>
                {sdkEntry?.errorDetail && (
                  <p className="text-[11px] font-mono text-red-400/80 break-all">
                    {sdkEntry.errorDetail}
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={handleTestConnection}
              disabled={testing}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-red-400 hover:text-red-300
                border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors
                disabled:opacity-50 flex-shrink-0 self-start"
            >
              {testing
                ? <><Loader2 className="w-3 h-3 animate-spin" />{t('Testing...')}</>
                : <><PlugZap className="w-3 h-3" />{t('Test connection')}</>}
            </button>
          </div>
          {testError && (
            <p className="text-[11px] text-red-400/80 pl-6">{testError}</p>
          )}
        </div>
      )}

      {/* ── Configuration (view / edit) ── */}
      {mcpServer && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Configuration')}
            </h3>
            {!isEditing && (
              <div className="flex items-center gap-1">
                {!isPaused && (
                  <button
                    onClick={handleTestConnection}
                    disabled={testing}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors disabled:opacity-50"
                  >
                    {testing
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <PlugZap className="w-3 h-3" />}
                    {t('Test connection')}
                  </button>
                )}
                <button
                  onClick={startEditing}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  {t('Edit')}
                </button>
              </div>
            )}
          </div>

          {!isEditing ? (
            /* ── Read-only view ── */
            <div className="bg-secondary rounded-lg p-3 text-xs font-mono space-y-1.5">
              <div className="flex gap-2">
                <span className="text-muted-foreground w-20 flex-shrink-0">{t('Transport')}</span>
                <span className="text-foreground">{mcpServer.transport ?? 'stdio'}</span>
              </div>
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0">
                    {(mcpServer.transport === 'sse' || mcpServer.transport === 'streamable-http') ? t('URL') : t('Command')}
                  </span>
                  <span className="text-foreground break-all">{mcpServer.command}</span>
                </div>
              {mcpServer.args && (mcpServer.args as string[]).length > 0 && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0">{t('Args')}</span>
                  <span className="text-foreground break-all">{(mcpServer.args as string[]).join(' ')}</span>
                </div>
              )}
              {envEntries.length > 0 && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0">ENV</span>
                  <div className="space-y-0.5">
                    {envEntries.map(([k]) => (
                      <div key={k} className="text-foreground">
                        {k}=<span className="text-muted-foreground">{'•'.repeat(8)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {headerEntries.length > 0 && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0">{t('Headers')}</span>
                  <div className="space-y-0.5">
                    {headerEntries.map(([k]) => (
                      <div key={k} className="text-foreground">
                        {k}=<span className="text-muted-foreground">{'•'.repeat(8)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* ── Edit form ── */
            <div className="border border-border rounded-lg overflow-hidden">
              {/* Mode toggle */}
              <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
                <div className="flex items-center gap-1 p-0.5 bg-secondary rounded-lg">
                  <button
                    onClick={() => switchMode('visual')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
                      editMode === 'visual'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    {t('Visual')}
                  </button>
                  <button
                    onClick={() => switchMode('json')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
                      editMode === 'json'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Code className="w-3.5 h-3.5" />
                    JSON
                  </button>
                </div>
                {hasChanges && (
                  <span className="text-xs text-amber-500">{t('Unsaved changes')}</span>
                )}
              </div>

              <div className="p-4">
                {editMode === 'visual' ? (
                  <div className="space-y-4">
                    {/* Transport */}
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                        {t('Transport')}
                      </label>
                      <select
                        value={editConfig.transport}
                        onChange={e => handleTransportChange(e.target.value as Transport)}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground text-sm focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                      >
                        <option value="stdio">{t('Command line (stdio)')}</option>
                        <option value="sse">SSE (Server-Sent Events)</option>
                        <option value="streamable-http">HTTP (Streamable)</option>
                      </select>
                    </div>

                    {/* Command / URL */}
                    <div>
                        <label className="block text-sm font-medium text-muted-foreground mb-1">
                          {editConfig.transport === 'stdio' ? t('Command') : t('URL')}
                        </label>
                      <input
                        type="text"
                        value={editConfig.command}
                        onChange={e => updateField('command', e.target.value)}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground text-sm font-mono focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                        placeholder={editConfig.transport === 'stdio' ? 'npx' : 'https://...'}
                      />
                    </div>

                    {/* Args (stdio only) */}
                    {editConfig.transport === 'stdio' && (
                      <div>
                        <label className="block text-sm font-medium text-muted-foreground mb-1">
                          {t('Arguments')}
                        </label>
                        <ArgList
                          args={editConfig.args}
                          onChange={args => updateField('args', args)}
                          t={t}
                        />
                      </div>
                    )}

                    {/* Env vars */}
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                        {t('Environment Variables')}{' '}
                        <span className="font-normal text-muted-foreground/70">(KEY=VALUE, {t('one per line')})</span>
                      </label>
                      <textarea
                        value={editConfig.envText}
                        onChange={e => updateField('envText', e.target.value)}
                        rows={3}
                        spellCheck={false}
                        placeholder="API_KEY=your-key-here"
                        className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground text-sm font-mono focus:ring-2 focus:ring-primary focus:border-transparent resize-none transition-colors"
                      />
                    </div>

                    {editConfig.transport !== 'stdio' && (
                      <div>
                        <label className="block text-sm font-medium text-muted-foreground mb-1">
                          {t('Headers')}{' '}
                          <span className="font-normal text-muted-foreground/70">(KEY=VALUE, {t('one per line')})</span>
                        </label>
                        <textarea
                          value={editConfig.headersText}
                          onChange={e => updateField('headersText', e.target.value)}
                          rows={3}
                          spellCheck={false}
                          placeholder={t('Authorization=Bearer <token>')}
                          className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground text-sm font-mono focus:ring-2 focus:ring-primary focus:border-transparent resize-none transition-colors"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  /* JSON mode */
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">
                      {t('Paste config from Cursor or Claude Desktop directly.')}
                    </p>
                    <textarea
                      value={jsonText}
                      onChange={e => handleJsonChange(e.target.value)}
                      rows={10}
                      spellCheck={false}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground text-sm font-mono focus:ring-2 focus:ring-primary focus:border-transparent resize-none transition-colors"
                      placeholder={'{\n  "command": "npx",\n  "args": ["-y", "@example/mcp"],\n  "env": { "API_KEY": "xxx" }\n}'}
                    />
                    {jsonError && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                        {jsonError}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Save / Cancel */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/30">
                <div>
                  {saveError && (
                    <p className="text-xs text-red-500">{saveError}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={cancelEditing}
                    disabled={isSaving}
                    className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!!jsonError || isSaving || !hasChanges}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground rounded-lg transition-colors"
                  >
                    {isSaving ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t('Saving...')}</>
                    ) : (
                      <><Check className="w-3.5 h-3.5" />{t('Save')}</>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Tools ── */}
      <div className="space-y-2">
        <button
          onClick={() => setToolsExpanded(v => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors w-full text-left"
        >
          {toolsExpanded
            ? <ChevronDown className="w-3.5 h-3.5" />
            : <ChevronRight className="w-3.5 h-3.5" />
          }
          <Wrench className="w-3.5 h-3.5" />
          {t('Tools provided by this server')}
          {sdkEntry?.tools && sdkEntry.tools.length > 0 && (
            <span className="ml-1 text-muted-foreground/70 font-normal normal-case tracking-normal">
              ({sdkEntry.tools.length})
            </span>
          )}
        </button>
        {toolsExpanded && (
          sdkEntry?.tools && sdkEntry.tools.length > 0 ? (
            <ul className="pl-5 space-y-0.5">
              {sdkEntry.tools.map(tool => (
                <li key={tool} className="text-xs text-muted-foreground font-mono truncate" title={tool}>
                  {tool}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground italic pl-5">
              {isPaused
                ? t('Enable this server to load its tools.')
                : t('No tools loaded yet — use "Test connection" to fetch the tool list.')}
            </p>
          )
        )}
      </div>

      {/* ── Danger zone ── */}
      <div className="pt-2 border-t border-border">
        <button
          onClick={() => uninstallApp(appId)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 hover:text-red-300
            border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
        >
          <Unplug className="w-4 h-4" />
          {t('Uninstall')}
        </button>
      </div>

    </div>
  )
}
