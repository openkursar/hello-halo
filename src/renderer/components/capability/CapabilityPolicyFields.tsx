/**
 * The switches behind "what may this caller make my digital human do".
 *
 * Two screens ask the same question of two different callers — an IM guest and a
 * teammate in a team — so they share these fields and the vocabulary underneath
 * them. Only the framing differs, which is why the audience is a prop.
 *
 * Every switch says in words what it lets the caller do; the tool's own name is
 * only a footnote. Nothing depends on hovering, which phones and the remote web
 * page do not have.
 *
 * Presentational: it holds no state it saves. The owning screen decides what a
 * change means and when to persist it.
 */

import { useState } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import {
  CAPABILITY_MCP_TOGGLES,
  CAPABILITY_TOOL_GROUPS,
  DELEGABLE_BUILTIN_TOOLS,
  allowsBuiltin,
  allowsCapability,
  allowsSkill,
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
import { Switch, switchRowHover } from '../ui/Switch'
import { HelpHint } from '../ui/HelpHint'
import { ConfirmDialog } from '../ui/ConfirmDialog'
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
  /** Who the caller is — decides the wording, never what a switch does. */
  audience: 'guest' | 'teammate'
  /** Extra rows rendered with the Halo capabilities (e.g. periodic checks). */
  extraToggles?: { key: string; label: string; checked: boolean; onToggle: () => void }[]
  /**
   * The skills the digital human can load, one switch each. Absent: the screen
   * has no list to offer, and shows no skills group.
   */
  skills?: { dirName: string; name: string; description: string }[]
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
  audience,
  onScopeChange,
  onRulesChange,
}: {
  access: BashAccess
  audience: 'guest' | 'teammate'
  onScopeChange: (scope: BashAccess['scope']) => void
  onRulesChange: (rules: string[]) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  // "Any command" reaches past every file boundary, so it is confirmed first;
  // stepping back from it needs no confirmation.
  const [confirmingFull, setConfirmingFull] = useState(false)
  const chooseScope = (scope: BashAccess['scope']) => {
    if (scope === 'full' && access.scope !== 'full') setConfirmingFull(true)
    else onScopeChange(scope)
  }

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
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="min-w-0">
          <div className="text-sm text-foreground">{t('Run commands')}</div>
          <p className="text-xs text-muted-foreground">
            {t('Run programs on your computer (Bash). Commands are not limited to this workspace.')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
        {scopes.map(scope => (
          <button
            key={scope.id}
            type="button"
            onClick={() => chooseScope(scope.id)}
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
      </div>

      {access.scope === 'full' && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" />
          <p className="text-xs text-destructive">
            {audience === 'guest'
              ? t('Guests can run any command on your computer, including reading, changing or deleting any file — not limited to this workspace.')
              : t('Teammates can run any command on your computer, including reading, changing or deleting any file — not limited to this workspace.')}
          </p>
        </div>
      )}

      {confirmingFull && (
        <ConfirmDialog
          title={t('Allow any command?')}
          message={audience === 'guest'
            ? t('Guests will be able to run any command on your computer, including reading, changing or deleting any file, without the workspace limit.')
            : t('Teammates will be able to run any command on your computer, including reading, changing or deleting any file, without the workspace limit.')}
          confirmLabel={t('Allow any command')}
          cancelLabel={t('Cancel')}
          variant="danger"
          onConfirm={() => { setConfirmingFull(false); onScopeChange('full') }}
          onCancel={() => setConfirmingFull(false)}
        />
      )}

      {access.scope === 'listed' && (
        <div className="space-y-1.5">
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

/** A built-in tool as a person meets it: what it does, in words. */
interface ToolRow {
  /** Tool names this one switch turns on and off together */
  tools: string[]
  group: CapabilityToolGroup
  name: string
  description: string
}

/** Everything the summary line can name, in the order it names them. */
interface Ability {
  on: boolean
  label: string
}

const TOGGLE_ROW = `flex items-center justify-between gap-3 py-1.5 ${switchRowHover}`
const TOGGLE_TITLE = 'text-sm text-foreground'

export function CapabilityPolicyFields({
  policy,
  onChange,
  mode,
  audience,
  extraToggles,
  skills,
}: CapabilityPolicyFieldsProps) {
  const { t } = useTranslation()
  const mcpApps = useAppsStore(s => s.apps).filter(a => a.spec.type === 'mcp')

  const rows: ToolRow[] = [
    { tools: ['Read'], group: 'file', name: t('Read files'), description: t('See the contents of files in this workspace (Read)') },
    { tools: ['Glob'], group: 'file', name: t('Find files'), description: t('Find files by name (Glob)') },
    { tools: ['Grep'], group: 'file', name: t('Search contents'), description: t('Search for text inside files (Grep)') },
    { tools: ['WebFetch'], group: 'network', name: t('Open web pages'), description: t('Read a web page it is given (WebFetch)') },
    { tools: ['WebSearch'], group: 'network', name: t('Web search'), description: t('Look things up with a search engine (WebSearch)') },
    {
      tools: ['Agent'], group: 'other', name: t('Subtasks'),
      description: t('Hand parts of a task to sub-agents working in parallel, under the same limits; uses more model quota (Agent)'),
    },
    { tools: ['Write'], group: 'advanced', name: t('Write files'), description: t('Create files in this workspace (Write)') },
    {
      tools: ['Edit', 'NotebookEdit'], group: 'advanced', name: t('Edit files'),
      description: t('Change files in this workspace (Edit / NotebookEdit)'),
    },
  ]

  const groupTitle: Record<CapabilityToolGroup, string> = {
    file: t('View files'),
    network: t('Internet'),
    other: t('Other'),
    advanced: t('Change files and run commands'),
  }
  // A guest is always held to the workspace; a teammate only when the request
  // came from another computer (see apps/runtime turn-file-access).
  const groupHelp: Record<CapabilityToolGroup, string> = {
    file: audience === 'guest'
      ? t('Only inside this workspace. The workspace\'s internal data — every conversation\'s record — stays closed; memory stays open.')
      : t('For requests from another computer, only inside this workspace, with its internal data closed and memory open. Teammates on this computer are not limited to it.'),
    network: t('Reaches the internet, not files on your computer.'),
    other: t('Sub-agents are held to exactly the same limits as the task that started them.'),
    advanced: audience === 'guest'
      ? t('Writing is limited to this workspace. Commands are not: they run on your computer with your permissions.')
      : t('For requests from another computer, writing is limited to this workspace. Commands never are: they run on your computer with your permissions.'),
  }

  // Both writes below settle the policy into an EXPLICIT list first. Otherwise
  // the first click on a permissive screen (where silence means yes) would read
  // as "only this one is allowed" and switch everything else off at once.
  const explicitTools = () => new Set(
    policy?.allowedTools ?? (mode === 'permissive' ? DELEGABLE_BUILTIN_TOOLS.map(tl => tl.name) : [])
  )

  const setRow = (row: ToolRow, on: boolean) => {
    const current = explicitTools()
    for (const name of row.tools) {
      if (on) current.add(name)
      else current.delete(name)
    }
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

  // Written as the list of skills that exist now: one that was removed keeps no
  // standing grant a later skill of the same name would inherit.
  const setSkill = (dirName: string, on: boolean) => {
    const listed = skills ?? []
    const current = new Set(listed.filter(s => allowsSkill(policy, s.dirName, mode)).map(s => s.dirName))
    if (on) current.add(dirName)
    else current.delete(dirName)
    onChange({ ...policy, allowedSkills: Array.from(current) })
  }

  const bash = resolveBashAccess(policy, mode)
  // On when any of its tools is: a switch must never show a granted tool as off.
  const rowOn = (row: ToolRow) => row.tools.some(name => allowsBuiltin(policy, name, mode))

  /**
   * Both halves of the command decision are written together. The tool's
   * presence lives in `allowedTools` and its reach in `bashScope`, so setting
   * one without the other is how the two come to disagree — a whitelist on a
   * tool that was never granted, or a grant that silently reads as "anything".
   */
  const setBashAccess = (scope: BashAccess['scope']) => {
    const granted = explicitTools()
    if (scope === 'none') granted.delete('Bash')
    else granted.add('Bash')
    onChange({
      ...policy,
      allowedTools: Array.from(granted),
      bashScope: scope === 'listed' ? 'listed' : 'full',
    })
  }

  const on = (group: CapabilityToolGroup, tools?: string[]) =>
    rows.some(r => r.group === group && (!tools || r.tools.some(n => tools.includes(n))) && rowOn(r))
  const abilities: Ability[] = [
    { on: on('file'), label: audience === 'guest' ? t('view files in this workspace') : t('view files') },
    { on: on('network'), label: t('use the internet') },
    { on: on('other'), label: t('split work into subtasks') },
    { on: on('advanced'), label: audience === 'guest' ? t('change files in this workspace') : t('change files') },
    {
      // An empty list runs nothing.
      on: bash.scope === 'full' || (bash.scope === 'listed' && bash.rules.length > 0),
      label: bash.scope === 'full' ? t('run any command') : t('run the listed commands'),
    },
    {
      on: !!skills?.some(s => allowsSkill(policy, s.dirName, mode)),
      label: t('use the skills you allowed'),
    },
    ...CAPABILITY_MCP_TOGGLES.map(({ key, label }) => ({ on: allowsCapability(policy, key, mode), label: t(label) })),
  ]
  const granted = abilities.filter(a => a.on).map(a => a.label)
  const summary = granted.length === 0
    ? (audience === 'guest' ? t('Guests can currently only chat and use memory.') : t('Teammates can currently only chat and use memory.'))
    : (audience === 'guest'
      ? t('Guests can currently: {{list}}', { list: granted.join(t(', ')) })
      : t('Teammates can currently: {{list}}', { list: granted.join(t(', ')) }))

  return (
    <div className="space-y-3">
      <div className="space-y-1 rounded-lg bg-secondary/60 px-3 py-2">
        <p className="text-sm text-foreground">{summary}</p>
        <p className="text-xs text-muted-foreground">
          {audience === 'guest'
            ? t('Memory is always available and not affected by these settings. File access is limited to this workspace.')
            : t('Requests from another computer can always use memory, and their file access is limited to this workspace. Teammates on this computer are held to these switches only.')}
        </p>
      </div>

      {CAPABILITY_TOOL_GROUPS.map(group => {
        const groupRows = rows.filter(r => r.group === group)
        if (groupRows.length === 0 && group !== 'advanced') return null
        return (
          <div key={group} className="space-y-2 border-t border-border/40 pt-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{groupTitle[group]}</span>
              {group === 'advanced' && (
                <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-500">
                  {t('Risky')}
                </span>
              )}
              <HelpHint label={t('More about this group')} text={groupHelp[group]} />
            </div>
            {groupRows.map(row => (
              <label key={row.tools.join('+')} className={`${TOGGLE_ROW} cursor-pointer`}>
                <span className="min-w-0">
                  <span className={`block ${TOGGLE_TITLE}`}>{row.name}</span>
                  <span className="block text-xs text-muted-foreground">{row.description}</span>
                </span>
                <Switch size="sm" checked={rowOn(row)} onCheckedChange={next => setRow(row, next)} />
              </label>
            ))}
            {group === 'advanced' && (
              <CommandAccessFields
                access={bash}
                audience={audience}
                onScopeChange={setBashAccess}
                onRulesChange={rules => onChange({ ...policy, bashScope: 'listed', bashRules: rules })}
              />
            )}
          </div>
        )
      })}

      {skills && (
        <div className="space-y-2 border-t border-border/40 pt-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('Skills')}</span>
            <HelpHint
              label={t('More about this group')}
              text={t('Only the skills turned on here can be used. A skill can read its own folder; everything else it does, such as running commands, changing files or sending email, still needs the switches on this page. A skill that pre-approves more than they allow will not run.')}
            />
          </div>
          {skills.length === 0 && (
            <p className="text-xs text-muted-foreground/70">{t('This digital human has no skills yet.')}</p>
          )}
          {skills.map(skill => (
            <label key={skill.dirName} className={`${TOGGLE_ROW} cursor-pointer`}>
              <span className="min-w-0">
                <span className={`block truncate ${TOGGLE_TITLE}`}>{skill.name}</span>
                {skill.description && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
                )}
              </span>
              <Switch
                size="sm"
                checked={allowsSkill(policy, skill.dirName, mode)}
                onCheckedChange={next => setSkill(skill.dirName, next)}
              />
            </label>
          ))}
        </div>
      )}

      <div className="space-y-0.5 border-t border-border/40 pt-3">
        {CAPABILITY_MCP_TOGGLES.map(({ key, label }) => {
          // A terminal runs whatever is typed into it, so a command whitelist
          // cannot reach it. Rather than let the switch be turned on and quietly
          // do nothing, say why it is unavailable.
          const blockedByCommands = key === 'allowTerminal' && bash.scope !== 'full'
          return (
            <label
              key={key}
              className={`${TOGGLE_ROW} ${blockedByCommands ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span className={`min-w-0 ${TOGGLE_TITLE}`}>
                {t(label)}
                {blockedByCommands && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
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
          <label key={row.key} className={`${TOGGLE_ROW} cursor-pointer`}>
            <span className={TOGGLE_TITLE}>{row.label}</span>
            <Switch size="sm" checked={row.checked} onCheckedChange={row.onToggle} />
          </label>
        ))}
      </div>

      {mcpApps.length > 0 && (
        <div className="space-y-0.5 border-t border-border/40 pt-3">
          <p className="text-xs text-muted-foreground">{t('MCP servers you installed')}</p>
          {mcpApps.map(app => (
            <label key={app.specId} className={`${TOGGLE_ROW} cursor-pointer`}>
              <span className={`truncate ${TOGGLE_TITLE}`}>{app.spec.name}</span>
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
