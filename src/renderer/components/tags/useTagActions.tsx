/**
 * Rename and delete for one list's tags, with the confirmation a delete
 * needs. Render `DialogComponent` where the list is.
 */

import { api } from '../../api'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useTranslation } from '../../i18n'
import { useNotificationStore } from '../../stores/notification.store'
import type { TaggableAppType } from '../../../shared/apps/app-tags'

/** The error notice a failed tag change shows, like the other list actions. */
export function notifyTagError(title: string, detail?: string): void {
  useNotificationStore.getState().show({ title, body: detail, variant: 'error', duration: 6000 })
}

export function useTagActions(type: TaggableAppType, onChanged: () => void | Promise<void>) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent } = useConfirmDialog()

  const run = async (from: string, to: string | null) => {
    const title = to ? t('Could not rename the tag') : t('Could not delete the tag')
    try {
      const result = await api.appRenameTag({ type, from, to })
      if (!result.success) {
        notifyTagError(title, result.error)
        return false
      }
      await onChanged()
      return true
    } catch (error) {
      console.warn('[Tags] Tag change failed', { type, error })
      notifyTagError(title, error instanceof Error ? error.message : undefined)
      return false
    }
  }

  const rename = (from: string, to: string) => run(from, to)

  const remove = async (tag: string, count: number) => {
    const confirmed = await showConfirm({
      title: t('Delete the tag "{{tag}}"?', { tag }),
      message: t('It is removed from {{count}} items. Nothing else about them changes.', { count }),
      confirmLabel: t('Delete tag'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    return confirmed ? run(tag, null) : false
  }

  return { rename, remove, DialogComponent }
}
