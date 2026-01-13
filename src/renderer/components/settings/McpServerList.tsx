/**
 * MCP Server List Component
 * Displays list of configured MCP servers with expand/collapse editing
 * Uses CSS variables for theme support (light/dark)
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Server,
  Plus,
  ChevronDown,
  ChevronRight,
  Trash2,
  Terminal,
  Globe,
  Radio,
  Check,
  X,
  Code,
  Settings2,
  AlertCircle,
  Loader2,
  Power,
  PowerOff,
  CircleDot,
  Circle,
  AlertTriangle,
  Clock,
  RefreshCw
} from 'lucide-react'
import type { McpServerConfig, McpServersConfig, McpServerStatus } from '../../types'
import { useAppStore } from '../../stores/app.store'
import { api } from '../../api'
import { validateMcpServerConfig } from '../../utils/mcpValidation'
import { useTranslation } from '../../i18n'

interface McpServerListProps {
  servers: McpServersConfig
  onSave: (servers: McpServersConfig) => Promise<void>
}

// Status indicator component
function StatusIndicator({ status, t }: { status: McpServerStatus['status'] | null; t: (key: string) => string }) {
  if (!status) {
    // No status info available yet
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" title={t('Status unknown - available after starting conversation')}>
        <Circle className="w-3 h-3" />
      </span>
    )
  }

  switch (status) {
    case 'connected':
      return (
        <span className="flex items-center gap-1 text-xs text-green-500" title={t('Connected')}>
          <CircleDot className="w-3 h-3" />
        </span>
      )
    case 'failed':
      return (
        <span className="flex items-center gap-1 text-xs text-red-500" title={t('Connection failed')}>
          <AlertTriangle className="w-3 h-3" />
        </span>
      )
    case 'needs-auth':
      return (
        <span className="flex items-center gap-1 text-xs text-amber-500" title={t('Authentication required')}>
          <AlertCircle className="w-3 h-3" />
        </span>
      )
    case 'pending':
      return (
        <span className="flex items-center gap-1 text-xs text-blue-500" title={t('Connecting...')}>
          <Clock className="w-3 h-3" />
        </span>
      )
    default:
      return null
  }
}

type EditMode = 'visual' | 'json'

// Get server type icon
function getServerTypeIcon(config: McpServerConfig) {
  const type = config.type || 'stdio'
  switch (type) {
    case 'stdio':
      return <Terminal className="w-4 h-4" />
    case 'http':
      return <Globe className="w-4 h-4" />
    case 'sse':
      return <Radio className="w-4 h-4" />
    default:
      return <Server className="w-4 h-4" />
  }
}

// Get server type label key (returns translation key)
function getServerTypeLabelKey(config: McpServerConfig): string {
  const type = config.type || 'stdio'
  switch (type) {
    case 'stdio':
      return 'Command line'
    case 'http':
      return 'HTTP'
    case 'sse':
      return 'SSE'
    default:
      return type
  }
}

// Server item component
function ServerItem({
  name,
  config,
  status,
  isExpanded,
  onToggleExpand,
  onToggleDisabled,
  onDelete,
  onSave
}: {
  name: string
  config: McpServerConfig
  status: McpServerStatus['status'] | null
  isExpanded: boolean
  onToggleExpand: () => void
  onToggleDisabled: () => void
  onDelete: () => void
  onSave: (newName: string, newConfig: McpServerConfig) => Promise<void>
}) {
  const { t } = useTranslation()
  const [editMode, setEditMode] = useState<EditMode>('visual')
  const [editingName, setEditingName] = useState(name)
  const [editingConfig, setEditingConfig] = useState<McpServerConfig>(config)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  // Initialize editing state when expanded
  useEffect(() => {
    if (isExpanded) {
      setEditingName(name)
      setEditingConfig(config)
      setJsonText(JSON.stringify(config, null, 2))
      setJsonError(null)
      setHasChanges(false)
    }
  }, [isExpanded, name, config])

  // Handle visual mode changes
  const updateVisualField = useCallback((field: string, value: unknown) => {
    setEditingConfig(prev => {
      const updated = { ...prev, [field]: value }
      setHasChanges(true)
      // Sync to JSON
      setJsonText(JSON.stringify(updated, null, 2))
      return updated
    })
  }, [])

  // Handle args change (array of strings)
  const updateArgs = useCallback((index: number, value: string) => {
    setEditingConfig(prev => {
      if (!('command' in prev)) return prev
      const args = [...(prev.args || [])]
      args[index] = value
      const updated = { ...prev, args }
      setHasChanges(true)
      setJsonText(JSON.stringify(updated, null, 2))
      return updated
    })
  }, [])

  const addArg = useCallback(() => {
    setEditingConfig(prev => {
      if (!('command' in prev)) return prev
      const args = [...(prev.args || []), '']
      const updated = { ...prev, args }
      setHasChanges(true)
      setJsonText(JSON.stringify(updated, null, 2))
      return updated
    })
  }, [])

  const removeArg = useCallback((index: number) => {
    setEditingConfig(prev => {
      if (!('command' in prev)) return prev
      const args = (prev.args || []).filter((_, i) => i !== index)
      const updated = { ...prev, args }
      setHasChanges(true)
      setJsonText(JSON.stringify(updated, null, 2))
      return updated
    })
  }, [])

  // Handle JSON mode changes - validate on parse
  const handleJsonChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setJsonText(text)
    setHasChanges(true)
    try {
      const parsed = JSON.parse(text)
      // Validate config structure
      const validationError = validateMcpServerConfig(parsed)
      if (validationError) {
        setJsonError(validationError)
      } else {
        setEditingConfig(parsed)
        setJsonError(null)
      }
    } catch (err) {
      setJsonError((err as Error).message)
    }
  }, [])

  // Handle name change
  const handleNameChange = useCallback((value: string) => {
    setEditingName(value)
    setHasChanges(true)
  }, [])

  // Save changes
  const handleSave = async () => {
    if (jsonError) return
    // Final validation before save
    const validationError = validateMcpServerConfig(editingConfig)
    if (validationError) {
      setJsonError(validationError)
      return
    }
    setIsSaving(true)
    try {
      await onSave(editingName, editingConfig)
      setHasChanges(false)
    } finally {
      setIsSaving(false)
    }
  }

  // Cancel changes
  const handleCancel = () => {
    setEditingName(name)
    setEditingConfig(config)
    setJsonText(JSON.stringify(config, null, 2))
    setJsonError(null)
    setHasChanges(false)
    onToggleExpand()
  }

  const serverType = editingConfig.type || 'stdio'
  const isDisabled = config.disabled === true

  return (
    <div className={`border rounded-lg overflow-hidden transition-opacity ${
      isDisabled ? 'border-border/50 opacity-60' : 'border-border'
    }`}>
      {/* Header row */}
      <div
        className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
          isDisabled ? 'bg-muted/30 hover:bg-muted/50' : 'bg-secondary/50 hover:bg-secondary'
        }`}
        onClick={onToggleExpand}
      >
        {/* Expand/collapse arrow */}
        <div className="flex-shrink-0">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
        </div>

        {/* Content: name + status on first line, description on second */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {/* Status indicator */}
            {!isDisabled && (
              <StatusIndicator status={status} t={t} />
            )}
            <span className={`font-medium truncate ${isDisabled ? 'text-muted-foreground' : 'text-foreground'}`}>
              {name}
            </span>
            {isDisabled && (
              <span className="text-xs font-normal text-muted-foreground/70 flex-shrink-0">{t('Disabled')}</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 pl-5">
            {t(getServerTypeLabelKey(config))}
            {config.type !== 'stdio' && 'url' in config && (
              <span className="ml-1.5 opacity-70">• {config.url}</span>
            )}
            {(!config.type || config.type === 'stdio') && 'command' in config && (
              <span className="ml-1.5 opacity-70">• {config.command}</span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={onToggleDisabled}
            className={`p-1.5 rounded transition-colors ${
              isDisabled
                ? 'text-muted-foreground hover:text-green-500 hover:bg-green-500/10'
                : 'text-green-500 hover:text-muted-foreground hover:bg-muted'
            }`}
            title={isDisabled ? t('Enable') : t('Disable')}
          >
            {isDisabled ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
            title={t('Delete')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Expanded edit area */}
      {isExpanded && (
        <div className="border-t border-border">
          {/* Mode toggle */}
          <div className="flex items-center justify-between px-4 py-2 bg-muted/50">
            <div className="flex items-center gap-1 p-0.5 bg-secondary rounded-lg">
              <button
                onClick={() => setEditMode('visual')}
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
                onClick={() => setEditMode('json')}
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
              <span className="text-xs text-amber-500">
                {t('Unsaved changes')}
              </span>
            )}
          </div>

          {/* Edit content */}
          <div className="p-4">
            {editMode === 'visual' ? (
              <div className="space-y-4">
                {/* Server name */}
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    {t('Server name')}
                  </label>
                  <input
                    type="text"
                    value={editingName}
                    onChange={e => handleNameChange(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                    placeholder="my-mcp-server"
                  />
                </div>

                {/* Type selector */}
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    {t('Type')}
                  </label>
                  <select
                    value={serverType}
                    onChange={e => {
                      const newType = e.target.value as 'stdio' | 'http' | 'sse'
                      let newConfig: McpServerConfig
                      if (newType === 'stdio') {
                        newConfig = { type: 'stdio', command: '' }
                      } else if (newType === 'http') {
                        newConfig = { type: 'http', url: '' }
                      } else {
                        newConfig = { type: 'sse', url: '' }
                      }
                      setEditingConfig(newConfig)
                      setHasChanges(true)
                      setJsonText(JSON.stringify(newConfig, null, 2))
                    }}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                  >
                    <option value="stdio">{t('Command line (stdio)')}</option>
                    <option value="http">HTTP</option>
                    <option value="sse">SSE (Server-Sent Events)</option>
                  </select>
                </div>

                {/* Type-specific fields */}
                {serverType === 'stdio' && 'command' in editingConfig && (
                  <>
                    {/* Command */}
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                        {t('Command')}
                      </label>
                      <input
                        type="text"
                        value={(editingConfig as { command: string }).command}
                        onChange={e => updateVisualField('command', e.target.value)}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm transition-colors"
                        placeholder="npx"
                      />
                    </div>

                    {/* Args */}
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                        {t('Arguments')}
                      </label>
                      <div className="space-y-2">
                        {((editingConfig as { args?: string[] }).args || []).map((arg, index) => (
                          <div key={index} className="flex items-center gap-2">
                            <input
                              type="text"
                              value={arg}
                              onChange={e => updateArgs(index, e.target.value)}
                              className="flex-1 px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm transition-colors"
                              placeholder={t('Argument value')}
                            />
                            <button
                              onClick={() => removeArg(index)}
                              className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                        <button
                          onClick={addArg}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                          {t('Add argument')}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {(serverType === 'http' || serverType === 'sse') && 'url' in editingConfig && (
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                      URL
                    </label>
                    <input
                      type="text"
                      value={(editingConfig as { url: string }).url}
                      onChange={e => updateVisualField('url', e.target.value)}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm transition-colors"
                      placeholder="https://api.example.com/mcp"
                    />
                  </div>
                )}
              </div>
            ) : (
              /* JSON mode */
              <div>
                <textarea
                  value={jsonText}
                  onChange={handleJsonChange}
                  spellCheck={false}
                  className="w-full h-48 px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm resize-none transition-colors"
                  placeholder='{ "command": "npx", "args": ["-y", "@example/mcp"] }'
                />
                {jsonError && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-red-500">
                    <AlertCircle className="w-4 h-4" />
                    {jsonError}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-muted/30">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!!jsonError || isSaving || !hasChanges}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground rounded-lg transition-colors"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('Saving...')}
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  {t('Save')}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Add new server dialog - consistent with edit UI
function AddServerDialog({
  onAdd,
  onCancel
}: {
  onAdd: (name: string, config: McpServerConfig) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [editMode, setEditMode] = useState<EditMode>('visual')
  const [name, setName] = useState('')
  const [serverType, setServerType] = useState<'stdio' | 'http' | 'sse'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState<string[]>([])
  const [url, setUrl] = useState('')
  const [jsonText, setJsonText] = useState('{\n  "command": "npx",\n  "args": ["-y", "@example/mcp-server"]\n}')
  const [jsonError, setJsonError] = useState<string | null>(null)

  // Build config from visual fields
  const buildConfigFromVisual = useCallback((): McpServerConfig => {
    if (serverType === 'stdio') {
      return { command, args: args.filter(a => a.trim()) }
    } else if (serverType === 'http') {
      return { type: 'http', url }
    } else {
      return { type: 'sse', url }
    }
  }, [serverType, command, args, url])

  // Sync visual changes to JSON
  useEffect(() => {
    if (editMode === 'visual') {
      const config = buildConfigFromVisual()
      setJsonText(JSON.stringify(config, null, 2))
    }
  }, [editMode, buildConfigFromVisual])

  // Handle JSON mode changes
  const handleJsonChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setJsonText(text)
    try {
      const parsed = JSON.parse(text)
      const validationError = validateMcpServerConfig(parsed)
      if (validationError) {
        setJsonError(validationError)
      } else {
        // Sync parsed JSON back to visual fields
        if ('command' in parsed) {
          setServerType('stdio')
          setCommand(parsed.command || '')
          setArgs(parsed.args || [])
        } else if (parsed.type === 'http') {
          setServerType('http')
          setUrl(parsed.url || '')
        } else if (parsed.type === 'sse') {
          setServerType('sse')
          setUrl(parsed.url || '')
        }
        setJsonError(null)
      }
    } catch (err) {
      setJsonError((err as Error).message)
    }
  }, [])

  const handleSubmit = () => {
    if (!name.trim()) return

    if (editMode === 'json') {
      // Validate JSON before submit
      try {
        const parsed = JSON.parse(jsonText)
        const validationError = validateMcpServerConfig(parsed)
        if (validationError) {
          setJsonError(validationError)
          return
        }
        onAdd(name.trim(), parsed)
      } catch (err) {
        setJsonError((err as Error).message)
        return
      }
    } else {
      onAdd(name.trim(), buildConfigFromVisual())
    }
  }

  const addArg = () => setArgs([...args, ''])
  const updateArg = (index: number, value: string) => {
    const newArgs = [...args]
    newArgs[index] = value
    setArgs(newArgs)
  }
  const removeArg = (index: number) => setArgs(args.filter((_, i) => i !== index))

  const isValidVisual = name.trim() && (
    (serverType === 'stdio' && command.trim()) ||
    ((serverType === 'http' || serverType === 'sse') && url.trim())
  )
  const isValidJson = name.trim() && !jsonError && jsonText.trim()
  const isValid = editMode === 'visual' ? isValidVisual : isValidJson

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Mode toggle - same style as edit mode */}
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
        <h4 className="font-medium text-foreground text-sm">
          {t('Add new server')}
        </h4>
        <div className="flex items-center gap-1 p-0.5 bg-secondary rounded-lg">
          <button
            onClick={() => setEditMode('visual')}
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
            onClick={() => setEditMode('json')}
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
      </div>

      <div className="p-4">
        {editMode === 'visual' ? (
          <div className="space-y-4">
            {/* Server name */}
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                {t('Server name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                placeholder="my-mcp-server"
                autoFocus
              />
            </div>

            {/* Type selector */}
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                {t('Type')}
              </label>
              <select
                value={serverType}
                onChange={e => setServerType(e.target.value as 'stdio' | 'http' | 'sse')}
                className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
              >
                <option value="stdio">{t('Command line (stdio)')}</option>
                <option value="http">HTTP</option>
                <option value="sse">SSE (Server-Sent Events)</option>
              </select>
            </div>

            {/* Type-specific fields */}
            {serverType === 'stdio' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    {t('Command')}
                  </label>
                  <input
                    type="text"
                    value={command}
                    onChange={e => setCommand(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm transition-colors"
                    placeholder="npx"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    {t('Arguments')}
                  </label>
                  <div className="space-y-2">
                    {args.map((arg, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={arg}
                          onChange={e => updateArg(index, e.target.value)}
                          className="flex-1 px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm transition-colors"
                          placeholder={t('Argument value')}
                        />
                        <button
                          onClick={() => removeArg(index)}
                          className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={addArg}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      {t('Add argument')}
                    </button>
                  </div>
                </div>
              </>
            )}

            {(serverType === 'http' || serverType === 'sse') && (
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">
                  URL
                </label>
                <input
                  type="text"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm transition-colors"
                  placeholder="https://api.example.com/mcp"
                />
              </div>
            )}
          </div>
        ) : (
          /* JSON mode */
          <div className="space-y-4">
            {/* Server name - also needed in JSON mode */}
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                {t('Server name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                placeholder="my-mcp-server"
                autoFocus
              />
            </div>

            {/* JSON config */}
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                {t('Configuration (JSON)')}
              </label>
              <textarea
                value={jsonText}
                onChange={handleJsonChange}
                spellCheck={false}
                className="w-full h-48 px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-sm resize-none transition-colors"
                placeholder='{ "command": "npx", "args": ["-y", "@example/mcp"] }'
              />
              {jsonError && (
                <div className="mt-2 flex items-center gap-2 text-sm text-red-500">
                  <AlertCircle className="w-4 h-4" />
                  {jsonError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions - consistent with edit mode style */}
      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-muted/30">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
        >
          {t('Cancel')}
        </button>
        <button
          onClick={handleSubmit}
          disabled={!isValid}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('Add')}
        </button>
      </div>
    </div>
  )
}

// Main component
export function McpServerList({ servers, onSave }: McpServerListProps) {
  const { t } = useTranslation()
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [isAddingNew, setIsAddingNew] = useState(false)
  const [localServers, setLocalServers] = useState<McpServersConfig>(servers)
  const [isTesting, setIsTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  // Get MCP status from global store
  const { mcpStatus, mcpStatusTimestamp } = useAppStore()

  // Create a map for quick status lookup
  const statusMap = new Map(mcpStatus.map(s => [s.name, s.status]))

  // Sync with props
  useEffect(() => {
    setLocalServers(servers)
  }, [servers])

  const serverNames = Object.keys(localServers)
  const enabledCount = serverNames.filter(name => !localServers[name].disabled).length
  const connectedCount = serverNames.filter(name =>
    !localServers[name].disabled && statusMap.get(name) === 'connected'
  ).length

  // Test MCP connections
  const handleTestConnections = async () => {
    setIsTesting(true)
    setTestError(null)
    try {
      const result = await api.testMcpConnections()
      if (!result.success && result.error) {
        setTestError(result.error)
      }
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setIsTesting(false)
    }
  }

  const handleToggleExpand = (name: string) => {
    if (isAddingNew) setIsAddingNew(false)
    setExpandedServer(prev => prev === name ? null : name)
  }

  const handleToggleDisabled = async (name: string) => {
    const config = localServers[name]
    const newConfig = { ...config, disabled: !config.disabled }
    const newServers = { ...localServers, [name]: newConfig }
    setLocalServers(newServers)
    await onSave(newServers)
  }

  const handleDelete = async (name: string) => {
    const { [name]: _, ...rest } = localServers
    setLocalServers(rest)
    await onSave(rest)
    if (expandedServer === name) {
      setExpandedServer(null)
    }
  }

  const handleSaveServer = async (oldName: string, newName: string, config: McpServerConfig) => {
    let newServers: McpServersConfig

    if (oldName !== newName) {
      // Name changed - remove old key and add new
      const { [oldName]: _, ...rest } = localServers
      newServers = { ...rest, [newName]: config }
    } else {
      newServers = { ...localServers, [newName]: config }
    }

    setLocalServers(newServers)
    await onSave(newServers)

    if (oldName !== newName) {
      setExpandedServer(newName)
    }
  }

  const handleAddServer = async (name: string, config: McpServerConfig) => {
    const newServers = { ...localServers, [name]: config }
    setLocalServers(newServers)
    await onSave(newServers)
    setIsAddingNew(false)
    setExpandedServer(name)
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="w-5 h-5 text-primary" />
          <h3 className="font-medium text-foreground">
            {t('MCP Servers')}
          </h3>
          {serverNames.length > 0 && (
            <>
              <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded-full">
                {enabledCount}/{serverNames.length}
              </span>
              {/* Show connection status if we have status info */}
              {mcpStatusTimestamp && enabledCount > 0 && (
                <span className={`px-2 py-0.5 text-xs rounded-full ${
                  connectedCount === enabledCount
                    ? 'bg-green-500/10 text-green-500'
                    : connectedCount > 0
                    ? 'bg-amber-500/10 text-amber-500'
                    : 'bg-red-500/10 text-red-500'
                }`}>
                  {connectedCount}/{enabledCount} {t('connected')}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Test connections button */}
          {enabledCount > 0 && (
            <button
              onClick={handleTestConnections}
              disabled={isTesting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-50"
              title={t('Test all MCP server connections')}
            >
              <RefreshCw className={`w-4 h-4 ${isTesting ? 'animate-spin' : ''}`} />
              {isTesting ? t('Testing...') : t('Test connections')}
            </button>
          )}

          <button
            onClick={() => {
              setExpandedServer(null)
              setIsAddingNew(true)
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('Add')}
          </button>
        </div>
      </div>

      {/* Test error message */}
      {testError && (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-red-500 bg-red-500/10 rounded-lg">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{testError}</span>
          <button
            onClick={() => setTestError(null)}
            className="ml-auto p-0.5 hover:bg-red-500/20 rounded"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Description */}
      <p className="text-sm text-muted-foreground">
        {t('Configure MCP (Model Context Protocol) servers to extend AI capabilities. Format compatible with Cursor / Claude Desktop.')}
      </p>

      {/* Server list */}
      {serverNames.length === 0 && !isAddingNew ? (
        <div className="py-8 text-center">
          <Server className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground text-sm">
            {t('No MCP servers configured yet')}
          </p>
          <button
            onClick={() => setIsAddingNew(true)}
            className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('Add first server')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {serverNames.map(name => (
            <ServerItem
              key={name}
              name={name}
              config={localServers[name]}
              status={statusMap.get(name) || null}
              isExpanded={expandedServer === name}
              onToggleExpand={() => handleToggleExpand(name)}
              onToggleDisabled={() => handleToggleDisabled(name)}
              onDelete={() => handleDelete(name)}
              onSave={(newName, config) => handleSaveServer(name, newName, config)}
            />
          ))}

          {isAddingNew && (
            <AddServerDialog
              onAdd={handleAddServer}
              onCancel={() => setIsAddingNew(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
