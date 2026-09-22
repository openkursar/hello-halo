/**
 * The switches behind "what may this caller make my digital human do".
 *
 * Two screens ask the same question of two different callers — an IM guest and a
 * teammate in a team — so they share these fields and the vocabulary underneath
 * them. Only the framing differs, which is why the group labels are props.
 *
 * Presentational: it holds no state and saves nothing. The owning screen decides
 * what a change means and when to persist it.
 */

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  CAPABILITY_MCP_TOGGLES,
  CAPABILITY_TOOL_GROUPS,
  DELEGABLE_BUILTIN_TOOLS,
  allowsBuiltin,
  allowsCapability,
  allowsUserMcp,
  normalizeBashRules,
  resolveBashAccess,
} from '../../../shared/apps/capability-policy'
import type {
  BashAccess,
  CapabilityMode,
  CapabilityPolicy,
  CapabilityToolGroup,
} from '../../../shared/apps/capability-policy'
import { Switch } from '../ui/Switch'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'

interface CapabilityPolicyFieldsProps {
  policy: CapabilityPolicy | undefined
  onChange: (next: CapabilityPolicy) => void
  /**
   * How an unstated permission reads. 'strict' screens start from nothing
   * granted; 'permissive' ones start from everything granted, so a switch there
   * only ever takes something away.
   */
  mode: CapabilityMode
  /** Group headings. The "advanced" one is reworded per scenario. */
  groupLabels: Record<CapabilityToolGroup, string>
  /** Extra rows rendered with the Halo capabilities (e.g. periodic checks). */
  extraToggles?: { key: string; label: string; checked: boolean; onToggle: () => void }[]
}

/**
 * The command tool, which is the one capability that is not a yes/no question.
 *
 * "Anything" and "nothing" are both answers people actually want, and so is the
 * one in between — which is why it cannot be a switch: the middle answer needs
 * somewhere to write the commands down.
 *
 * The patterns are Claude Code's own permission rules, deliberately not a
 * Halo-invented syntax: they are what the engine matches against, they already
 * handle the case that matters (a command chained onto an allowed one is
 * checked part by part), and what a user learns here transfers.
 */
function CommandAccessFields({
  access,
  onScopeChange,
  onRulesChange,
}: {
  access: BashAccess
  onScopeChange: (scope: BashAccess['scope']) => void
  onRulesChange: (rules: string[]) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')

  const scopes: { id: BashAccess['scope']; label: string }[] = [
    { id: 'none', label: t('No commands') },
    { id: 'listed', label: t('Only these') },
    { id: 'full', label: t('Any command') },
  ]

  const addRule = () => {
    const next = normalizeBashRules([...access.rules, draft])
    if (next.length === access.rules.length) return
    onRulesChange(next)
    setDraft('')
  }

  return (
    <div className="space-y-2 border-t border-border/40 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-full shrink-0 text-xs text-muted-foreground/70 sm:w-28">
          {t('Running commands')}
        </span>
        {scopes.map(scope => (
          <button
            key={scope.id}
            type="button"
            onClick={() => onScopeChange(scope.id)}
            className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
              access.scope === scope.id
                ? 'border-primary/30 bg-primary/15 text-primary'
                : 'border-border bg-muted text-muted-foreground hover:border-primary/20'
            }`}
          >
            {scope.label}
          </button>
        ))}
      </div>

      {access.scope === 'listed' && (
        <div className="space-y-1.5 sm:pl-28">
          {access.rules.map(rule => (
            <div
              key={rule}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{rule}</code>
              <button
                type="button"
                onClick={() => onRulesChange(access.rules.filter(r => r !== rule))}
                aria-label={t('Remove')}
                className="flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRule() } }}
              placeholder={t('e.g. npm run:*')}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
            />
            <button
              type="button"
              onClick={addRule}
              aria-label={t('Add')}
              className="flex-shrink-0 rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground/70">
            {access.rules.length === 0
              ? t('Nothing listed yet, so no command runs. Write one per line, like "npm run:*" or "git log *".')
              : t('A command that chains others is allowed only if every part matches a line above.')}
          </p>
        </div>
      )}
    </div>
  )
}

export function CapabilityPolicyFields({
  policy,
  onChange,
  mode,
  groupLabels,
  extraToggles,
}: CapabilityPolicyFieldsProps) {
  const { t } = useTranslation()
  const mcpApps = useAppsStore(s => s.apps).filter(a => a.spec.type === 'mcp')

  // Both writes below settle the policy into an EXPLICIT list first. Otherwise
  // the first click on a permissive screen (where silence means yes) would read
  // as "only this one is allowed" and switch everything else off at once.
  const toggleBuiltin = (name: string) => {
    const current = new Set(
      policy?.allowedTools ?? (mode === 'permissive' ? DELEGABLE_BUILTIN_TOOLS.map(tl => tl.name) : [])
    )
    if (current.has(name)) current.delete(name)
    else current.add(name)
    onChange({ ...policy, allowedTools: Array.from(current) })
  }

  const toggleUserMcp = (specId: string) => {
    const current = new Set(
      policy?.allowedUserMcp ?? (mode === 'permissive' ? mcpApps.map(a => a.specId) : [])
    )
    if (current.has(specId)) current.delete(specId)
    else current.add(specId)
    onChange({ ...policy, allowedUserMcp: Array.from(current) })
  }

  const bash = resolveBashAccess(policy, mode)

  /**
   * Both halves of the command decision are written together. The tool's
   * presence lives in `allowedTools` and its reach in `bashScope`, so setting
   * one without the other is how the two come to disagree — a whitelist on a
   * tool that was never granted, or a grant that silently reads as "anything".
   */
  const setBashAccess = (scope: BashAccess['scope']) => {
    const granted = new Set(
      policy?.allowedTools ?? (mode === 'permissive' ? DELEGABLE_BUILTIN_TOOLS.map(tl => tl.name) : [])
    )
    if (scope === 'none') granted.delete('Bash')
    else granted.add('Bash')
    onChange({
      ...policy,
      allowedTools: Array.from(granted),
      bashScope: scope === 'listed' ? 'listed' : 'full',
    })
  }

  return (
    <div className="space-y-3">
      {CAPABILITY_TOOL_GROUPS.map(group => {
        // The command tool is not a switch — it has three answers, and the one
        // in the middle needs somewhere to write the commands down. It gets its
        // own section below.
        const tools = DELEGABLE_BUILTIN_TOOLS.filter(tl => tl.group === group && tl.name !== 'Bash')
        if (tools.length === 0) return null
        return (
          <div key={group} className="flex flex-wrap items-center gap-1.5">
            <span className="w-full shrink-0 text-xs text-muted-foreground/70 sm:w-28">
              {groupLabels[group]}
            </span>
            {tools.map(tool => {
              const on = allowsBuiltin(policy, tool.name, mode)
              return (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => toggleBuiltin(tool.name)}
                  className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
                    on
                      ? 'border-primary/30 bg-primary/15 text-primary'
                      : 'border-border bg-muted text-muted-foreground hover:border-primary/20'
                  }`}
                >
                  {tool.name}
                </button>
              )
            })}
          </div>
        )
      })}

      <CommandAccessFields
        access={bash}
        onScopeChange={setBashAccess}
        onRulesChange={rules => onChange({ ...policy, bashScope: 'listed', bashRules: rules })}
      />

      <div className="space-y-1.5 border-t border-border/40 pt-3">
        {CAPABILITY_MCP_TOGGLES.map(({ key, label }) => {
          // A terminal runs whatever is typed into it, so a command whitelist
          // cannot reach it. Rather than let the switch be turned on and quietly
          // do nothing, say why it is unavailable.
          const blockedByCommands = key === 'allowTerminal' && bash.scope !== 'full'
          return (
            <label
              key={key}
              className={`flex items-center justify-between gap-2 ${blockedByCommands ? 'opacity-60' : ''}`}
            >
              <span className="min-w-0 text-sm text-muted-foreground">
                {t(label)}
                {blockedByCommands && (
                  <span className="mt-0.5 block text-xs text-muted-foreground/70">
                    {t('Unavailable while commands are limited — a terminal runs anything typed into it.')}
                  </span>
                )}
              </span>
              <Switch
                size="sm"
                disabled={blockedByCommands}
                checked={allowsCapability(policy, key, mode)}
                onCheckedChange={() => onChange({ ...policy, [key]: !allowsCapability(policy, key, mode) })}
              />
            </label>
          )
        })}
        {extraToggles?.map(row => (
          <label key={row.key} className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">{row.label}</span>
            <Switch size="sm" checked={row.checked} onCheckedChange={row.onToggle} />
          </label>
        ))}
      </div>

      {mcpApps.length > 0 && (
        <div className="space-y-1.5 border-t border-border/40 pt-3">
          <p className="text-xs text-muted-foreground/70">{t('MCP servers you installed')}</p>
          {mcpApps.map(app => (
            <label key={app.specId} className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-muted-foreground">{app.spec.name}</span>
              <Switch
                size="sm"
                checked={allowsUserMcp(policy, app.specId, mode)}
                onCheckedChange={() => toggleUserMcp(app.specId)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
