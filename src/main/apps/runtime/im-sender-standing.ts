/**
 * A sender's standing under a channel instance's settings as they are now —
 * for an inbound message, and for a reminder that comes due long after the
 * person asked for it. One rule, so the two can never read the same person
 * differently.
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
