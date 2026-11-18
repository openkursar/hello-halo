/**
 * Contracts of an agent execution.
 *
 * An entry (an automation run, a digital human's chat or IM turn, a team member's
 * turn) describes who the work is done for, who asked, and where the
 * collaborators' results go; the execution owns everything
 * else about the work the session delegates — the input that reaches it while
 * it runs, when it is finished, how it is stopped, and what it all cost.
 *
 * The application layer supplies the delegated work through `ExecutionWorkHost`
 * (registered on `app-bridge`); nothing here knows how it is scheduled.
 */

import type { ExecutionEnvironment, InstalledApp, RunTokenUsage } from '../../../../shared/apps/app-types'
import type { CapabilityMode, CapabilityPolicy, TurnFileAccess } from '../../../../shared/apps/capability-policy'
import type { CollabMode, TeamFolderPaths, TeamRequestOrigin } from '../../../../shared/apps/team-types'
import type { AgentModelSelection } from '../../../../shared/types/ai-sources'
import type { ImPermissionContext, ImSessionContext } from '../../../../shared/types/im-channel'
import type { TranscriptProvenance } from '../../../../shared/types/transcript'
import type { IDisposable } from '../../../platform/event'
import type { ToolsetExecutionOptions } from '../toolsets/types'

// ── What an entry describes ─────────────────────────────────────────────────

/** Who the work is done for and what that principal is allowed to do. */
export interface ExecutionPrincipal {
  /** The digital human collaborators are created for; absent when the work has no app of its own. */
  readonly appId?: string
  readonly permissions: InstalledApp['permissions']
  readonly environment: ExecutionEnvironment
  /** The digital human's own opt-outs; the user's global ones always apply as well. */
  readonly disabledTools?: readonly string[]
}

/** Who asked, when it is not the principal's owner, and what they may make the principal do. */
export interface ExecutionRequester {
  readonly origin?: TeamRequestOrigin
  readonly delegation?: { readonly policy: CapabilityPolicy | undefined; readonly mode: CapabilityMode }
  /** The file boundary the request's collaborators inherit; read when work is first delegated. */
  files?(): TurnFileAccess | undefined
  /** Why a file may not be published for this request; null when it may. */
  publicationRefusal?(absolutePath: string): string | null
}

/** The IM chat a request came from; a late result returns under the sender's authority at the time. */
export interface ChannelOrigin {
  readonly session: ImSessionContext
  readonly permission: ImPermissionContext | undefined
}

/** A team member's turn: what its coordination tools need to know about the team it serves. */
export interface MemberTurn {
  /** The member's own digital human. */
  readonly appId: string
  readonly teamId: string
  readonly epochId: string
  readonly forwardDepth?: number
  readonly collabMode: CollabMode
  readonly selfIsLead: boolean
  readonly teamFolder: TeamFolderPaths | null
  /** The member exists for this collaboration alone. */
  readonly disposable: boolean
  /** The turn answers an IM guest. */
  readonly servesGuest: boolean
}

/** Where the collaborators' results go, and with it what the execution is. */
export type ExecutionSource =
  /** A headless run: results enter the execution's own session, and it is complete only once they have reported. */
  | { readonly kind: 'run' }
  /** A conversation turn: the conversation is the inbox and results resume it; the execution never waits for them. */
  | { readonly kind: 'conversation'; readonly requestId?: string; readonly channel?: ChannelOrigin }
  /** A team member's turn: the team's coordination tools, private assistants included. */
  | { readonly kind: 'member'; readonly requestId?: string; readonly member: MemberTurn }

export interface AgentExecutionOptions {
  /** The identity delegated work reports back under; unique among the live executions of a headless source. */
  readonly key: string
  readonly principal: ExecutionPrincipal
  readonly modelSelection?: AgentModelSelection
  /** The tool grants the engine session holds right now: what delegated work inherits; read when work is first delegated. */
  grants(): ToolsetExecutionOptions
  readonly requester?: ExecutionRequester
  /** Defaults to a headless run. */
  readonly source?: ExecutionSource
  /** A stop requested from outside: when it aborts the execution is stopped (see `AgentExecution.stop`). */
  readonly signal?: AbortSignal
}

// ── Input and the engine session ────────────────────────────────────────────

/** What an input reaching the execution looks like once the host has authorized it. */
export interface AuthorizedInput {
  /** What the model reads. */
  readonly text: string
  /** What the entry's transcript keeps. */
  readonly record: { readonly content: string; readonly provenance: TranscriptProvenance }
}

/** `discarded`: the execution no longer accepts it. Otherwise how the engine received it. */
export type InputDisposition = 'mid_turn' | 'buffered' | 'discarded'

/** The way authorized input enters an execution. */
export interface ExecutionInputPort {
  /** `authorized` is read again when the input reaches the front of the queue; false discards it. */
  accept(input: AuthorizedInput, authorized: () => boolean): Promise<InputDisposition>
}

/** The engine session as an execution reads it. */
export interface ExecutionSessionPort {
  send(message: string): unknown
  stream(): AsyncIterable<unknown>
  sendIntoLiveTurn?(message: string, options?: { onWithdrawn?: () => void }): boolean
  hasPendingInput?(): boolean
  withdrawUnreadInput?(): Promise<number>
}

/** The session as seen from outside the execution: input accepted through it is counted by the execution. */
export type ExecutionSessionHandle = Omit<ExecutionSessionPort, 'stream'>

/** What a stop needs of the engine; the entry owns the session, so it supplies these. */
export interface ExecutionEngineControl {
  /** Interrupts the engine's current turn. */
  interrupt?: () => Promise<unknown> | unknown
  /** Ends the engine session. */
  close: () => void
  /** Whether the engine can interrupt a turn; one that cannot is closed straight away. */
  canInterrupt: boolean
}

export interface ExecutionBinding {
  /** How the entry's own submissions reach the engine when it is not the session's plain `send` (a lease). */
  send?: (message: string) => unknown
  /** Where input accepted from delegated work is recorded for the entry's transcript. */
  record?: (record: AuthorizedInput['record']) => void
  /** How a stop reaches the engine; without it a stop ends only what the execution owns. */
  engine?: ExecutionEngineControl
}

/** The entry's reading of the engine, message by message. */
export interface ExecutionReader {
  /** The submitted message reached the engine. */
  onSent?(): void
  /** Every engine message, in order. `'stop'` ends the execution: nothing more is admitted or read. */
  onMessage(message: unknown): 'stop' | void
}

// ── What an entry holds ─────────────────────────────────────────────────────

export interface AgentExecution {
  /** In-process servers the engine session mounts; empty when nothing is delegated through this execution. */
  readonly tools: Readonly<Record<string, unknown>>
  /** Model-facing guidance for `tools`; undefined when no host supplies delegated work. */
  readonly guidance: string | undefined
  /** Whether new work may be delegated right now: live, and neither the user, the principal nor the requester ruled it out. */
  mayDelegate(): boolean

  /** Headless entries: connect the engine session that performs the execution. */
  bind(session: ExecutionSessionPort, binding?: ExecutionBinding): void
  /** The bound session as input sources reach it; use this, not the raw session, for out-of-band input. */
  readonly session: ExecutionSessionHandle
  /**
   * Headless entries: send `message` and read the engine until it has ended and
   * nothing the execution owns is unfinished or unread. The entry sees every
   * message through `reader`. Conversation entries never call this; their
   * consumer already reads the engine.
   */
  submit(message: string, reader: ExecutionReader): Promise<void>
  /** Counts the inputs accepted since the execution began, so a decision can tell whether it predates one. */
  readonly inputRevision: number
  /** Nothing owned is unfinished and the session holds no unread input. */
  canComplete(): boolean
  /** What the engine session and the work it delegated processed, so far. */
  usage(): RunTokenUsage | undefined

  /**
   * Stop the execution from outside (aborting `signal` does the same). In order:
   * admission closes, the engine turn being read is interrupted (and the session
   * closed if it does not end), what the execution owns is stopped. Resolves once
   * that read has ended and everything is stopped; "stop requested" and "stopped"
   * are different moments. Idempotent.
   */
  stop(): Promise<void>
  /**
   * The execution is over, however it ended: admission closes, what it holds is
   * retired, in-flight input is awaited and usage is settled. It does not interrupt
   * the engine and does not wait for a message being read — use `stop` for that.
   * Idempotent.
   */
  close(): Promise<void>
}

// ── The application layer's side ────────────────────────────────────────────

export interface ExecutionWorkRequest {
  readonly key: string
  readonly principal: ExecutionPrincipal
  readonly modelSelection: AgentModelSelection | undefined
  readonly requester: ExecutionRequester | undefined
  readonly source: ExecutionSource
  /** The tool grants the execution holds right now: what delegated work inherits. */
  grants(): ToolsetExecutionOptions
  /** The execution has not ended. */
  isLive(): boolean
  /** New work may be delegated: live, and neither the user, the principal nor the requester switched delegation off. */
  mayDelegate(): boolean
  /** Where results the host has authorized enter a headless execution. */
  readonly input: ExecutionInputPort
}

/** The work one execution delegates, as the host reports it. */
export interface OwnedWork {
  /** Server name → in-process server the engine session mounts. */
  readonly tools: Readonly<Record<string, unknown>>
  /** Model-facing description of what `tools` offers. */
  readonly guidance: string
  /** Unfinished work remains. Throws when that cannot be known. */
  hasPending(): boolean
  /** A change may have altered `hasPending`: a reason to read it again, not a claim about its value. */
  onChanged(listener: () => void): IDisposable
  /**
   * The execution is over: retire what it holds — its endpoint and its admission of
   * input. Work that belongs to the execution (a headless run's collaborators) is
   * stopped; a conversation's collaborators belong to the conversation and keep
   * running. Begins synchronously; resolves when resources have stopped. Idempotent.
   */
  end(): Promise<void>
  /** Usage of the owned work so far, handed over once; ends observation of it. */
  takeUsage(): RunTokenUsage | undefined
}

export interface ExecutionWorkHost {
  open(request: ExecutionWorkRequest): OwnedWork
}

/**
 * A conversation's collaborators, as the application layer answers for them.
 * Unlike an execution's own work they outlive its turns, so they are stopped by
 * the conversation's stop, not by any turn ending.
 */
export interface ConversationWorkHost {
  /** A person's request starts: what it sets in motion belongs to it. */
  beginRequest(conversationId: string, requestId: string): void
  /** That conversation has collaborators or queued work to cancel. */
  hasWork(conversationId: string): boolean
  /** Cancel the conversation's request, its queued deliveries and its collaborators, descendants included. */
  stop(conversationId: string): Promise<void>
}
