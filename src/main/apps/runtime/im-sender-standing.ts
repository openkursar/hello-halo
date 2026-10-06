/**
 * A sender's standing, and which chats a channel instance takes, under the
 * instance's settings as they are now — for an inbound message, and for a
 * reminder that comes due long after the person asked for it. One rule each,
 * so the two can never read the same person or chat differently.
 *
 *   permissionEnabled=false            → everyone is owner (personal use default)
 *   permissionEnabled=true, owners=[]  → everyone is guest, deny-all
 *   permissionEnabled=true, owners=[…] → only listed IDs are owners; others are guests
 */

import type { ImChannelInstanceConfig } from '../../../shared/types/im-channel'
import type { ImPermissionContext } from './im-permission-registry'

export function resolveImPermission(
  instanceConfig: Pick<ImChannelInstanceConfig, 'permissionEnabled' | 'owners' | 'guestPolicy'> | undefined,
  senderId: string,
  senderName: string
): ImPermissionContext {
  const permissionEnabled = instanceConfig?.permissionEnabled ?? false
  const owners = permissionEnabled ? instanceConfig?.owners : undefined
  const hasOwnerRestriction = Array.isArray(owners) && owners.length > 0
  return {
    senderId,
    senderName,
    isOwner: !permissionEnabled || (hasOwnerRestriction && owners!.includes(senderId)),
    guestPolicy: permissionEnabled ? instanceConfig?.guestPolicy : undefined,
    ownerIds: hasOwnerRestriction ? owners! : undefined,
  }
}

type ChatSettings = Pick<ImChannelInstanceConfig, 'permissionEnabled' | 'owners' | 'replyScope'> | undefined

/** Permission control is on and no owner is bound yet: everyone is a guest who may do nothing. */
export function isOwnerUnbound(instanceConfig: ChatSettings): boolean {
  return instanceConfig?.permissionEnabled === true &&
    (!Array.isArray(instanceConfig.owners) || instanceConfig.owners.length === 0)
}

/** Whether the reply scope covers chats of this type; an instance from before the setting covers all. */
export function replyScopeCovers(instanceConfig: ChatSettings, chatType: 'direct' | 'group'): boolean {
  const scope = instanceConfig?.replyScope ?? 'all'
  return scope === 'all' || scope === chatType
}

/**
 * Whether the instance takes a turn in a chat that no new message started — a
 * reminder coming due. Refused wherever an inbound message of that chat type
 * is refused before its sender counts: outside the reply scope, and in a group
 * while no owner is bound. A private chat with no owner bound is taken, as a
 * message there is; its sender is a guest until someone claims the instance.
 */
export function instanceTakesChat(instanceConfig: ChatSettings, chatType: 'direct' | 'group'): boolean {
  if (chatType === 'group' && isOwnerUnbound(instanceConfig)) return false
  return replyScopeCovers(instanceConfig, chatType)
}
