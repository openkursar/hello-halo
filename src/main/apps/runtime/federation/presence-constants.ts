/**
 * apps/runtime/federation -- Presence debounce constants
 *
 * Two-threshold reachability FSM tuning for the LAN default deployment
 * (RTT < 50ms). The relationship heartbeat < suspect < confirmed is the load-
 * bearing invariant: a suspect buffer window of [suspect, confirmed) absorbs TCP
 * jitter / GC pauses / lid-close blips so only sustained silence acts. confirmed
 * is the SINGLE source for member reassign + (later) authority election and must
 * stay in the 12–15s band, since election timing is pinned to this value.
 *
 * Higher-latency / cross-segment P2P deployments should scale the whole tier up
 * while keeping confirmed ≈ 6 × heartbeat (a deployment knob, not hard-coded).
 */

/** Period of each node's presence beacon broadcast. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 2000

/** Silence since last heartbeat that flips online → suspect (≈3 missed beats). */
export const PRESENCE_SUSPECT_AFTER_MS = 6000

/** Silence since last heartbeat that flips suspect → confirmed-offline (≈6–7 beats). */
export const PRESENCE_CONFIRMED_OFFLINE_MS = 13_000

/** Heartbeats in suspect needed to recover to online — asymmetric hysteresis. */
export const PRESENCE_RECOVERY_HEARTBEATS = 1
