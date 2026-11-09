export type TeamRequestOrigin = 'colleague' | 'guest'
export type CollabMode = 'structured' | 'free'

export interface TeamEnvelope {
  id: string
  teamId: string
  epochId: string
  /** Null when a person wrote it: no digital human is behind the message. */
  fromAppId: string | null
  toAppId: string
  body: string
  requestId?: string
  recipientFence?: string
  correlationId: string
  taskRef?: string
  createdAt: number
}

/** Per-turn context injected by the Bus when waking a member. Transparent to the LLM. */
export interface TeamTriggerContext {
  controller?: { appId: string; origin?: TeamRequestOrigin }
  teamId: string
  epochId: string
  requestId?: string
  recipientFence?: string
  correlationId: string
  /**
   * The teammate this turn came from. Null when no digital human is behind it:
   * a run start, a person's message or a self-wake. The office record and the
   * circuit budget both key on it.
   */
  fromAppId: string | null
  /**
   * Someone is holding a completion receipt for this turn. Only a non-agent
   * caller sets it (a person's cross-machine 1:1 chat); it changes nothing about
   * how the turn runs or what the member is told.
   */
  wait: boolean
  taskId?: string
  /**
   * Drives inbound header rendering. 'periodic_check', 'human_message' and
   * 'member_stopped' are delivered verbatim — the first and last carry their own
   * header, and the middle one is a person's words, which no teammate framing
   * may impersonate.
   */
  kind?: 'run_start' | 'message' | 'periodic_check' | 'human_message' | 'member_stopped'
  /**
   * Position of this turn in the chain that caused it; the circuit breaker's
   * `maxForwardDepth` counts it. Must travel with the trigger — a chain that
   * restarts at 0 on every hop never reaches the limit.
   */
  forwardDepth?: number
  /**
   * Who set THIS turn in motion, when it was not the owner's own machine — read
   * per turn, never remembered for the next one. It decides what the turn may
   * do (`app-chat`) and is the only thing that does.
   *
   * Stamped where a request crosses into this node — an inbound office wake, the
   * office-credential 1:1 endpoint, a guest's IM message. From there it travels
   * only on what a RESTRICTED turn itself sets in motion: the checks it sets,
   * the question it asks, and — a guest's only — its `team_send`s. A turn
   * running with the owner's full reach hands nothing on, and neither does any
   * other runtime wake — except the notice reporting a guest's turn, for that
   * one wake.
   *
   * A value arriving on the wire is the sender's claim: it is honored only when
   * it narrows ('guest'), and otherwise replaced by 'colleague'. An older
   * build's `external` mark is read through {@link legacyExternalOrigin}.
   */
  origin?: TeamRequestOrigin
  /**
   * The facts a turn-end notice reports, sent with the notice to a lead on
   * another machine so that machine renders the notice itself. A notice is the
   * runtime's own report, not anyone's request, so it carries no colleague's
   * standing — which only holds while its words are the runtime's: a notice
   * arriving without readable facts is handled as any other message from that
   * machine.
   */
  turnEnded?: TeamTurnEndReport
  /**
   * A person's own 1:1 chat that crossed from another machine. Its `kind` is
   * normalized to 'message' on arrival (the peer wrote it, so it buys no
   * verbatim framing or owner reading); this only keeps the turn out of the
   * lead's turn reports, as the same chat on one machine is. Reporting only.
   */
  personalChat?: boolean
}

/**
 * How a member's turn ended, in the only vocabulary the system can prove. There
 * is deliberately no `completed`: nothing here can see whether the work is done.
 */
export type MemberTurnFate =
  | { kind: 'ended' }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  /** The wake never became a turn — so nothing about the member was observed. */
  | { kind: 'never_ran'; reason: string }
  /**
   * A person stopped it by hand (the renderer/HTTP stop action) — never a
   * failure to chase. Distinct from `error`: a hard stop lands in the same
   * unconditional-reject path a crash does, so without this the lead would
   * be sent after a teammate that was deliberately interrupted.
   */
  | { kind: 'stopped' }

/** One member's ending, as a turn-end notice reports it (see `team/turn-report.ts`). */
export interface TeamTurnEnding {
  memberName: string
  fate: MemberTurnFate
  /**
   * What the member filed during the turn; null when the turn was not watched
   * end to end — "recorded nothing" and "not observed" are different claims.
   */
  did: string[] | null
  requestSummary?: string
  finalReply?: string
}

export interface TeamTurnEndReport {
  endings: TeamTurnEnding[]
  /** Endings dropped from a notice that grew too long, counted rather than lost. */
  dropped: number
}

export interface TeamSendAsyncResult {
  messageId: string
  /**
   * What happened to the send. Nothing is ever auto-delivered back, so this
   * receipt is all the sender learns:
   *   - 'undelivered' the target's owner was offline/unreachable at send time.
   *                   There is no offline outbox, so it will NOT arrive later.
   *   - 'queued'      the target is mid-turn and the message waits in its
   *                   mailbox, to be read after that turn ends.
   *                   Only knowable for a locally-owned target — a remote one
   *                   queues on its OWNER, so it reads as a plain hand-over.
   *   - 'mid_turn'    the target is mid-turn and the message went INTO that
   *                   turn: they see it at their next step rather than after
   *                   finishing. Nothing was interrupted, and no turn started
   *                   for this message, so any answer still comes as their own
   *                   `team_send`.
   * Absent → handed over to the target's session now.
   */
  delivery?: 'undelivered' | 'queued' | 'mid_turn'
  /**
   * The target runs on another machine, so nothing here can say it actually
   * started: the message was accepted for its owner's machine, and whether that
   * machine woke the member is only knowable there. Callers must not report a
   * remote hand-over as "delivered" — a lead told that waited 75 minutes on a
   * member that never ran, with no way to tell waiting from never-arrived.
   */
  remoteTarget?: boolean
}
/**
 * Receipt for a send that waited on the woken turn's ending. Not reachable from
 * `team_send` — only a person's cross-machine 1:1 chat asks for one, so its UI
 * can distinguish "sent" from "never arrived".
 */
export interface TeamSendSyncResult {
  from: string
  message: string
  /**
   * Delivery truth, so a non-delivery is never mistaken for a real (empty) reply:
   *   - 'ok'          the turn ran and reported back (message may still be empty).
   *   - 'queued'      the target was mid-turn; the message is in its mailbox and
   *                   will be delivered when that turn ends. Nothing failed, and
   *                   no reply is coming on THIS call — the completion that would
   *                   answer it belongs to a turn this message did not start.
   *   - 'mid_turn'    the target was mid-turn and the message went into that
   *                   turn, so they are reading it now. Like 'queued' it starts
   *                   no turn of its own, hence no reply on THIS call.
   *   - 'timeout'     it was reachable but did not finish within the wait window.
   *   - 'undelivered' the wake never reached the owner (offline/unreachable) or no
   *                   completion signal ever came back — definitively NOT a reply.
   * This is the seam the durable feed outbox later feeds (delivered/pending/failed).
   */
  status: 'ok' | 'queued' | 'mid_turn' | 'timeout' | 'undelivered'
}

export const TEAM_CIRCUIT_DEFAULTS = {
  maxMessages: 2000,
  maxForwardDepth: 999,
} as const

export function toActivitySubject(text: string, max = TEAM_ACTIVITY_SUBJECT_MAX): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ')
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

export const TEAM_ACTIVITY_SUBJECT_MAX = 80



export { SELF_NODE_ID, TEAM_LEAD_ADDRESS, teamMemberAddress, buildTeamSessionKey, isTeamSessionKey, parseTeamSessionKey, spaceCoordinatorAppId, parseSpaceCoordinatorAppId, isRemoteMember } from './addressing.js';
