/**
 * The tools an MCP server offers, each with its own switch. A tool turned off
 * is kept out of every session (the app's `disabledTools`).
 */

import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { Switch } from '../ui/Switch'

interface McpToolSwitchesProps {
  /** The tools the server was last seen offering. */
  tools: string[]
  /** The tools turned off, as stored. */
  disabledTools: string[]
  /** Saves the whole list of turned-off tools; resolves false when it could not. */
  onSave: (disabledTools: string[]) => Promise<boolean>
  /** The engine in use leaves single MCP tools in, so say the switches do not reach it. */
  engineIgnoresSwitches?: boolean
}

/**
 * The tools to list: those last seen plus those turned off. A session reports
 * a server's tools without the ones it was not given, so a tool turned off
 * must stay listed from the stored list or it could never be turned back on.
 */
export function listedMcpTools(tools: readonly string[], disabledTools: readonly string[]): string[] {
  return [...new Set([...tools, ...disabledTools])]
}

export function McpToolSwitches({ tools, disabledTools, onSave, engineIgnoresSwitches }: McpToolSwitchesProps) {
  const { t } = useTranslation()
  const [disabled, setDisabled] = useState(disabledTools)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Follows the stored list, except while a change made here is being saved.
  useEffect(() => {
    if (!saving) setDisabled(disabledTools)
  }, [disabledTools, saving])

  const save = async (next: string[]) => {
    const previous = disabled
    setDisabled(next)
    setSaving(true)
    setError(null)
    const ok = await onSave(next).catch(() => false)
    setSaving(false)
    if (!ok) {
      setDisabled(previous)
      setError(t('Could not save the change. Please try again.'))
    }
  }

  const listed = listedMcpTools(tools, disabled)
  const off = new Set(disabled)
  const onCount = listed.filter(tool => !off.has(tool)).length

  return (
    <div className="pl-5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{t('{{on}} of {{total}} tools on', { on: onCount, total: listed.length })}</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={saving || onCount === listed.length}
            onClick={() => save([])}
            className="text-primary hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {t('Turn all on')}
          </button>
          <button
            type="button"
            disabled={saving || onCount === 0}
            onClick={() => save(listed)}
            className="text-primary hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {t('Turn all off')}
          </button>
        </div>
      </div>
      <ul className="space-y-1">
        {listed.map(tool => (
          <li key={tool} className="flex items-center justify-between gap-3 min-w-0">
            <span
              className={`text-xs font-mono truncate ${off.has(tool) ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}
              title={tool}
            >
              {tool}
            </span>
            <Switch
              size="sm"
              ariaLabel={tool}
              checked={!off.has(tool)}
              disabled={saving}
              onCheckedChange={on => save(on ? disabled.filter(name => name !== tool) : [...disabled, tool])}
            />
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {t('Tools turned off are left out of every conversation and digital human run. Conversations already open use the change from their next message.')}
      </p>
      {engineIgnoresSwitches && (
        <p className="text-[11px] text-amber-500">
          {t('The DSH engine cannot leave out single MCP tools: tools turned off here stay available in its conversations.')}
        </p>
      )}
      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </div>
  )
}
