/**
 * ManualAddDialog
 *
 * Dialog for manually adding an MCP server, Skill, or installing an app from
 * a local file (without going through the App Store).
 * Accessible from the "Manual Add" button in the My Apps sidebar.
 *
 * Step 1: Choose type (MCP / Skill / Install from File)
 * Step 2: Fill in details
 *   - MCP: name, command, args, env, transport
 *   - Skill: delegated to SkillInstallDialog via onSkillAdd
 *   - File: opens native file picker via api.storeImportDhpkg for .dhpkg installs.
 *           For .zip / folder / .yaml / .md sources, point users at the rich
 *           Import tabs inside SkillInstallDialog / AppInstallDialog.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { X, Server, BookOpen, ChevronLeft, Plus, Settings2, Code, AlertCircle, Package, Loader2 } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { McpServerConfig } from '../../../shared/apps/spec-types'
import {
  internalMcpServerToJsonConfig,
  keyValueLinesToRecord,
  mcpJsonConfigToInternal,
  recordToKeyValueLines,
} from '../../utils/mcpConfigCompat'

const GLOBAL_SCOPE = '__global__'

type AddType = 'mcp' | 'skill' | 'file'

interface ManualAddDialogProps {
  onClose: () => void
  /** Called when the user picks "Skill" — the caller opens SkillInstallDialog instead */
  onSkillAdd?: () => void
  /**
   * Pre-selects the add type, skipping the choose step.
   * Use 'mcp' to jump directly into the MCP form (from the My MCP tab).
   * Use 'skill' to immediately delegate to SkillInstallDialog via onSkillAdd.
   */
  initialType?: AddType
}

export function ManualAddDialog({ onClose, onSkillAdd, initialType }: ManualAddDialogProps) {
  const { t } = useTranslation()
  const { installApp, loadApps } = useAppsStore()

  // If initialType is provided, jump straight to the corresponding form/delegate.
  const startInForm = initialType === 'mcp'
  const [step, setStep] = useState<'choose' | 'form'>(startInForm ? 'form' : 'choose')
  const [addType, setAddType] = useState<AddType | null>(startInForm ? 'mcp' : null)

  // If caller asked for skill, defer to onSkillAdd on mount and close.
  // (Renderer effects run after first paint; close happens fast enough to feel like a direct hop.)
  useEffect(() => {
    if (initialType === 'skill' && onSkillAdd) {
      onClose()
      onSkillAdd()
    }
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // File-install flow state. Lives at the dialog level so the spinner shows
  // immediately when the native picker opens.
  const [fileInstalling, setFileInstalling] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const handleInstallFromFile = useCallback(async () => {
    setFileError(null)
    setFileInstalling(true)
    try {
      // Install into the currently-active space; null = global scope.
      const activeSpaceId = useSpaceStore.getState().currentSpace?.id ?? null
      const res = await api.storeImportDhpkg({ spaceId: activeSpaceId })
      if (res.success && res.data?.appId) {
        await loadApps()
        onClose()
        return
      }
      // User-cancelled picker — silently no-op.
      if (res.error && res.error !== 'User cancelled') {
        setFileError(res.error)
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err))
    } finally {
      setFileInstalling(false)
    }
  }, [loadApps, onClose])

  const handleChoose = (type: AddType) => {
    if (type === 'skill' && onSkillAdd) {
      // Delegate skill creation to the dedicated SkillInstallDialog
      onClose()
      onSkillAdd()
      return
    }
    if (type === 'file') {
      // No form — fire native file picker immediately.
      void handleInstallFromFile()
      return
    }
    setAddType(type)
    setStep('form')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            {step === 'form' && !initialType && (
              <button
                onClick={() => { setStep('choose'); setAddType(null) }}
                className="p-1 hover:bg-secondary rounded transition-colors mr-1"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <h2 className="text-lg font-semibold">
              {step === 'choose'
                ? t('Manual Add')
                : addType === 'mcp'
                  ? t('Add MCP Server')
                  : t('Add Skill')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {step === 'choose' ? (
            <>
              <TypeChooser onChoose={handleChoose} fileBusy={fileInstalling} />
              {fileError && (
                <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span className="whitespace-pre-wrap break-words">{fileError}</span>
                </div>
              )}
            </>
          ) : addType === 'mcp' ? (
            <McpForm onClose={onClose} installApp={installApp} loadApps={loadApps} />
          ) : (
            <SkillForm onClose={onClose} installApp={installApp} loadApps={loadApps} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Type Chooser ──────────────────────────────────

interface TypeChooserProps {
  onChoose: (type: AddType) => void
  fileBusy: boolean
}

function TypeChooser({ onChoose, fileBusy }: TypeChooserProps) {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <button
        onClick={() => onChoose('mcp')}
        className="flex flex-col items-center gap-3 p-5 border border-border rounded-lg hover:border-primary hover:bg-secondary/30 transition-colors"
      >
        <Server className="w-7 h-7 text-primary" />
        <div className="text-center">
          <p className="font-medium">{t('MCP Server')}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('Add tools via Model Context Protocol')}
          </p>
        </div>
      </button>
      <button
        onClick={() => onChoose('skill')}
        className="flex flex-col items-center gap-3 p-5 border border-border rounded-lg hover:border-primary hover:bg-secondary/30 transition-colors"
      >
        <BookOpen className="w-7 h-7 text-primary" />
        <div className="text-center">
          <p className="font-medium">{t('Skill')}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('Add custom instructions for the AI')}
          </p>
        </div>
      </button>
      <button
        onClick={() => onChoose('file')}
        disabled={fileBusy}
        className="flex flex-col items-center gap-3 p-5 border border-border rounded-lg hover:border-primary hover:bg-secondary/30 transition-colors disabled:opacity-60 disabled:cursor-wait"
      >
        {fileBusy ? <Loader2 className="w-7 h-7 text-primary animate-spin" /> : <Package className="w-7 h-7 text-primary" />}
        <div className="text-center">
          <p className="font-medium">{t('Install from File')}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('Install a .dhpkg you received or downloaded')}
          </p>
        </div>
      </button>
    </div>
  )
}

// ── MCP Form ──────────────────────────────────

interface FormProps {
  onClose: () => void
  installApp: (spaceId: string | null, spec: any, userConfig?: Record<string, unknown>) => Promise<string | null>
  loadApps: (spaceId?: string) => Promise<void>
}

type McpTransport = 'stdio' | 'sse' | 'streamable-http'
type EditMode = 'visual' | 'json'
const MANUAL_MCP_VERSION = '1.0'
const MANUAL_MCP_AUTHOR = 'manual'

function buildMcpServer(
  transport: McpTransport,
  command: string,
  args: string[],
  envText: string,
  headersText: string
): McpServerConfig {
  return {
    transport,
    command: command.trim(),
    ...(transport === 'stdio' && args.filter(a => a.trim()).length > 0 ? { args: args.filter(a => a.trim()) } : {}),
    ...(keyValueLinesToRecord(envText) ? { env: keyValueLinesToRecord(envText)! } : {}),
    ...(transport !== 'stdio' && keyValueLinesToRecord(headersText) ? { headers: keyValueLinesToRecord(headersText)! } : {}),
  }
}

function buildMcpSpec(
  name: string,
  transport: McpTransport,
  command: string,
  args: string[],
  envText: string,
  headersText: string
) {
  return {
    spec_version: '1',
    name: name.trim(),
    version: MANUAL_MCP_VERSION,
    author: MANUAL_MCP_AUTHOR,
    type: 'mcp' as const,
    description: `MCP Server: ${name.trim()}`,
    mcp_server: buildMcpServer(transport, command, args, envText, headersText),
  }
}

function McpForm({ onClose, installApp, loadApps }: FormProps) {
  const { t } = useTranslation()
  const [editMode, setEditMode] = useState<EditMode>('visual')

  // Space selector
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)
  const allSpaces = useMemo(() => {
    const result: Array<{ id: string; name: string }> = []
    if (haloSpace) result.push(haloSpace)
    result.push(...spaces)
    return result
  }, [haloSpace, spaces])
  const [selectedSpaceId, setSelectedSpaceId] = useState(GLOBAL_SCOPE)

  // Visual fields
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState<string[]>([])
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')

  // JSON fields
  const [jsonName, setJsonName] = useState('')
  const [jsonText, setJsonText] = useState('{\n  "command": "npx",\n  "args": ["-y", "@example/mcp-server"]\n}')
  const [jsonError, setJsonError] = useState<string | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const switchToJsonMode = useCallback(() => {
    const mcpServer = buildMcpServer(transport, command, args, envText, headersText)
    setJsonText(JSON.stringify(internalMcpServerToJsonConfig(mcpServer), null, 2))
    if (!jsonName && name) setJsonName(name)
    setJsonError(null)
    setEditMode('json')
  }, [args, command, envText, headersText, jsonName, name, transport])

  // Parse JSON → sync back to visual fields
  const handleJsonChange = useCallback((text: string) => {
    setJsonText(text)
    try {
      const parsed = JSON.parse(text)
      const result = mcpJsonConfigToInternal(parsed)
      if (result.error) {
        setJsonError(t(result.error))
        return
      }
      setJsonError(null)
      setCommand(result.data?.command ?? '')
      setTransport(result.data?.transport ?? 'stdio')
      setArgs(result.data?.args ?? [])
      setEnvText(recordToKeyValueLines(result.data?.env))
      setHeadersText(recordToKeyValueLines(result.data?.headers))
    } catch (e) {
      setJsonError(t('Invalid JSON: {{message}}', { message: (e as Error).message }))
    }
  }, [t])

  const isUrl = transport !== 'stdio'

  const handleSubmit = useCallback(async () => {
    const effectiveName = (editMode === 'json' ? jsonName : name).trim()
    if (!effectiveName) { setError(t('Name is required')); return }

    let spec: ReturnType<typeof buildMcpSpec>
    if (editMode === 'json') {
      try {
        const parsed = JSON.parse(jsonText)
        const result = mcpJsonConfigToInternal(parsed)
        if (result.error || !result.data) {
          setError(t(result.error ?? 'Invalid MCP configuration'))
          return
        }
        spec = {
          spec_version: '1',
          name: effectiveName,
          version: MANUAL_MCP_VERSION,
          author: MANUAL_MCP_AUTHOR,
          type: 'mcp' as const,
          description: `MCP Server: ${effectiveName}`,
          mcp_server: result.data,
        }
      } catch (e) {
        setError(t('Invalid JSON: {{message}}', { message: e instanceof Error ? e.message : String(e) }))
        return
      }
    } else {
      if (!command.trim()) { setError(t('Command or URL is required')); return }
      spec = buildMcpSpec(effectiveName, transport, command, args, envText, headersText)
    }

    setError(null)
    setInstalling(true)
    try {
      const resolvedSpaceId = selectedSpaceId === GLOBAL_SCOPE ? null : selectedSpaceId
      const appId = await installApp(resolvedSpaceId, spec)
      if (appId) {
        await loadApps()
        onClose()
      } else {
        setError(t('Installation failed. Please try again.'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Installation failed'))
    } finally {
      setInstalling(false)
    }
  }, [args, command, editMode, envText, headersText, installApp, jsonName, jsonText, loadApps, name, onClose, selectedSpaceId, t, transport])

  const addArg = () => setArgs(prev => [...prev, ''])
  const updateArg = (i: number, v: string) => setArgs(prev => { const n = [...prev]; n[i] = v; return n })
  const removeArg = (i: number) => setArgs(prev => prev.filter((_, idx) => idx !== i))

  return (
    <div className="space-y-0">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 p-0.5 bg-secondary rounded-lg mb-4 w-fit">
        <button
          onClick={() => setEditMode('visual')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
            editMode === 'visual' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Settings2 className="w-3.5 h-3.5" />
          {t('Visual')}
        </button>
        <button
          onClick={switchToJsonMode}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
            editMode === 'json' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Code className="w-3.5 h-3.5" />
          JSON
        </button>
      </div>

      <div className="space-y-4">
        {/* Scope selector */}
        <div>
          <label className="block text-sm font-medium mb-1">{t('Install to')}</label>
          <select
            value={selectedSpaceId}
            onChange={e => setSelectedSpaceId(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          >
            <option value={GLOBAL_SCOPE}>{t('Global (all spaces)')}</option>
            {allSpaces.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Name — always shown */}
        <div>
          <label className="block text-sm font-medium mb-1">{t('Name')}</label>
          <input
            type="text"
            value={editMode === 'json' ? jsonName : name}
            onChange={e => editMode === 'json' ? setJsonName(e.target.value) : setName(e.target.value)}
            autoFocus
            placeholder={t('e.g. my-mcp-server')}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          />
        </div>

        {editMode === 'visual' ? (
          <>
            {/* Transport */}
            <div>
              <label className="block text-sm font-medium mb-1">{t('Transport')}</label>
              <select
                value={transport}
                onChange={e => { setTransport(e.target.value as McpTransport); setArgs([]) }}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
              >
                <option value="stdio">{t('Command line (stdio)')}</option>
                <option value="sse">SSE (Server-Sent Events)</option>
                <option value="streamable-http">HTTP (Streamable)</option>
              </select>
            </div>

            {/* Command / URL */}
            <div>
              <label className="block text-sm font-medium mb-1">
                {isUrl ? t('URL') : t('Command')}
              </label>
              <input
                type="text"
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder={isUrl ? 'https://...' : 'npx'}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
              />
            </div>

            {/* Args (stdio only) */}
            {!isUrl && (
              <div>
                <label className="block text-sm font-medium mb-1">{t('Arguments')}</label>
                <div className="space-y-2">
                  {args.map((arg, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={arg}
                        onChange={e => updateArg(i, e.target.value)}
                        placeholder={t('Argument value')}
                        className="flex-1 px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
                      />
                      <button
                        onClick={() => removeArg(i)}
                        className="p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addArg}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('Add argument')}
                  </button>
                </div>
              </div>
            )}

            {/* Env vars */}
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('Environment Variables')}{' '}
                <span className="font-normal text-muted-foreground">(KEY=VALUE, {t('one per line')})</span>
              </label>
              <textarea
                value={envText}
                onChange={e => setEnvText(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="API_KEY=xxx"
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none transition-colors"
              />
            </div>

            {isUrl && (
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('Headers')}{' '}
                  <span className="font-normal text-muted-foreground">(KEY=VALUE, {t('one per line')})</span>
                </label>
                <textarea
                  value={headersText}
                  onChange={e => setHeadersText(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder={t('Authorization=Bearer <token>')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none transition-colors"
                />
              </div>
            )}
          </>
        ) : (
          /* JSON mode */
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('Configuration (JSON)')}
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              {t('Paste config from Cursor or Claude Desktop directly.')}
            </p>
            <textarea
              value={jsonText}
              onChange={e => handleJsonChange(e.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none transition-colors"
              placeholder={'{\n  "command": "npx",\n  "args": ["-y", "@example/mcp"],\n  "env": { "API_KEY": "xxx" }\n}'}
            />
            {jsonError && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-red-500">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {jsonError}
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {/* MCP stability warning */}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{t('MCP servers are injected into the Agent as system tools. An unstable MCP server will affect Agent reliability. Only proceed if you know what you are doing.')}</span>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={installing || (editMode === 'json' && !!jsonError)}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {installing ? t('Installing...') : t('Install')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Skill Form ──────────────────────────────────

function SkillForm({ onClose, installApp, loadApps }: FormProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) { setError(t('Name is required')); return }
    if (!content.trim()) { setError(t('Content is required')); return }

    setError(null)
    setInstalling(true)
    try {
      const spec = {
        name: name.trim(),
        type: 'skill' as const,
        description: `Skill: ${name.trim()}`,
        skill_content: content.trim(),
      }

      const appId = await installApp(null, spec)
      if (appId) {
        await loadApps()
        onClose()
      } else {
        setError(t('Installation failed. Please try again.'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Installation failed'))
    } finally {
      setInstalling(false)
    }
  }, [name, content, installApp, loadApps, onClose, t])

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">{t('Name')}</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('e.g. code-review-guidelines')}
          className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          {t('Content')} <span className="text-muted-foreground font-normal">(Markdown)</span>
        </label>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={10}
          placeholder={t('Write your skill instructions here in Markdown...')}
          className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
        />
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm border border-border rounded-md hover:bg-secondary transition-colors"
        >
          {t('Cancel')}
        </button>
        <button
          onClick={handleSubmit}
          disabled={installing}
          className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {installing ? t('Installing...') : t('Install')}
        </button>
      </div>
    </div>
  )
}
