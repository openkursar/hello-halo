/** Shared, engine-independent admission; each caller owns its gate instance. */
export { createTurnGate, TurnGateCapacityError } from '@hello-halo/agent-sdk/collaboration/turn-gate'
export type {
  BusyDisposition,
  DeliverDisposition,
  TurnGate,
  TurnGateHooks,
  TurnGateOptions,
} from '@hello-halo/agent-sdk/collaboration/turn-gate'
