/**
 * The groups in the provider list, and the question asked before one is deleted;
 * kept apart so the list itself only learns that groups exist.
 */

import type { AnimationEvent, ReactNode } from 'react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import type { AISourcesConfig } from '../../types'
import { GroupCard } from './GroupCard'

interface GroupCardsProps {
  aiSources: AISourcesConfig
  /** The group chosen for new chats, if it still exists. */
  chosenGroupId: string | null
  expandedGroupId: string | null
  editingGroupId?: string | null
  editor?: ReactNode
  busy?: boolean
  highlightedGroupId?: string | null
  onHighlightEnd?: (event: AnimationEvent<HTMLDivElement>) => void
  onToggle: (groupId: string) => void
  onChoose: (groupId: string) => void
  onEdit: (groupId: string) => void
  /** The configuration after a group was deleted. */
  onDeleted: (aiSources: AISourcesConfig, groupId: string) => void
  onError: (message: string) => void
}

export function GroupCards({ aiSources, chosenGroupId, expandedGroupId, editingGroupId, editor, busy, highlightedGroupId, onHighlightEnd, onToggle, onChoose, onEdit, onDeleted, onError }: GroupCardsProps) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent } = useConfirmDialog()

  const remove = async (groupId: string, name: string) => {
    if (busy) return
    const confirmed = await showConfirm({
      title: t('Delete this group?'),
      message: t('The accounts in it stay as they are. Chats and digital humans that use “{{name}}” will use your default model instead.', { name }),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (!confirmed) return
    try {
      const result = await api.aiGroupsDelete(groupId)
      if (result.success && result.data) {
        onDeleted(result.data.aiSources, groupId)
        return
      }
      console.warn(`[GroupCards] Could not delete group=${groupId} code=${result.code ?? 'unknown'}`)
      onError(result.error || t('The group could not be deleted. Please try again.'))
    } catch (error) {
      console.warn(`[GroupCards] Could not delete group=${groupId}:`, error instanceof Error ? error.message : error)
      onError(t('The group could not be deleted. Please try again.'))
    }
  }

  return (
    <>
      {(aiSources.groups ?? []).map(group => (
        <GroupCard
          key={group.id}
          group={group}
          sources={aiSources.sources}
          chosen={group.id === chosenGroupId}
          expanded={expandedGroupId === group.id}
          editor={editingGroupId === group.id ? editor : undefined}
          busy={busy}
          highlighted={highlightedGroupId === group.id}
          onHighlightEnd={onHighlightEnd}
          onToggle={() => onToggle(group.id)}
          onChoose={() => onChoose(group.id)}
          onEdit={() => onEdit(group.id)}
          onDelete={() => { void remove(group.id, group.name) }}
        />
      ))}
      {DialogComponent}
    </>
  )
}
