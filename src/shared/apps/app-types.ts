/**
 * Shared App Runtime Types
 *
 * Pure TypeScript type definitions for the Apps system.
 * These types are used by both the main process and the renderer process.
 *
 * IMPORTANT: This file must NOT import any Node.js or Electron APIs.
 * It is included in the renderer (web) tsconfig.
 *
 * All types here are manually mirrored from:
 *   - src/main/apps/manager/types.ts  (AppStatus, RunOutcome, InstalledApp)
 *   - src/main/apps/runtime/types.ts  (ActivityEntry, AutomationAppState, EscalationResponse, etc.)
 *
 * Why manual mirror instead of re-export?
 * - The renderer tsconfig does not include src/main/
 * - Importing from src/main/ would pull in Node.js types and Zod schemas
 * - Keeps the renderer bundle free of server-only code
 *
 * When the source types change, update this file to match.
 */

// ============================================
// Manager Types (mirrored from apps/manager/types.ts)
// ============================================

/**
 * Runtime status of an installed App.
 *
 * - active:        Running normally (automation) or available for use (mcp/skill)
 * - paused:        User manually paused; subscriptions inactive
 * - error:         Consecutive failures hit threshold; auto-disabled
 * - needs_login:   AI Browser detected expired login session
 * - waiting_user:  AI triggered escalation; awaiting user decision
 * - uninstalled:   Soft-deleted; hidden from default views, can be reinstalled or permanently deleted
 */
export type AppStatus = 'active' | 'paused' | 'error' | 'needs_login' | 'waiting_user' | 'uninstalled'

/**
 * Outcome of a single App execution run.
 */
export type RunOutcome = 'useful' | 'noop' | 'error' | 'skipped'

/**
 * Full representation of an installed App instance.
 *
 * Each installed App has a unique `id` (UUID). It may belong to a specific
 * `spaceId` or be global (`spaceId = null`), available across all spaces.
 * Stores a snapshot of the AppSpec at install time plus user configuration.
 */
export interface InstalledApp {
  dataPath?: string
  /** Unique installation ID (UUID v4) */
  id: string

  /** App specification identifier (from spec.name or a registry ID) */
  specId: string

  /** Space this App is installed in (null = global, available in all spaces) */
  spaceId: string | null

  /** Full AppSpec (initially set at install time, updatable via updateSpec) */
  spec: import('./spec-types').AppSpec

  /** Current runtime status */
  status: AppStatus

  /**
   * Opaque escalation ID set when status is 'waiting_user'.
   * Points to an activity_entries record (managed by apps/runtime).
   */
  pendingEscalationId?: string

  /** User-provided configuration values (corresponds to spec.config_schema) */
  userConfig: Record<string, unknown>

  /** User overrides for tunable per-app settings */
  userOverrides: {
    /** Notification level: 'all' | 'important' | 'none'. Defaults to 'important'. */
    notificationLevel?: 'all' | 'important' | 'none'
    /** Override AI source for this App. When set, uses this source instead of the global one. */
    modelSourceId?: string
    /** Override model within the selected AI source. Used together with modelSourceId. */
    modelId?: string
    /** When true, the login notice bar is permanently dismissed for this app */
    loginNoticeDismissed?: boolean
  }

  /** Permission grants and denials */
  permissions: {
    granted: string[]
    denied: string[]
  }

  /** Unix timestamp (ms) when the App was installed */
  installedAt: number

  /** Unix timestamp (ms) of the last execution run */
  lastRunAt?: number

  /** Outcome of the last execution run */
  lastRunOutcome?: RunOutcome

  /** Error message from the last failed run or status change */
  errorMessage?: string

  /** Unix timestamp (ms) when the App was soft-deleted (uninstalled). Undefined if active. */
  uninstalledAt?: number

  /**
   * User-controlled upgrade strategy.
   *
   * - 'auto'    (default): patch/minor versions install silently; majors notify
   * - 'notify':  surface every available update as a notification
   * - 'manual':  no automatic checks; user-triggered only
   */
  upgradeStrategy: UpgradeStrategy

  /** Whether the one-time knowledge-base seed has already run for this App. */
  knowledgeSeeded: boolean
}

/** User-controlled per-app upgrade strategy. */
export type UpgradeStrategy = 'auto' | 'notify' | 'manual'

/** Filter criteria for listing Apps */
export interface AppListFilter {
  /** Filter by space: string = specific space, null = global only, undefined = all */
  spaceId?: string | null
  status?: AppStatus
  type?: import('./spec-types').AppType
}

// ============================================
// Runtime Types (mirrored from apps/runtime/types.ts)
// ============================================

/** Types of activity entries written by the AI via report_to_user */
export type ActivityEntryType =
  | 'run_complete'
  | 'run_skipped'
  | 'run_error'
  | 'milestone'
  | 'escalation'
  | 'output'

export interface ExecutionEnvironment {
  spaceId: string | null
  spacePath: string
  workDir: string
  memoryDir: string
  /** Connections resolved for this environment; a missing instance must not fall back by name. */
  mcpBindings?: Record<string, string>
}

export interface ActivitySource {
  kind: 'automation' | 'team' | 'chat' | 'unknown'
  appId: string
  runId?: string
  sessionKey?: string
  teamId?: string
  epochId?: string
  taskId?: string
  memberId?: string
  teamName?: string
  label?: string
}

export interface EscalationContinuation {
  status: 'queued' | 'running' | 'failed' | 'completed' | 'cancelled'
  attempts: number
  updatedAt: number
  error?: string
}

/** Content of an activity entry */
export interface ActivityEntryContent {
  // `dismissed` is the user declining one request while its work continues;
  // `task_closed` is the work itself ending. The card states which happened,
  // so sharing a reason would make it claim the wrong one.
  resolution?: { reason: 'task_closed' | 'dismissed' | 'expired' | 'legacy_system_closed'; ts: number; legacyText?: string; attribution?: 'unverified' }
  source?: ActivitySource
  resumeAvailable?: boolean
  stopped?: boolean
  deadlineAt?: number
  deadlineReviewRequired?: boolean
  deadlineReview?: { originalDeadlineAt: number; confirmedAt?: number; deadlineAt?: number | null }
  teamContext?: import('./team-types').TeamContext
  /** Human-readable summary (required, written by AI) */
  summary: string
  /** Run status indicator */
  status?: 'ok' | 'error' | 'skipped'
  /** Run duration in milliseconds */
  durationMs?: number
  /** Error message */
  error?: string
  /** Next retry time (for run_error) */
  nextRetryMs?: number
  /** Structured output data (tables, lists, short inline markdown) */
  data?: unknown
  /** Absolute path to a markdown file written by AI (replaces inline data for large content) */
  dataPath?: string
  /** Question for the user (escalation only) */
  question?: string
  /** Preset choices for escalation */
  choices?: string[]
  /**
   * The decisions asked, when an escalation asks for more than one. `summary`
   * then frames why they are being asked and `choices` does not apply. A
   * single-decision escalation leaves this empty and carries its question in
   * `summary`.
   */
  questions?: EscalationQuestion[]
  /** File URL for output type */
  outputUrl?: string
}

/** One decision an escalation asks the user to make. */
export interface EscalationQuestion {
  question: string
  /** Preset answers; the user may still type their own. */
  choices?: string[]
}

/** The user's answer to a single question. */
export interface EscalationAnswer {
  choice?: string
  text?: string
}

/** User response to an escalation */
export interface EscalationResponse {
  ts: number
  choice?: string
  text?: string
  /** One answer per `content.questions`, in the same order. */
  answers?: EscalationAnswer[]
}

/**
 * What a client sends when answering an escalation. One declaration for every
 * surface that carries it (renderer API, store, preload, HTTP body) — the same
 * shape written inline four times is how a field ships broken on one of them.
 */
export type EscalationAnswerPayload = Omit<EscalationResponse, 'ts'>

/** A single Activity Thread entry */
export interface ActivityEntry {
  id: string
  appId: string
  runId: string
  type: ActivityEntryType
  ts: number
  sessionKey?: string
  content: ActivityEntryContent
  userResponse?: EscalationResponse
  continuation?: EscalationContinuation
}

/** What caused a run to execute */
export type TriggerType = 'schedule' | 'event' | 'manual' | 'escalation_followup' | 'continue_followup'

/** Status of a single automation run */
export type RunStatus = 'running' | 'ok' | 'error' | 'skipped' | 'waiting_user'

/** Persistent record of an automation run */
export interface AutomationRun {
  runId: string
  appId: string
  sessionKey: string
  status: RunStatus
  triggerType: TriggerType
  triggerData?: Record<string, unknown>
  startedAt: number
  finishedAt?: number
  durationMs?: number
  tokensUsed?: number
  errorMessage?: string
  sessionId?: string
}

/**
 * An AutomationRun with its last activity entry's summary attached — for the
 * run-history list. Falls back to `errorMessage` when `status === 'error'`.
 */
export interface AutomationRunWithSummary extends AutomationRun {
  summary?: string
}

/** Aggregate run outcomes over a recent window, for the digital-human overview. */
export interface RunStats {
  total: number
  ok: number
  error: number
  skipped: number
  totalTokens: number
  avgDurationMs: number
}

/** Options for querying run history */
export interface RunQueryOptions {
  limit?: number
  offset?: number
}

/**
 * Why a digital human has stopped and cannot start itself again.
 *
 * - auto_disabled: consecutive failures hit the threshold; the runtime stopped it
 * - needs_login:   a sign-in it depends on expired
 *
 * Both are cleared by the same user action (resume).
 */
export type BlockedReason = 'auto_disabled' | 'needs_login'

/** Real-time state of an automation App (for UI display) */
export interface AutomationAppState {
  automaticEnabled?: boolean
  runningCount?: number
  pendingDecisionCount?: number
  pendingSoloDecisionCount?: number
  continuationCount?: number
  /**
   * - running:      Actively executing a run right now
   * - queued:       Manually triggered; waiting for a global concurrency slot
   * - idle:         Active and scheduled, no run in progress
   * - paused:       User paused the app; subscriptions inactive
   * - waiting_user: AI escalated; awaiting user decision
   * - needs_login:  AI Browser detected expired login session
   * - error:        Consecutive failures hit threshold; auto-disabled
   */
  status: 'running' | 'queued' | 'idle' | 'paused' | 'waiting_user' | 'needs_login' | 'error'
  nextRunAtMs?: number
  runningAtMs?: number
  /** Run ID of the currently executing run (only set when status === 'running') */
  runningRunId?: string
  /** Session key of the currently executing run (only set when status === 'running') */
  runningSessionKey?: string
  lastRunAtMs?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors?: number
  pendingEscalationId?: string
  /** Set while the person is stopped and only the user can restart it. */
  blocked?: BlockedReason
}

/**
 * Whether this digital human is waiting on its owner: it has questions to
 * answer, or it has stopped and only the owner can restart it.
 *
 * Both are the same thing to the person looking at the screen: work that will
 * not move until they act. Every surface claiming someone needs the owner must
 * ask this one function — a surface with its own definition can list a person
 * for a reason the page they open offers no way to resolve.
 */
export function needsAttention(state?: Pick<AutomationAppState, 'pendingDecisionCount' | 'blocked'>): boolean {
  return (state?.pendingDecisionCount ?? 0) > 0 || !!state?.blocked
}

/** Per-app snapshot for the digital-human card wall's batched first paint. */
export interface AppOverviewEntry {
  appId: string
  state: AutomationAppState
  /** Most recent run_complete/output activity entry, if any. */
  latestSummary?: { type: ActivityEntryType; summary: string; ts: number }
  /** Most recent run statuses, oldest first, capped at 7. */
  recentRunStatuses: RunStatus[]
}

export interface PendingDecisionQuery {
  limit?: number
  afterTs?: number
  afterId?: string
}

/** A digital human that stopped and is waiting for its owner to restart it. */
export interface BlockedPerson {
  appId: string
  name: string
  reason: BlockedReason
  /** What the runtime recorded when it stopped, when it recorded anything. */
  message?: string
}

export interface PendingDecisionInbox {
  entries: ActivityEntry[]
  /** Pending questions plus stopped people — everything the owner must act on. */
  total: number
  names: Record<string, string>
  blocked: BlockedPerson[]
}

export interface AppRunStartInfo {
  outcome: 'started' | 'queued'
  runId?: string
  sessionKey?: string
  startedAt?: number
}

/** Options for querying activity entries */
export interface ActivityQueryOptions {
  teamId?: string
  epochId?: string
  limit?: number
  offset?: number
  type?: ActivityEntryType
  since?: number
  beforeId?: string
}

// ============================================
// IPC Response Envelopes
// ============================================

/** Standard success response with data */
export interface AppSuccessResponse<T = unknown> {
  success: true
  data: T
}

/** Standard error response */
export interface AppErrorResponse {
  success: false
  error: string
}

/** Union of success/error responses */
export type AppResponse<T = unknown> = AppSuccessResponse<T> | AppErrorResponse

// ============================================
// Available Skills (runtime disk discovery)
// ============================================

/**
 * A skill actually loadable by a digital human at runtime.
 * Produced by disk discovery — see main/apps/skill-discovery.ts for why the
 * disk, not the installed-apps table, is the source of truth.
 */
export interface AvailableSkill {
  /** Display name (SKILL.md frontmatter `name`, falls back to directory name) */
  name: string
  /** Frontmatter `description` — what the skill does */
  description: string
  /** Where the skill lives relative to the digital human */
  scope: 'global' | 'space'
  /** Directory basename; matches an installed skill app's sanitized specId when one exists */
  dirName: string
  /** Absolute on-disk skill directory — the skill's real source, openable regardless of any installed-app record */
  path: string
  /** SKILL.md content (may be truncated); empty when unreadable */
  content: string
}

// ============================================
// Permission Helpers
// ============================================

/**
 * Resolve whether a specific permission is effective for an App.
 *
 * Resolution order (user override wins over spec declaration):
 * 1. If explicitly denied  → false
 * 2. If explicitly granted → true
 * 3. If the spec declares it → true
 * 4. Otherwise → defaultValue (on by default)
 *
 * A spec's `permissions` list only ADDS capability — it never forces a
 * permission off just because the author didn't list it. An undeclared
 * permission therefore falls through to `defaultValue`, which defaults to
 * `true`: built-in capabilities are enabled out of the box so digital humans
 * work without the user hunting for a switch. The only way a capability ends
 * up off is an explicit user opt-out (added to `denied`).
 */
export function resolvePermission(
  app: Pick<InstalledApp, 'permissions' | 'spec'>,
  permission: string,
  defaultValue = true
): boolean {
  if (app.permissions.denied.includes(permission)) return false
  if (app.permissions.granted.includes(permission)) return true
  if (app.spec.permissions?.includes(permission)) return true
  return defaultValue
}

/**
 * Whether the app was installed by the built-in loader (bundled with the
 * application binary) rather than by the user. Built-in apps are re-synced
 * from disk on every launch and are protected from permanent deletion
 * (deleteApp rejects with BuiltinAppProtectedError) — UI delete actions must
 * be gated on this check before the user clicks. The marker lives on
 * spec.store.install_source so it survives SQLite and IPC round-trips.
 */
export function isBuiltinApp(app: Pick<InstalledApp, 'spec'>): boolean {
  return app.spec.store?.install_source === 'builtin'
}

/**
 * The decisions an escalation asks for, in display order.
 *
 * Three shapes reach this: the current multi-decision one, the single-decision
 * one that carries its question in `summary`, and entries written before
 * `question` was folded into `summary`. Normalising here is what keeps every
 * reader — the card, the prompt the AI is resumed with, the task history — from
 * branching on which shape it was handed.
 */
export function getEscalationQuestions(content: ActivityEntryContent): EscalationQuestion[] {
  if (content.questions?.length) return content.questions
  return [{
    question: content.question || content.summary,
    ...(content.choices?.length ? { choices: content.choices } : {}),
  }]
}

/**
 * The user's answer rendered as one readable block: what the AI is resumed
 * with, what the team task history records, and what the answered card shows.
 *
 * Numbered against the questions when several were asked, because an answer
 * read apart from its decision ("Yes; the second one") is not an answer.
 */
export function formatEscalationAnswer(
  questions: EscalationQuestion[],
  response: Pick<EscalationResponse, 'choice' | 'text' | 'answers'>
): string {
  const one = (answer: EscalationAnswer) => [answer.choice, answer.text].filter(Boolean).join(' — ')

  const answers = response.answers
  if (!answers?.length) return one(response)
  if (questions.length <= 1) return one(answers[0] ?? {})

  return questions
    .map((q, index) => {
      const answer = answers[index]
      return `${index + 1}. ${q.question}\n   → ${(answer && one(answer)) || '(not answered)'}`
    })
    .join('\n')
}
