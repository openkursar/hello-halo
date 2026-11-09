import { createMessageBus as createSharedMessageBus } from '@hello-halo/agent-sdk/collaboration'
import type { MessageBusDeps, MessageBus } from '@hello-halo/agent-sdk/collaboration'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { TEAM_EVENTS } from '../../../../shared/apps/team-types'

export {
  TeamBusError, TopologyError, UnknownMemberError, CircuitBreakerError, isPersonsOwnDelivery,
} from '@hello-halo/agent-sdk/collaboration'
export type {
  CoordinatorDisposition, TeamDeliveryHooks, TurnCompletion, CircuitBreachReason,
  CircuitLimits, EpochStats, CircuitBreachEvent, SendInput, BusyDisposition,
  WakeDisposition, MessageBus, MessageBusDeps, TeamDelivery, TeamMessageEvent,
} from '@hello-halo/agent-sdk/collaboration'

/** Halo supplies transport notifications; admission and delivery semantics are shared. */
export function createMessageBus(deps: MessageBusDeps): MessageBus {
  return createSharedMessageBus({
    ...deps,
    onMessage: (payload) => {
      broadcastToAll(TEAM_EVENTS.message, payload)
      sendToRenderer(TEAM_EVENTS.message, payload)
      deps.onMessage?.(payload)
    },
  })
}
