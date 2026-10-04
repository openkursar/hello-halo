/**
 * The one way a surface adds a card to the composer beside the canvas, so the
 * feedback is the same wherever the selection was made.
 */

import i18n from '../../i18n'
import { useNotificationStore } from '../../stores/notification.store'
import { useComposerReferencesStore, type ReferenceDraft, type ReferenceTarget } from '../../stores/composer-references.store'
import { REFERENCE_LIMITS } from '../../../shared/types/content-reference'

const ADDED_NOTICE_ID = 'composer-reference-added'
const LIMIT_NOTICE_ID = 'composer-reference-limit'

/**
 * Adds `draft` as a card. False when nothing was added: no composer sits
 * beside this page, or the message already carries the most references one
 * may. With the composer on screen its counts bump (and with `focusComposer`
 * it takes the caret); out of sight, a notice names the conversation and
 * offers to go back to it.
 */
export function addReference(draft: ReferenceDraft, options: { focusComposer?: boolean } = {}): boolean {
  const store = useComposerReferencesStore.getState()
  const target = store.target
  if (!target) return false

  const { added, refused } = store.add(target.key, [draft])
  if (added.length === 0) {
    if (refused === 'limit') notifyReferenceLimit()
    return false
  }

  if (target.visible) store.signalComposer(target.key, options.focusComposer ? 'text' : 'none')
  else notifyAddedOutOfSight(target, !!added[0].note)
  return true
}

function notifyAddedOutOfSight(target: ReferenceTarget, isComment: boolean): void {
  const title = isComment
    ? target.title
      ? i18n.t('Comment added to “{{title}}”', { title: target.title })
      : i18n.t('Comment added to the new conversation')
    : target.title
      ? i18n.t('Added to “{{title}}”', { title: target.title })
      : i18n.t('Added to the new conversation')
  useNotificationStore.getState().show({
    id: ADDED_NOTICE_ID,
    title,
    variant: 'default',
    duration: 4000,
    action: {
      label: i18n.t('Return to conversation'),
      onClick: () => {
        target.reveal()
        useComposerReferencesStore.getState().signalComposer(target.key, 'text')
      },
    },
  })
}

export function notifyReferenceLimit(): void {
  useNotificationStore.getState().show({
    id: LIMIT_NOTICE_ID,
    title: i18n.t('You can add up to {{count}} references to a message', { count: REFERENCE_LIMITS.maxPerMessage }),
    variant: 'warning',
    duration: 4000,
  })
}
