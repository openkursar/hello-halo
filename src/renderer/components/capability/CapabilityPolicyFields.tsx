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

import {
  CAPABILITY_MCP_TOGGLES,
  CAPABILITY_TOOL_GROUPS,
  DELEGABLE_BUILTIN_TOOLS,
  allowsBuiltin,
  allowsCapability,
  allowsUserMcp,
} from '../../../shared/apps/capability-policy'
import type {
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

  return (
    <div className="space-y-3">
      {CAPABILITY_TOOL_GROUPS.map(group => {
        const tools = DELEGABLE_BUILTIN_TOOLS.filter(tl => tl.group === group)
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

      <div className="space-y-1.5 border-t border-border/40 pt-3">
        {CAPABILITY_MCP_TOGGLES.map(({ key, label }) => (
          <label key={key} className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">{t(label)}</span>
            <Switch
              size="sm"
              checked={allowsCapability(policy, key, mode)}
              onCheckedChange={() => onChange({ ...policy, [key]: !allowsCapability(policy, key, mode) })}
            />
          </label>
        ))}
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
