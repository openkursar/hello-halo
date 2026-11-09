/**
 * A load-balancing group in the provider list. It opens like an account's card;
 * how its models are doing shows only once it is opened.
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronRight, Edit2, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import type { AIGroup, AISource } from '../../types'
import { groupMemberKey } from '../../../shared/ai-groups'
import type { GroupHealth } from '../../../shared/types/ai-groups-runtime'
import { AutoTag, GroupIcon, MemberName } from './group-parts'
import { describeMemberProblem, describeRest, memberNames } from './group-text'

interface GroupCardProps {
  group: AIGroup
  sources: readonly AISource[]
  /** Chosen for new chats. */
  chosen: boolean
  expanded: boolean
  onToggle: () => void
  onChoose: () => void
  onEdit: () => void
  onDelete: () => void
}

/** How the group's models stand, read when the card opens and after "try again". */
function useGroupHealth(groupId: string, open: boolean): { health: GroupHealth | null; reload: () => void } {
  const [health, setHealth] = useState<GroupHealth | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(value => value + 1), [])

  useEffect(() => {
    if (!open) return
    let current = true
    api.aiGroupsHealth(groupId)
      .then(response => { if (current) setHealth(response.success && response.data ? response.data : null) })
      .catch(error => {
        console.warn('[GroupCard] Could not read how the models stand:', error instanceof Error ? error.message : error)
        if (current) setHealth(null)
      })
    return () => { current = false }
  }, [groupId, open, revision])

  return { health, reload }
}

export function GroupCard({ group, sources, chosen, expanded, onToggle, onChoose, onEdit, onDelete }: GroupCardProps) {
  const { t } = useTranslation()
  const { health, reload } = useGroupHealth(group.id, expanded)
  const accountCount = new Set(group.members.map(member => member.sourceId)).size
  const language = getCurrentLanguage()
  const now = Date.now()

  const tryAgain = async (memberKey: string) => {
    try {
      await api.aiGroupsReleaseRest(group.id, memberKey)
    } catch (error) {
      console.warn('[GroupCard] Could not release a resting model:', error instanceof Error ? error.message : error)
    }
    reload()
  }

  return (
    <div className={`rounded-lg border transition-colors ${chosen ? 'border-primary/50 bg-primary/[0.04] theme-dark:bg-primary/10' : 'border-border bg-card'}`}>
      <div className="flex cursor-pointer items-center gap-3 p-3" onClick={onToggle}>
        <button
          type="button"
          role="radio"
          aria-checked={chosen}
          aria-disabled={group.members.length === 0 || undefined}
          aria-label={t('Use {{name}} for new chats', { name: group.name })}
          onClick={event => {
            event.stopPropagation()
            if (!chosen && group.members.length > 0) onChoose()
          }}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
            chosen ? 'border-primary bg-primary' : group.members.length === 0 ? 'border-border opacity-50' : 'border-border hover:border-primary'
          }`}
        >
          {chosen && <Check size={12} className="text-primary-foreground" />}
        </button>

        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <GroupIcon size={18} className="text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground">{group.name}</span>
            <AutoTag />
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {t('{{count}} accounts', { count: accountCount })} · {t('{{count}} models', { count: group.members.length })}
          </div>
        </div>

        <ChevronRight size={18} aria-hidden className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border px-3 pb-3 pt-3">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">{t('Models, in the order they are used')}</p>
            <ol className="space-y-2">
              {group.members.map((member, index) => {
                const named = memberNames(sources.find(item => item.id === member.sourceId), member.modelId, t)
                const key = groupMemberKey(member)
                const standing = health?.members.find(item => item.sourceId === member.sourceId && item.modelId === member.modelId)
                const rest = standing ? describeRest(standing, now, language, t) : null
                return (
                  <li key={key} className="flex items-start gap-2.5">
                    <span className="w-5 shrink-0 pt-0.5 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <MemberName account={named.account} model={named.model} />
                      {named.problem && <p className="mt-0.5 text-xs text-halo-warning">{describeMemberProblem(named.problem, t)}</p>}
                      {rest && <p className="mt-0.5 text-xs text-halo-warning">{rest}</p>}
                    </div>
                    {standing?.state === 'resting' && (
                      <button type="button" onClick={() => void tryAgain(key)} className="-my-2 shrink-0 px-1 py-2 text-xs text-primary hover:underline">
                        {t('Try again now')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ol>
            {group.members.length === 0 && (
              <p className="text-xs text-halo-warning">{t('This group has no models left. Edit it to add some before using it.')}</p>
            )}
            {group.members.length === 1 && (
              <p className="mt-2 text-xs text-muted-foreground">{t('No backup yet. Add another model so Halo can switch when this one is unavailable.')}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="flex min-h-11 items-center gap-1 rounded-md bg-secondary px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-surface-hover sm:min-h-0"
            >
              <Edit2 size={14} />
              {t('Edit')}
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="flex min-h-11 items-center gap-1 rounded-md bg-red-500/10 px-3 py-1.5 text-sm text-red-500 transition-colors hover:bg-red-500/20 sm:min-h-0"
            >
              <Trash2 size={14} />
              {t('Delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
