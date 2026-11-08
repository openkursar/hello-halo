/**
 * Create or edit a load-balancing group. Validation is the shared one the main
 * process enforces; a refusal that still comes back is worded here from its code.
 */

import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Loader2, Plus, X } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { Disclosure } from '../ui/Disclosure'
import type { AIGroup, AIGroupMember, AIGroupStrategy, AISourcesConfig } from '../../types'
import {
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_LENGTH,
  groupMemberKey,
  isSourceGroupEligible,
  validateGroupInput,
  type GroupIssue,
} from '../../../shared/ai-groups'
import type { AIGroupChange } from '../../../shared/rpc/contracts/ai-groups.contract'
import { GroupModelPicker } from './GroupModelPicker'
import { MemberName } from './group-parts'
import {
  appendMembers,
  draftOfGroup,
  fillCurrentModels,
  groupCapabilityNotes,
  moveMember,
  newGroupDraft,
  removeMemberAt,
  type GroupDraft,
} from './group-editor-model'
import { describeCapabilityNote, describeGroupIssue, describeMemberProblem, describeSkip, memberLine, memberNames } from './group-text'

interface GroupEditorProps {
  aiSources: AISourcesConfig
  /** The group being edited; absent when creating one. */
  group?: AIGroup
  onSaved: (change: AIGroupChange) => void
  onCancel: () => void
  /** For someone with no account yet: the way to add one. */
  onAddProvider: () => void
}

interface EditorProblem {
  code?: string
  memberIndex?: number
}

const NAME_ISSUES: ReadonlyArray<GroupIssue['code']> = ['name-empty', 'name-too-long', 'name-duplicate']

const fieldClass = 'w-full rounded-lg border border-border bg-input px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30'
const secondaryButton = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9'
const iconButton = 'flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent sm:h-8 sm:w-8'

/** The order of use as a small picture: the first is tried, the next takes over. */
function HowItWorks() {
  const { t } = useTranslation()
  const steps = [t('Used first'), t('Takes over if it cannot answer'), t('And then this one, if needed')]
  return (
    <div className="space-y-3 text-sm text-muted-foreground">
      <ol className="space-y-0" aria-hidden="true">
        {steps.map((step, index) => (
          <li key={step} className="flex items-stretch gap-3">
            <span className="flex flex-col items-center">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-medium text-foreground">{index + 1}</span>
              {index < steps.length - 1 && <span className="w-px flex-1 bg-border" />}
            </span>
            <span className={`text-xs ${index < steps.length - 1 ? 'pb-3' : ''}`}>{step}</span>
          </li>
        ))}
      </ol>
      <p>{t('Halo checks the other models again on later requests, but it does not interrupt a conversation that is going well just because your first choice is back.')}</p>
    </div>
  )
}

export function GroupEditor({ aiSources, group, onSaved, onCancel, onAddProvider }: GroupEditorProps) {
  const { t } = useTranslation()
  const sources = aiSources.sources
  const groups = aiSources.groups ?? []

  const [draft, setDraft] = useState<GroupDraft>(() => group ? draftOfGroup(group) : newGroupDraft(groups, t('Model group')))
  const [picking, setPicking] = useState(false)
  const [fillNote, setFillNote] = useState<{ kind: 'skipped'; lines: string[] } | { kind: 'nothing-new' } | null>(null)
  const [problem, setProblem] = useState<EditorProblem | null>(null)
  const [saving, setSaving] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const hasUsableAccount = sources.some(isSourceGroupEligible)
  const taken = useMemo(() => new Set(draft.members.map(groupMemberKey)), [draft.members])
  const notes = useMemo(() => groupCapabilityNotes(draft.members, sources), [draft.members, sources])
  const label = (member: AIGroupMember) => memberLine(sources.find(source => source.id === member.sourceId), member.modelId, t)
  const room = MAX_GROUP_MEMBERS - draft.members.length

  const change = (next: GroupDraft) => {
    setDraft(next)
    setProblem(null)
  }

  const fillFromCurrent = () => {
    const filled = fillCurrentModels(draft, sources, aiSources.currentId)
    change(filled.draft)
    setPicking(false)
    if (filled.skipped.length > 0) {
      setFillNote({ kind: 'skipped', lines: filled.skipped.map(item => describeSkip(item.reason, item.name, t)) })
    } else {
      setFillNote(filled.added ? null : { kind: 'nothing-new' })
    }
  }

  const save = async () => {
    if (saving) return
    const checked = validateGroupInput(draft, sources, groups, group)
    if (!checked.ok) {
      setProblem({ code: checked.issue.code, memberIndex: checked.issue.memberIndex })
      return
    }
    setSaving(true)
    setProblem(null)
    try {
      const input = { name: checked.value.name, strategy: checked.value.strategy, members: checked.value.members }
      const response = group ? await api.aiGroupsUpdate(group.id, input) : await api.aiGroupsCreate(input)
      if (response.success && response.data) {
        onSaved(response.data)
        return
      }
      setProblem({ code: response.code ?? 'unknown', memberIndex: response.memberIndex })
    } catch (error) {
      console.error('[GroupEditor] Could not save the group:', error instanceof Error ? error.message : error)
      setProblem({ code: 'unknown' })
    } finally {
      setSaving(false)
    }
  }

  const nameProblem = problem && NAME_ISSUES.includes(problem.code as GroupIssue['code']) ? problem : null
  const listProblem = problem && !nameProblem ? problem : null
  const problemMember = listProblem?.memberIndex !== undefined ? draft.members[listProblem.memberIndex] : undefined
  const strategies: Array<{ value: AIGroupStrategy; title: string; hint: string }> = [
    { value: 'priority', title: t('Use in order'), hint: t('Models at the top are used first.') },
    { value: 'spread', title: t('Spread across accounts'), hint: t('Different new chats start on different accounts to share usage. A chat stays on its model while it works.') },
  ]

  return (
    <form
      className="space-y-5"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="space-y-2">
        <p className="text-sm text-foreground">
          {t('Combine several accounts and models. When quota runs out or a service fails, Halo automatically tries another model.')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('Halo only uses the models you add. Switching can change answers and cost, and your conversation goes to the provider that is actually used.')}
        </p>
        <Disclosure title={t('How it works')} contentClassName="mt-3 space-y-3">
          <HowItWorks />
        </Disclosure>
      </div>

      {!hasUsableAccount && draft.members.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-border bg-secondary/30 p-4">
          <p className="text-sm text-foreground">{t('Add an AI provider first. A group is made of models from your accounts.')}</p>
          <button type="button" onClick={onAddProvider} className={secondaryButton}>
            <Plus size={14} />
            {t('Add AI Provider')}
          </button>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="group-name" className="mb-1 block text-sm font-medium text-muted-foreground">{t('Name')}</label>
            <input
              id="group-name"
              type="text"
              value={draft.name}
              maxLength={MAX_GROUP_NAME_LENGTH}
              onChange={event => change({ ...draft, name: event.target.value })}
              placeholder={t('For example: Daily work')}
              aria-invalid={nameProblem ? true : undefined}
              className={fieldClass}
            />
            {nameProblem && <p role="alert" className="mt-1 text-xs text-destructive">{describeGroupIssue(nameProblem.code, t)}</p>}
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-muted-foreground">{t('Models')}</span>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setPicking(open => !open)} disabled={room <= 0 && !picking} aria-expanded={picking} className={secondaryButton}>
                  <Plus size={14} />
                  {t('Add model')}
                </button>
                <button
                  type="button"
                  onClick={fillFromCurrent}
                  disabled={room <= 0}
                  title={t('Adds the currently selected model from each account.')}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
                >
                  {t('Quick add from accounts')}
                </button>
              </div>
            </div>

            {picking && (
              <GroupModelPicker
                sources={sources}
                taken={taken}
                room={room}
                onAdd={members => {
                  change(appendMembers(draft, members))
                  setFillNote(null)
                  setPicking(false)
                }}
                onClose={() => setPicking(false)}
              />
            )}

            {/* Mounted before it has anything to say, so a screen reader announces what appears in it. */}
            <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {fillNote?.kind === 'nothing-new' && <p>{t('Every account’s current model is already in the group.')}</p>}
              {fillNote?.kind === 'skipped' && (
                <>
                  <p>{t('Not added:')}</p>
                  <ul className="list-disc pl-4">
                    {fillNote.lines.map(line => <li key={line}>{line}</li>)}
                  </ul>
                </>
              )}
            </div>

            {draft.members.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                {t('No models yet. Add the ones Halo may use.')}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {draft.members.map((member, index) => {
                  const named = memberNames(sources.find(item => item.id === member.sourceId), member.modelId, t)
                  const line = `${named.account} / ${named.model}`
                  return (
                    <li
                      key={groupMemberKey(member)}
                      draggable
                      onDragStart={event => {
                        event.dataTransfer.effectAllowed = 'move'
                        setDragFrom(index)
                      }}
                      onDragOver={event => {
                        if (dragFrom === null) return
                        event.preventDefault()
                        setDragOver(index)
                      }}
                      onDrop={event => {
                        event.preventDefault()
                        if (dragFrom !== null) change(moveMember(draft, dragFrom, index))
                        setDragFrom(null)
                        setDragOver(null)
                      }}
                      onDragEnd={() => {
                        setDragFrom(null)
                        setDragOver(null)
                      }}
                      className={`flex items-center gap-1.5 rounded-lg border bg-card py-1.5 pl-2 pr-1 transition-colors ${
                        dragOver === index && dragFrom !== index ? 'border-primary' : listProblem?.memberIndex === index ? 'border-destructive' : 'border-border'
                      } ${dragFrom === index ? 'opacity-50' : ''}`}
                    >
                      <GripVertical aria-hidden className="hidden h-4 w-4 shrink-0 cursor-grab text-subtle-foreground sm:block" />
                      <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <MemberName account={named.account} model={named.model} />
                        {named.problem && <span className="block text-xs text-halo-warning">{describeMemberProblem(named.problem, t)}</span>}
                      </div>
                      <button type="button" className={iconButton} disabled={index === 0} onClick={() => change(moveMember(draft, index, index - 1))} aria-label={t('Move {{model}} up', { model: line })} title={t('Move up')}>
                        <ArrowUp size={14} />
                      </button>
                      <button type="button" className={iconButton} disabled={index === draft.members.length - 1} onClick={() => change(moveMember(draft, index, index + 1))} aria-label={t('Move {{model}} down', { model: line })} title={t('Move down')}>
                        <ArrowDown size={14} />
                      </button>
                      <button type="button" className={iconButton} onClick={() => change(removeMemberAt(draft, index))} aria-label={t('Remove {{model}}', { model: line })} title={t('Remove')}>
                        <X size={14} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            {listProblem && (
              <p role="alert" className="text-xs text-destructive">
                {describeGroupIssue(listProblem.code, t, problemMember ? label(problemMember) : undefined)}
              </p>
            )}

            {draft.members.length === 1 && (
              <p className="text-xs text-muted-foreground">{t('Add another model so Halo can switch when this one is unavailable.')}</p>
            )}
            {draft.members.length > 1 && (
              <p className="text-xs text-muted-foreground">{t('Models higher in the list are used first. If one is unavailable, Halo tries the next.')}</p>
            )}

            {notes.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-halo-warning/10 p-3 text-xs text-halo-warning">
                {notes.map(note => <li key={note.kind}>{describeCapabilityNote(note, t, label)}</li>)}
              </ul>
            )}
          </div>

          <Disclosure title={t('More settings')} contentClassName="mt-3 space-y-2">
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-muted-foreground">{t('How Halo chooses')}</legend>
              {strategies.map(option => (
                <label key={option.value} className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 sm:min-h-0">
                  <input
                    type="radio"
                    name="group-strategy"
                    value={option.value}
                    checked={draft.strategy === option.value}
                    onChange={() => change({ ...draft, strategy: option.value })}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">{option.title}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </Disclosure>

          {group && (
            <p className="text-xs text-muted-foreground">
              {t('Changes apply to every chat and digital human that uses this group, starting with its next request.')}
            </p>
          )}
        </>
      )}

      <div className="flex flex-col gap-3 pt-1 sm:flex-row">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg bg-secondary px-4 py-2 text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
        >
          {t('Cancel')}
        </button>
        <button
          type="submit"
          disabled={saving || (!hasUsableAccount && draft.members.length === 0)}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {group ? t('Save') : t('Create')}
        </button>
      </div>
    </form>
  )
}
