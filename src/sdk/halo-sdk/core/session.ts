/**
 * @module core/session
 * V2Session — stateful send/stream/close interface for the Agent SDK.
 * @license MIT
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../utils/logger.js';
import { acquireSessionOwnership } from '../utils/session-ownership.js';
import type { Message, LlmProvider, ContentBlock } from '../types/provider.js';
import type { Tool, FileReadState } from '../types/tool.js';
import type { Options, QueryConfig, PermissionMode, SlashCommand, McpSetServersResult } from '../types/config.js';
import { configuredModels, resolveQueryConfig, thinkingForBudget } from './context.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import type { RequestIdentity } from '../llm/request-identity.js';
import { PromptToolCallingAdapter } from '../llm/tool-calling/index.js';
import { queryLoop } from './query-loop.js';
import { prepareToolContext, type ToolDiscoveryState } from './tool-context/index.js';
import { AssistantHistoryRecorder } from './assistant-history.js';
import { TokenBudget } from './token-budget.js';
import type { SDKMessage, QueryLoopOptions } from './query-types.js';
import type { McpServerConnectionStatus } from '../tools/mcp/bridge.js';
import { filterTools } from '../tools/registry.js';
import { configuredBuiltInTools, borrowedMcpSource, borrowedToolSource, bindBorrowedToolSource, type BorrowedToolSource } from './tool-selection.js';
import { prepareCodeSearch, bindCodeSearchBridge, type SessionCodeSearch } from './code-search.js';
import { resolveSkillCatalog, type SkillCatalog } from '../skills/index.js';
import { extractSdkMcpTools, bridgeSdkMcpTools, assertUniqueMcpToolNames, McpToolIdentityError } from '../tools/mcp/bridge.js';
import { createSdkCollaboration, localCollaborationSettings, appendCollaborationPrompt, type SdkCollaborationBinding } from '../collaboration/sdk/index.js';
import { COLLABORATION_GUIDANCE } from '../collaboration/guidance.js';
import { bindReadDenyFloor } from './read-policy.js';
import { executionBudget, type ExecutionBudget } from './execution-budget.js';
import { streamCollaboration } from '../collaboration/sdk/stream.js';
import {
  McpConnectionManager,
  createMcpConnectionManager,
} from '../tools/mcp/connection-manager.js';
import { createSessionBackgroundTasks, borrowBackgroundTasks } from './background-tasks.js';
import type { SessionBackgroundTasks } from './background-tasks.js';
import { runEventHooks } from './hooks.js';
import { TranscriptWriter, getTranscriptPath } from './transcript.js';
import { loadResumeHistory } from './resume-history.js';
import { isResumeHistoryError } from '../utils/errors.js';
import { releaseSessionToolState, captureSessionToolState, restoreSessionToolState } from '../tools/session-state.js';
import { configureSessionStorage } from '../tools/session-storage.js';
import { registerSessionCheckpoint, takeSessionCheckpoint } from './session-checkpoint.js';
import { buildTodoAttachment, getTodos } from '../tools/todo-write/index.js';
import { drainGoalChange, getGoal, setGoalFromHost } from '../tools/goal/index.js';
import type { Goal, GoalInput } from '../types/goal.js';
import {
  buildSessionRegistry,
  listUserInvocableSlashCommands,
  loadSkillCommands,
  parseSlashInvocation,
  dispatchSlashCommand,
  type CommandRegistry,
  type SlashCommandContext,
  type DispatchOutcome,
  type SessionCostSnapshot,
} from '../commands/index.js';

const log = getLogger('Session');

// ---------------------------------------------------------------------------
// findMostRecentSessionId — for `continue` option
// ---------------------------------------------------------------------------

/**
 * Find the most recently modified session transcript in the given cwd.
 * Returns the session ID (filename without .jsonl), or null if none found.
 * Used by the `continue` option to automatically resume the latest session.
 * Does NOT import index.ts to avoid circular dependencies.
 */
async function findMostRecentSessionId(config: QueryConfig): Promise<string | null> {
  const projectDir = path.dirname(getTranscriptPath('__placeholder__', config.cwd, config));

  try {
    const files = await fs.promises.readdir(projectDir);
    let latestMtime = 0;
    let latestSessionId: string | null = null;

    for (const file of files) {
      if (!file.endsWith('.jsonl') || file.startsWith('.')) continue;
      // Historical sidechain records are not resumable main-session candidates.
      if (file.startsWith('agent-')) continue;
      try {
        const stat = await fs.promises.stat(`${projectDir}/${file}`);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestSessionId = file.slice(0, -'.jsonl'.length);
        }
      } catch { /* skip unreadable files */ }
    }
    return latestSessionId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SDKSession interface
// ---------------------------------------------------------------------------

export interface InputOptions {
  /** Called once when the inbox takes ownership for processing, before prompt hooks. */
  onConsumed?: () => void;
}

export interface LiveInputOptions extends InputOptions {
  /** At most once, only when `withdrawUnreadInput` took this input back before a model step read it. */
  onWithdrawn?: () => void;
}

export interface SessionCloseOptions {
  /** Cancels advisory end hooks; execution is stopped and persistence still drains. */
  signal?: AbortSignal;
}

export interface SessionRuntimeStats {
  pendingInputs: number;
  activeCollaborators: number;
  /** Observed cost of this source and its collaborators, using host-supplied pricing. */
  sharedCostUsd?: number;
}

/**
 * A stateful session that holds conversation state across multiple sends.
 */
export interface SDKSession {
  /** Unique identifier for this session. */
  readonly sessionId: string;

  /**
   * Send a message to the session. The session will process the message
   * through the query loop and yield results via `stream()`.
   *
   * Accepts:
   *   - Plain string
   *   - Direct message: `{ role: 'user', content: string | ContentBlock[] }`
   *   - SDK envelope: `{ type: 'user', message: { role: 'user', content: ... } }`
   */
  send(message: string | Record<string, unknown>, options?: InputOptions): Promise<void>;

  /** Whether accepted input has not yet reached a model step. */
  hasPendingInput(): boolean;
  /** Execution-owned counts, without copying conversation or task contents. */
  getRuntimeStats(): Promise<SessionRuntimeStats>;
  /** Synchronously accepts input for the running query or its immediate continuation. */
  sendIntoLiveTurn(message: string | Record<string, unknown>, options?: LiveInputOptions): boolean;
  /**
   * Takes back every input accepted by `sendIntoLiveTurn` before this call that
   * has not reached a model step, so it never runs, and calls each one's
   * `onWithdrawn`. Resolves with how many were withdrawn.
   */
  withdrawUnreadInput(): Promise<number>;

  /**
   * Stream events from the session. Returns an async generator that yields
   * SDKMessage events as the session processes messages.
   */
  stream(): AsyncGenerator<SDKMessage, void, undefined>;

  /** Close the session and release resources. */
  close(options?: SessionCloseOptions): void;

  /**
   * Wait until all transcript writes queued so far have flushed to disk.
   *
   * Call this before constructing a new session that resumes the same
   * `sessionId`. Without this, the previous session's pending writes may
   * still be in flight when the resumed history is read, producing a
   * partial conversation history (e.g. an assistant `tool_use` without its
   * matching user `tool_result`) that breaks the next API request.
   *
   * Resolves immediately when persistence is disabled or the writer has
   * no pending work. Never rejects — write errors are logged, not thrown.
   */
  flush(): Promise<void>;

  /** Interrupt the current query loop iteration. */
  interrupt(): Promise<void>;

  /** Switch the model for later turns. */
  setModel(model: string | undefined): Promise<void>;

  /** Change the max thinking tokens for subsequent turns. */
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;

  /** Switch the permission mode for later turns. */
  setPermissionMode(mode: PermissionMode): Promise<void>;

  /** The session goal (active or finished), or null when none is set. */
  getGoal(): Goal | null;

  /**
   * Replace the goal on the user's behalf, or clear it with null. The model
   * is told at the start of its next turn, when a `goal_updated` event with
   * `source: 'user'` is also emitted.
   *
   * @throws TypeError when the objective is missing or blank.
   */
  setGoal(goal: GoalInput | null): Goal | null;

  /** Async dispose support — calls close(). */
  [Symbol.asyncDispose](): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface PendingInput {
  payload: string | Message;
  /** Present when accepted through `sendIntoLiveTurn`; only such input can be withdrawn. */
  live?: LiveInputOptions;
  onConsumed?: () => void;
}

interface SessionState {
  toolContext: ToolDiscoveryState | null;
  borrowedSource?: BorrowedToolSource;
  borrowedRevision: number;
  borrowedTools: Set<Tool>;
  mcpCatalogRevision: number;
  toolStateRevision: number;
  contextToolRevision: number;
  sessionId: string;
  config: QueryConfig;
  provider: LlmProvider;
  tools: Tool[];
  messages: Message[];
  abortController: AbortController;
  removeAbortListener?: () => void;
  closed: boolean;
  /** Queue of pending user messages. */
  pendingMessages: PendingInput[];
  /** Resolve function to wake up stream() when a message arrives via send(). */
  pendingWakeUp: (() => void) | null;
  /** Active stream generator (only one at a time). */
  activeStream: AsyncGenerator<SDKMessage, void, undefined> | null;
  /** MCP connection manager (for reconnection + cleanup). */
  mcpManager: McpConnectionManager | null;
  /** All MCP server connection statuses (SDK + external). */
  mcpServerStatuses: McpServerConnectionStatus[];
  /** Shell processes and completion notices owned by this session. */
  backgroundTasks: SessionBackgroundTasks | null;
  collaboration?: SdkCollaborationBinding;
  budget?: ExecutionBudget;
  codeSearch?: SessionCodeSearch;
  /** Slash commands for supportedCommands() (from config). */
  slashCommands: SlashCommand[];
  /**
   * Per-session command registry. Holds the executable contract for every
   * command (built-in, skill-derived, or caller-supplied). Used by `stream()`
   * to dispatch `/foo` invocations in-process before falling through to the
   * LLM.
   */
  commandRegistry: CommandRegistry;
  /**
   * Cumulative cost / usage snapshot, aggregated from each completed turn's
   * `result` event. Surfaced to slash command handlers via
   * {@link SlashCommandContext.getCostSnapshot}. The current in-flight turn
   * is not yet reflected — its `result` event has not been emitted.
   */
  costSnapshot: SessionCostSnapshot;
  /** Skill names for the init message (from config). */
  skills: string[];
  skillCatalog: SkillCatalog;
  /**
   * The model the session was created with — used by setModel(undefined) to
   * reset back to the originally configured model.
   */
  initialModel: string;
  /** Exit listeners for the transport shim. */
  exitListeners: Set<(error: Error | undefined) => void>;
  /** Transcript writer for session persistence (null if disabled). */
  transcriptWriter: TranscriptWriter | null;
  /**
   * Promise that resolves once the transcript writer has flushed all writes
   * queued before `close()` was invoked. Set when `close()` runs; awaited by
   * `Symbol.asyncDispose` and the public `flush()` method so consumers can
   * guarantee the on-disk transcript is durable before resuming the same
   * `sessionId` in a new session.
   */
  closeFlushPromise: Promise<void> | null;
  startupHooks: Promise<unknown>;
  releaseOwnership: () => void;
  /**
   * Read-before-write state shared by every query-loop run of this session,
   * so Write/Edit honour reads performed in earlier user turns.
   */
  readFileState: Map<string, FileReadState>;
  contextState: NonNullable<QueryLoopOptions['contextState']>;
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

/**
 * Create a new SDK session.
 *
 * The session maintains conversation state across multiple `send()` calls.
 * Use `stream()` to receive SDKMessage events.
 *
 * @param options - SDK Options for configuring the session
 * @returns A new SDKSession instance
 */
export async function createSession(options: Options): Promise<SDKSession> {
  const rollback: Array<() => void | Promise<void>> = [];
  try { return await prepareSession(options, cleanup => rollback.push(cleanup)); }
  catch (error) {
    for (const cleanup of rollback.reverse()) {
      try { await cleanup(); }
      catch (failure) { log.warn('Failed session preparation cleanup', { error: String(failure) }); }
    }
    log.warn('Session preparation failed', { sessionId: options.resume ?? options.sessionId, error: String(error) });
    throw error;
  }
}

async function prepareSession(options: Options, onFailure: (cleanup: () => void | Promise<void>) => void): Promise<SDKSession> {
  // bypassPermissions and allowDangerouslySkipPermissions are independent OR'd
  // switches — either alone bypasses permission checks.

  const env = options.env as Record<string, string | undefined> | undefined;
  // Support compat fields: options.apiKey / options.anthropicBaseUrl
  const apiKey = options.apiKey ?? env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl = options.anthropicBaseUrl ?? env?.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;
  const requestIdentity = options.requestIdentity as RequestIdentity | undefined;
  const baseProvider = options.provider ?? (
    apiKey
      ? new AnthropicProvider({ apiKey, baseUrl, requestIdentity })
      : (() => { throw new Error('createSession() requires options.provider, options.apiKey, or ANTHROPIC_API_KEY in env.'); })()
  );

  const config = resolveQueryConfig(options);
  const abortController = options.abortController ?? new AbortController();
  onFailure(() => abortController.abort());

  // Wrap with adapter when the resolved mode is not native.
  const provider = config.toolCallingMode !== 'native'
    ? new PromptToolCallingAdapter(baseProvider, config.toolCallingMode)
    : baseProvider;
  log.info('tool-calling', { model: config.model, mode: config.toolCallingMode });

  // Build tool list:
  // 1. Start with built-in tools (filtered by options.tools if specified)
  // 2. Merge customTools (custom overrides built-in by name)
  // 3. Bridge SDK MCP server tools (synchronous, in-process)
  // 4. Connect external MCP servers (async, stdio/sse/http)
  // 5. Apply disallowedTools blacklist filtering
  //
  // Tool resolution semantics:
  //   options.tools        → base built-in tool set
  //                          string[]  = only these built-ins; [] = none; undefined = all
  //   options.allowedTools → permission bypass only, NOT a pool filter
  //                          (skips canUseTool check)
  //   options.disallowedTools → blacklist, removes tools from pool entirely
  const codeSearch = prepareCodeSearch(options);
  if (codeSearch) onFailure(() => codeSearch.dispose());
  const builtInTools = configuredBuiltInTools(options, codeSearch ? [codeSearch.tool] : []);

  let tools: Tool[];
  if (options.customTools && options.customTools.length > 0) {
    const customToolNames = new Set(options.customTools.map((t) => t.name));
    tools = [...builtInTools.filter((t) => !customToolNames.has(t.name)), ...options.customTools];
  } else {
    tools = builtInTools;
  }

  // Bridge SDK MCP server tools into the tool list (synchronous)
  const mcpTools = extractSdkMcpTools(
    options.mcpServers as Record<string, unknown> | undefined,
  );
  if (mcpTools.length > 0) {
    const mcpToolNames = new Set(mcpTools.map((t) => t.name));
    tools = tools.filter((t) => !mcpToolNames.has(t.name));
    tools.push(...mcpTools);
  }

  // Collect MCP server statuses for the init message.
  // SDK (in-process) servers are always "connected".
  const mcpServerStatuses: McpServerConnectionStatus[] = [];
  if (options.mcpServers) {
    for (const [name, cfg] of Object.entries(options.mcpServers)) {
      if (cfg && typeof cfg === 'object' && (cfg as Record<string, unknown>).type === 'sdk') {
        mcpServerStatuses.push({ name, status: 'connected' });
      }
    }
  }

  // Connect external MCP servers via the connection manager (with reconnection support)
  let mcpManager: McpConnectionManager | null = null;
  const abortPreparation = () => mcpManager?.disconnectAll();
  abortController.signal.addEventListener('abort', abortPreparation, { once: true });
  onFailure(() => abortController.signal.removeEventListener('abort', abortPreparation));
  try {
    mcpManager = createMcpConnectionManager(
      options.mcpServers as Record<string, unknown> | undefined,
      options.onElicitation ? { onElicitation: options.onElicitation } : undefined,
    );
    onFailure(async () => { mcpManager?.disconnectAll(); await mcpManager?.whenSettled(); });
    if (abortController.signal.aborted) abortPreparation();
    await mcpManager.connectAll();
    if (abortController.signal.aborted) {
      mcpManager.disconnectAll();
      throw new Error('Session creation aborted');
    }
    const extTools = mcpManager.getBridgedTools();
    assertUniqueMcpToolNames([...mcpTools, ...extTools]);
    if (extTools.length > 0) {
      const extToolNames = new Set(extTools.map((t) => t.name));
      tools = tools.filter((t) => !extToolNames.has(t.name));
      tools.push(...extTools);
    }
    // Merge external server statuses
    mcpServerStatuses.push(...mcpManager.getStatuses());
  } catch (err: unknown) {
    if (err instanceof McpToolIdentityError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('external MCP connection error', { err: msg });
  }

  if (abortController.signal.aborted) {
    mcpManager?.disconnectAll();
    throw new Error('Session creation aborted');
  }

  // Apply disallowedTools blacklist only.
  // allowedTools is a permission bypass concept —
  // it skips canUseTool checks but does NOT filter the tool pool.
  tools = filterTools(tools, {
    disallowedTools: config.disallowedTools,
  });

  const configWithSignal = { ...config, abortSignal: abortController.signal };

  // Continue mode: find the most recent session in cwd
  let resumeSessionId = options.resume as string | undefined;
  if (options.continue && !resumeSessionId) {
    const found = await findMostRecentSessionId(config);
    if (found) {
      resumeSessionId = found;
      log.info('continue: resuming session', { sessionId: found });
    }
  }

  // Determine the active session ID for writing transcript
  // - forkSession + resume → new UUID (explicit fork)
  // - resume without fork  → continue original session ID
  // - fresh session        → options.sessionId or new UUID
  const activeSessionId: string =
    (options.forkSession === true && resumeSessionId)
      ? randomUUID()
      : (resumeSessionId
          ?? (options.sessionId as string | undefined)
          ?? randomUUID());

  const releaseOwnership = await acquireSessionOwnership(
    getTranscriptPath(activeSessionId, config.cwd, config), abortController.signal, activeSessionId,
  );
  onFailure(releaseOwnership);
  onFailure(() => releaseSessionToolState(activeSessionId));
  configureSessionStorage(activeSessionId, config, options.persistSession !== false);
  const checkpoint = takeSessionCheckpoint(options);
  if (checkpoint && (checkpoint.sessionId !== activeSessionId || checkpoint.cwd !== config.cwd)) {
    throw new Error('A session checkpoint cannot move to another identity or workspace.');
  }

  // Shell processes and their notices remain owned by the source session.
  const backgroundTasks = borrowBackgroundTasks(options) ?? createSessionBackgroundTasks({
    config: () => state.config,
    sessionId: activeSessionId,
    persistSession: options.persistSession,
  });
  onFailure(async () => { backgroundTasks.dispose(); await backgroundTasks.flush(); });

  const inherited = borrowedToolSource(options);
  const inheritedSnapshot = inherited?.read();
  if (inherited && inheritedSnapshot) {
    const previous = new Set(inherited.initial);
    tools = filterTools([...tools.filter(tool => !previous.has(tool)), ...inheritedSnapshot.tools], { disallowedTools: config.disallowedTools });
    assertUniqueMcpToolNames(tools.filter(tool => tool.mcpSource));
  }
  const shareMcp = borrowedMcpSource(() => getSessionToolState(state));
  const collaborationSettings = localCollaborationSettings(options);
  const collaboration = collaborationSettings === false ? undefined : createSdkCollaboration({
    sessionId: activeSessionId,
    settings: collaborationSettings,
    getOptions: () => {
      const shared = shareMcp();
      const current: Options = {
        ...options, provider: baseProvider, model: state.config.model, permissionMode: state.config.permissionMode,
        thinking: state.config.thinkingExplicit ? state.config.thinking : undefined,
        effort: state.config.effort, maxOutputTokens: state.config.maxTokens,
        disallowedTools: state.config.disallowedTools, allowedTools: state.config.allowedTools,
        canUseTool: state.config.canUseTool, hooks: state.config.hooks,
        maxBudgetUsd: state.config.maxBudgetUsd, maxTurns: state.config.maxTurns,
        toolResultBudget: state.config.toolResultBudget, toolDiscovery: state.config.toolDiscovery,
        mcpServers: {},
        customTools: [
          ...(options.customTools ?? []).filter(tool => !tool.mcpSource),
          ...shared.tools,
        ],
      };
      bindBorrowedToolSource(current, { read: shareMcp, initial: shared.tools });
      bindReadDenyFloor(current, state.config.readDenyRoots);
      if (state.codeSearch) bindCodeSearchBridge(current, state.codeSearch.borrow());
      return current;
    },
    deliverToSource: async envelope => {
      if (state.closed) throw new Error('The source conversation has closed.');
      const live = !!state.activeStream;
      if (!session.sendIntoLiveTurn(envelope.body)) throw new Error('The source conversation cannot accept collaboration input.');
      return live ? 'mid_turn' : 'buffered';
    },
  });
  if (collaboration) {
    tools = filterTools([...tools, ...bridgeSdkMcpTools(collaboration.server)], { disallowedTools: config.disallowedTools });
    if (tools.some(tool => tool.name === 'mcp__halo-team__spawn_agent')) {
      configWithSignal.systemPrompt = appendCollaborationPrompt(configWithSignal.systemPrompt, COLLABORATION_GUIDANCE)!;
    }
    onFailure(() => collaboration.close());
    mcpServerStatuses.push({ name: 'halo-team', status: 'connected' });
  }

  // Per-session slash command registry: SDK built-ins → skills → caller overlay.
  // Later sources win on name collision.
  // Skills loader is wrapped defensively — a malformed skill file must not
  // break session creation.
  let skillCommands: ReturnType<typeof loadSkillCommands> = [];
  let skillCatalog: SkillCatalog = [];
  try {
    if (tools.some((tool) => tool.name === 'Skill')) {
      skillCatalog = resolveSkillCatalog(config);
    }
    skillCommands = loadSkillCommands({
      enabled: tools.some((tool) => tool.name === 'Skill'),
      cwd: config.cwd,
      env: config.env,
      conventions: config.conventions,
      skillCatalog,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('skill loader failed', { err: msg });
  }
  const commandRegistry: CommandRegistry = buildSessionRegistry({
    user: options.slashCommands,
    skills: skillCommands,
  });
  const slashCommands: SlashCommand[] = listUserInvocableSlashCommands(commandRegistry);

  // Resume session: load transcript messages from disk. Orphan tool_use or
  // tool_result blocks left by an aborted batch or a lost write are reconciled
  // before the next provider call, which would otherwise return 400.
  let resumedMessages: Message[] = [];
  if (checkpoint?.messages) {
    resumedMessages = [...checkpoint.messages];
  } else if (resumeSessionId) {
    try {
      resumedMessages = await loadResumeHistory({
        sessionId: resumeSessionId,
        cwd: config.cwd,
        stopAtMessageUuid: options.resumeSessionAt as string | undefined,
        options: config,
        strict: options.strictResume === true,
      });
    } catch (err: unknown) {
      if (isResumeHistoryError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('failed to load transcript for resume', { err: msg });
    }
  }

  // persistSession: false → skip transcript writing entirely
  const transcriptWriter = options.persistSession === false
    ? null
    : new TranscriptWriter(activeSessionId, config.cwd, config);
  if (checkpoint?.messages && transcriptWriter) {
    await transcriptWriter.writeCompactCheckpoint(checkpoint.messages, '');
  }

  if (options.goal && getGoal(activeSessionId) === null) {
    setGoalFromHost(activeSessionId, options.goal);
  }
  if (checkpoint) restoreSessionToolState(activeSessionId, checkpoint.tools);

  const state: SessionState = {
    toolContext: prepareToolContext(configWithSignal, tools, resumedMessages, resumedMessages.length > 0),
    borrowedSource: inherited, borrowedRevision: inheritedSnapshot?.revision ?? -1, borrowedTools: new Set(inheritedSnapshot?.tools ?? []),
    mcpCatalogRevision: mcpManager?.getToolCatalogRevision() ?? 0,
    toolStateRevision: 0,
    contextToolRevision: 0,
    sessionId: activeSessionId,
    config: configWithSignal,
    provider,
    tools,
    messages: resumedMessages,
    abortController,
    closed: false,
    pendingMessages: [],
    pendingWakeUp: null,
    activeStream: null,
    mcpManager,
    mcpServerStatuses,
    backgroundTasks,
    collaboration,
    budget: collaboration?.budget ?? executionBudget(options),
    codeSearch,
    slashCommands,
    commandRegistry,
    costSnapshot: checkpoint ? structuredClone(checkpoint.costs) : {
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalApiDurationMs: 0,
      numTurns: 0,
      tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    },
    skills: options.skills ?? skillCommands.map(command => command.name),
    skillCatalog,
    initialModel: config.model,
    exitListeners: new Set(),
    transcriptWriter,
    closeFlushPromise: null,
    startupHooks: Promise.resolve(),
    releaseOwnership,
    readFileState: checkpoint ? structuredClone(checkpoint.reads) : new Map(),
    contextState: { budget: new TokenBudget(config.contextWindow, config.maxTokens) },
  };
  if (state.toolContext) transcriptWriter?.setToolContextMode();
  if (resumedMessages.length && (options.forkSession || options.resumeSessionAt)) {
    await transcriptWriter?.writeCompactCheckpoint(resumedMessages, 'History retained at the selected session boundary.');
  }
  bindSessionCancellation(state);
  onFailure(() => state.removeAbortListener?.());

  // Startup stays advisory, but disposal must own its lifetime.
  state.startupHooks = runEventHooks(
    configWithSignal.hooks,
    'SessionStart',
    {
      hook_event_name: 'SessionStart',
      session_id: activeSessionId,
      transcript_path: getTranscriptPath(activeSessionId, configWithSignal.cwd, configWithSignal),
      cwd: configWithSignal.cwd,
      source: resumeSessionId || checkpoint ? 'resume' : 'startup',
    },
    abortController.signal,
  ).catch(error => log.warn('SessionStart hook failed', { sessionId: activeSessionId, error: String(error) }));

  const session = createSessionProxy(state);
  registerSessionCheckpoint(session, { history: () => state.messages, capture: () => {
    if (state.closed || state.activeStream || state.pendingMessages.length > 0) {
      throw new Error('Only a settled idle session can be checkpointed.');
    }
    return {
      sessionId: state.sessionId, cwd: state.config.cwd,
      messages: state.transcriptWriter?.hasCompleteHistory ? undefined : [...state.messages],
      reads: structuredClone(state.readFileState),
      costs: structuredClone(state.costSnapshot),
      tools: captureSessionToolState(state.sessionId),
    };
  } });
  abortController.signal.removeEventListener('abort', abortPreparation);
  return session;
}

// ---------------------------------------------------------------------------
// Session proxy implementation
// ---------------------------------------------------------------------------

/** Background work outlives model turns, so cancellation belongs to the session. */
function bindSessionCancellation(state: SessionState): void {
  state.removeAbortListener?.();
  const signal = state.abortController.signal;
  const stop = (): void => {
    state.backgroundTasks?.stopAll();
    void state.collaboration?.stopAll().catch(error => log.warn('Collaborator stop failed', { sessionId: state.sessionId, error: String(error) }));
  };
  signal.addEventListener('abort', stop, { once: true });
  state.removeAbortListener = () => signal.removeEventListener('abort', stop);
  if (signal.aborted) stop();
}

/**
 * Create an in-process transport shim.
 *
 * Exposes `isReady()`, `.ready`, and `onExit()` with fixed answers: there is
 * no subprocess to monitor, so the query loop is always ready and never
 * exits on its own. The host application accesses these via
 * `(session as any).query.transport`.
 */
function createTransportShim(state: SessionState) {
  return {
    /** Always true — no subprocess; the query loop is in-process. */
    isReady(): boolean {
      return !state.closed;
    },
    /** Always true — no subprocess. */
    get ready(): boolean {
      return !state.closed;
    },
    /**
     * Register a callback for "process exit". In the in-process SDK, this
     * fires when the session is closed. Returns an unsubscribe function.
     */
    onExit(callback: (error: Error | undefined) => void): () => void {
      state.exitListeners.add(callback);
      return () => {
        state.exitListeners.delete(callback);
      };
    },
  };
}

/**
 * Create a query proxy exposing transport, supportedCommands, and all
 * Query control/metadata methods. The consumer accesses these
 * via `(session as any).query.*`.
 */
/**
 * Rebuild the MCP-sourced tools in `state.tools` from the connection manager.
 *
 * Called after any dynamic MCP change (toggle / setServers). Replaces
 * previously bridged external-MCP tools with the current set, preserving
 * built-in and SDK-MCP tools that are not managed by the connection manager.
 */
function refreshMcpToolsFromManager(state: SessionState): void {
  if (!state.mcpManager) return;

  // Server names managed by the external connection manager
  const managedServerNames = new Set(state.mcpManager.serverNames());

  // Keep built-in tools + in-process SDK MCP tools (not in the external manager)
  const nonExternalTools = state.tools.filter(tool => !state.mcpManager!.ownsTool(tool));

  // Current tools from the external manager (may be empty if all disconnected)
  const freshExternal = state.mcpManager.getBridgedTools();
  assertUniqueMcpToolNames([...nonExternalTools.filter(tool => tool.mcpSource), ...freshExternal]);

  const selected = filterTools([...nonExternalTools, ...freshExternal], { disallowedTools: state.config.disallowedTools });
  state.tools.splice(0, state.tools.length, ...selected);
  state.mcpCatalogRevision = state.mcpManager.getToolCatalogRevision();
  state.toolStateRevision++;

  // Rebuild server statuses: keep non-managed entries, replace managed ones
  const nonManagedStatuses = state.mcpServerStatuses.filter(
    (s) => !managedServerNames.has(s.name),
  );
  state.mcpServerStatuses = [...nonManagedStatuses, ...state.mcpManager.getStatuses()];
}

function getSessionToolState(state: SessionState): { revision: number; tools: Tool[] } {
  const inherited = state.borrowedSource?.read();
  if (inherited && inherited.revision !== state.borrowedRevision) {
    const next = filterTools([...state.tools.filter(tool => !state.borrowedTools.has(tool)), ...inherited.tools], { disallowedTools: state.config.disallowedTools });
    assertUniqueMcpToolNames(next.filter(tool => tool.mcpSource));
    state.tools.splice(0, state.tools.length, ...next);
    state.borrowedTools = new Set(inherited.tools);
    state.borrowedRevision = inherited.revision;
    state.toolStateRevision++;
  }
  if (state.mcpManager && state.mcpManager.getToolCatalogRevision() !== state.mcpCatalogRevision) {
    refreshMcpToolsFromManager(state);
  }
  return { revision: state.toolStateRevision, tools: state.tools };
}

function createQueryProxy(state: SessionState) {
  const transport = createTransportShim(state);

  return {
    transport,

    /** Return slash commands registered in this session. */
    async supportedCommands(): Promise<SlashCommand[]> {
      return state.slashCommands;
    },

    /** Return the models the host configured for this session. */
    async supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
      return configuredModels(state.config);
    },

    /** Return MCP server connection statuses. */
    async mcpServerStatus(): Promise<typeof state.mcpServerStatuses> {
      return state.mcpServerStatuses;
    },

    /** Reconnect a named MCP server. */
    async reconnectMcpServer(serverName: string): Promise<void> {
      if (state.mcpManager) {
        await state.mcpManager.restart(serverName);
        refreshMcpToolsFromManager(state);
      }
    },

    /** Enable or disable a named MCP server. Rebuilds bridged tools. */
    async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
      if (!state.mcpManager) return;
      await state.mcpManager.toggle(serverName, enabled);
      refreshMcpToolsFromManager(state);
    },

    /** Replace the set of external MCP servers. Rebuilds bridged tools. */
    async setMcpServers(
      servers: Record<string, Record<string, unknown>>,
    ): Promise<McpSetServersResult> {
      if (!state.mcpManager) {
        return { added: [], removed: [], errors: {} };
      }
      const result = await state.mcpManager.setServers(servers);
      refreshMcpToolsFromManager(state);
      return result;
    },

    /** Stop a background task. */
    async stopTask(taskId: string): Promise<void> {
      state.backgroundTasks?.stopTask(taskId);
    },
  };
}

/**
 * Build a SlashCommandContext bound to the given session state.
 *
 * Only the fields the 14 built-in handlers (and skill prompts) need are
 * exposed — never the full SessionState. Setters mutate state directly so
 * a `/model glm-4.6` invocation, for example, takes effect on the next
 * turn just like `SDKSession.setModel`.
 */
function buildSlashCommandContext(state: SessionState): SlashCommandContext {
  return {
    sessionId: state.sessionId,
    cwd: state.config.cwd,
    model: state.config.model,
    setModel(model: string): void {
      if (model && typeof model === 'string') {
        state.config = { ...state.config, model };
      }
    },
    mcpServerStatuses: state.mcpServerStatuses.map((s) => ({
      name: s.name,
      status: s.status,
    })),
    messages: Object.freeze([...state.messages]),
    async clearMessages(): Promise<void> {
      if (state.toolContext) {
        const signal = state.config.abortSignal;
        signal.throwIfAborted();
        const seed: Message = { role: 'user', content: '', isMeta: true,
          toolContext: { version: 1, baselineAttachment: true, baseline: {
            ...state.toolContext.snapshot(), definitions: [], historicalDefinitions: undefined, discoveryEntries: false,
          } } };
        const currentTools = getSessionToolState(state);
        const nextContext = prepareToolContext(state.config, currentTools.tools, [seed]);
        if (!nextContext) throw new Error('Could not prepare cleared tool context');
        const baseline = nextContext.recoveryMessage();
        if (!baseline.content) {
          baseline.content = 'Conversation context cleared.';
          baseline.toolContext!.baselineAttachment = false;
        }
        signal.throwIfAborted();
        await state.transcriptWriter?.writeCompactCheckpoint([baseline], 'Conversation context cleared.');
        state.messages = [baseline];
        state.toolContext = nextContext;
        nextContext.baselineCommitted();
        state.contextToolRevision = currentTools.revision;
      } else state.messages = [];
      state.readFileState.clear();
      state.contextState.budget.reset();
      state.contextState.compactedHistoryTokens = undefined;
      state.contextState.deferredCompactionTokens = undefined;
    },
    async compactSession(_instructions?: string): Promise<void> {
      throw new Error('Manual /compact is not supported. Automatic context compaction remains enabled.');
    },
    getCostSnapshot(): SessionCostSnapshot {
      // Frozen shallow copy — handlers may cache it across markdown rendering.
      // The nested `tokens` object is also frozen so a misbehaving handler
      // can't mutate it back into our state.
      const snap = state.costSnapshot;
      return Object.freeze({
        totalCostUsd: snap.totalCostUsd,
        totalDurationMs: snap.totalDurationMs,
        totalApiDurationMs: snap.totalApiDurationMs,
        numTurns: snap.numTurns,
        tokens: Object.freeze({ ...snap.tokens }),
      }) as SessionCostSnapshot;
    },
    // listUserInvocable returns a frozen array per registry contract.
    commands: state.commandRegistry.listUserInvocable(),
  };
}

/**
 * Yield the synthetic system messages closing a slash command turn.
 *
 * Emits (in order):
 *   0. `system/init` — the turn-boundary signal consumers rely on to fire
 *      `onTurnInit`. Without this, the consumer's `receivedAnyEvent`
 *      stays false and `agent:complete` is never emitted (leaving the UI
 *      stuck in "thinking" state).
 *   1. `system/local_command_output` carrying the markdown payload.
 *   2. `result` event so consumers see a clean turn boundary.
 *   3. `system/session_state_changed/idle` so the consumer transitions.
 */
async function* yieldSlashCommandResult(
  state: SessionState,
  markdown: string,
  isError: boolean,
): AsyncGenerator<SDKMessage, void, undefined> {
  // Emit init — the consumer uses this to detect "a turn is starting".
  // Carry the same metadata the normal queryLoop init would (session_id,
  // slash_commands, mcp_servers) so the frontend stays in sync.
  yield {
    type: 'system',
    subtype: 'init',
    session_id: state.sessionId,
    model: state.config.model,
    cwd: state.config.cwd,
    mcp_servers: state.mcpServerStatuses ?? [],
    slash_commands: state.slashCommands.map((c) => c.name),
    uuid: randomUUID(),
  } as SDKMessage;

  yield {
    type: 'system',
    subtype: 'local_command_output',
    content: markdown,
    session_id: state.sessionId,
    uuid: randomUUID(),
  } as SDKMessage;

  if (isError) {
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      errors: [markdown],
      result: markdown,
      is_error: true,
      num_turns: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      session_id: state.sessionId,
      stop_reason: null,
      duration_ms: 0,
      duration_api_ms: 0,
      permission_denials: [],
      uuid: randomUUID(),
    } as SDKMessage;
  } else {
    yield {
      type: 'result',
      subtype: 'success',
      result: markdown,
      is_error: false,
      num_turns: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      session_id: state.sessionId,
      stop_reason: 'end_turn',
      duration_ms: 0,
      duration_api_ms: 0,
      permission_denials: [],
      uuid: randomUUID(),
    } as SDKMessage;
  }

  // Mirror the normal end-of-turn signal so consumers transition idle.
  if (!state.closed) {
    yield {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      session_id: state.sessionId,
      uuid: randomUUID(),
    } as SDKMessage;
  }
}

function createSessionProxy(state: SessionState): SDKSession {
  const queryProxy = createQueryProxy(state);

  // Build the session object with both public interface and internal properties
  // that the consumer accesses via `(session as any).xxx`.
  const session: Record<string, unknown> = {};

  // --- Internal properties (accessed via `as any` by consumer) ---

  // `(session as any).pid` — consumer uses for health monitoring.
  // In-process SDK has no subprocess; expose current process PID.
  Object.defineProperty(session, 'pid', {
    get: () => process.pid,
    enumerable: false,
  });

  // `(session as any).query` — consumer uses for transport + supportedCommands.
  Object.defineProperty(session, 'query', {
    get: () => queryProxy,
    enumerable: false,
  });

  // `(session as any).abortController` — consumer uses for session rebuild abort.
  Object.defineProperty(session, 'abortController', {
    get: () => state.abortController,
    enumerable: false,
  });

  // --- Public SDKSession interface ---

  Object.defineProperty(session, 'sessionId', {
    get: () => state.sessionId,
    enumerable: true,
  });

  session.hasPendingInput = () => state.pendingMessages.length > 0;
  session.getRuntimeStats = async (): Promise<SessionRuntimeStats> => ({
    pendingInputs: state.pendingMessages.length,
    activeCollaborators: state.collaboration?.activeCount ?? 0,
    ...(state.budget ? { sharedCostUsd: state.budget.total } : {}),
  });
  session.sendIntoLiveTurn = (message: string | Record<string, unknown>, options?: LiveInputOptions) => {
    if (state.closed) return false;
    enqueueMessage(message, options ?? {}, options?.onConsumed);
    return true;
  };

  session.withdrawUnreadInput = async (): Promise<number> => {
    const withdrawn = state.pendingMessages.filter(input => input.live);
    if (withdrawn.length === 0) return 0;
    state.pendingMessages = state.pendingMessages.filter(input => !input.live);
    for (const input of withdrawn) {
      try {
        input.live?.onWithdrawn?.();
      } catch (error) {
        log.warn('Withdrawn-input handler failed', { sessionId: state.sessionId, error: String(error) });
      }
    }
    return withdrawn.length;
  };

  session.send = async (message: string | Record<string, unknown>, options?: InputOptions): Promise<void> => {
    state.collaboration?.beginRequest();
    enqueueMessage(message, undefined, options?.onConsumed);
  };

  function enqueueMessage(message: string | Record<string, unknown>, live?: LiveInputOptions, onConsumed?: () => void): void {
    if (state.closed) {
      throw new Error('Session is closed');
    }

    // Normalize message into a pending payload (string or Message).
    // Accepted shapes:
    //   1. Plain string — "hello"
    //   2. Direct message — { role: 'user', content: "hello" | ContentBlock[] }
    //   3. SDK envelope — { type: 'user', message: { role: 'user', content: ... } }
    let payload: string | Message;

    if (typeof message === 'string') {
      payload = message;
    } else if (
      message.type === 'user' &&
      message.message &&
      typeof message.message === 'object'
    ) {
      // SDKUserMessage envelope: { type: 'user', message: MessageParam }
      const inner = message.message as Record<string, unknown>;
      const content = inner.content;
      if (typeof content === 'string') {
        payload = content;
      } else if (Array.isArray(content)) {
        // Multi-modal content blocks (images, text, etc.)
        payload = { role: 'user' as const, content: content as ContentBlock[] };
      } else {
        payload = String(content ?? '');
      }
    } else if (message.role === 'user') {
      // Direct { role: 'user', content: ... }
      const content = message.content;
      if (typeof content === 'string') {
        payload = content;
      } else if (Array.isArray(content)) {
        payload = { role: 'user' as const, content: content as ContentBlock[] };
      } else {
        payload = String(content ?? '');
      }
    } else {
      // Fallback — treat as string
      payload = typeof message === 'string' ? message : JSON.stringify(message);
    }

    state.pendingMessages.push({ payload, live, onConsumed });
    state.pendingWakeUp?.();
    state.pendingWakeUp = null;
  }

  async function preparePayload(payload: string | Message): Promise<string | Message> {
    // Fire UserPromptSubmit hook — hooks can inject additionalContext.
    // Hook always receives the text representation of the message.
    const hookText = typeof payload === 'string'
      ? payload
      : (Array.isArray(payload.content)
          ? payload.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
          : String(payload.content));

    if (state.config.hooks?.UserPromptSubmit) {
      try {
        const results = await runEventHooks(
          state.config.hooks,
          'UserPromptSubmit',
          {
            hook_event_name: 'UserPromptSubmit',
            session_id: state.sessionId,
            transcript_path: getTranscriptPath(state.sessionId, state.config.cwd, state.config),
            cwd: state.config.cwd,
            prompt: hookText,
          },
          state.abortController.signal,
        );
        const ctx = results
          .filter((r) => !('hookError' in r) && r.additionalContext)
          .map((r) => String(r.additionalContext))
          .join('\n');
        if (ctx) {
          // Inject additional context into the payload
          if (typeof payload === 'string') {
            payload = `${payload}\n\n${ctx}`;
          } else if (Array.isArray(payload.content)) {
            // Append a text block with the hook context
            payload = {
              role: 'user' as const,
              content: [
                ...payload.content,
                { type: 'text' as const, text: ctx },
              ],
            };
          } else {
            payload = `${payload.content}\n\n${ctx}`;
          }
        }
      } catch (error) {
        log.warn('UserPromptSubmit hook failed; delivering original input', { sessionId: state.sessionId, error: String(error) });
      }
    }

    return payload;
  }

  async function drainPendingPayloads(): Promise<Array<string | Message>> {
    const prepared: Array<string | Message> = [];
    while (state.pendingMessages.length > 0) {
      const batch = state.pendingMessages.splice(0);
      for (const input of batch) {
        try { input.onConsumed?.(); } catch (error) {
          log.warn('Input consumption handler failed', { sessionId: state.sessionId, error: String(error) });
        }
        prepared.push(await preparePayload(input.payload));
      }
    }
    return prepared;
  }

  session.stream = async function* stream(): AsyncGenerator<SDKMessage, void, undefined> {
      if (state.closed) {
        throw new Error('Session is closed');
      }

      // Concurrency guard: only one stream generator at a time.
      // If a previous stream is active, return it to release its query loop.
      if (state.activeStream) {
        await state.activeStream.return(undefined);
      }

      // Create and register this generator as the active stream.
      // Uses an indirection so the generator function can register itself.
      const self = collaborationStream();
      state.activeStream = self;
      try {
        yield* self;
      } finally {
        if (state.activeStream === self) {
          state.activeStream = null;
        }
      }
  };

  async function* collaborationStream(): AsyncGenerator<SDKMessage, void, undefined> {
    const signal = state.abortController.signal;
    const collaboration = state.collaboration;
    if (!collaboration) { yield* innerStream(); return; }
    for await (const message of streamCollaboration({
      collaboration, signal, closed: () => state.closed,
      run: innerStream, hasInput: () => state.pendingMessages.length > 0, prepareNext() {},
      wait: async () => {
        const revision = collaboration.revision;
        const waiting = new AbortController();
        await new Promise<void>(resolve => {
          const finish = () => {
            if (state.pendingWakeUp === finish) state.pendingWakeUp = null;
            signal.removeEventListener('abort', finish);
            waiting.abort();
            resolve();
          };
          state.pendingWakeUp = finish;
          signal.addEventListener('abort', finish, { once: true });
          void collaboration.waitForChange(revision, waiting.signal).then(finish);
          if (signal.aborted) finish();
        });
      },
    })) {
      if (message.type === 'result' && (message.num_turns > 0 || Object.keys(message.modelUsage).length > 0)) recordResultCosts(message);
      yield message;
    }
  }

  function recordResultCosts(msg: Extract<SDKMessage, { type: 'result' }>): void {
    const snap = state.costSnapshot;
    snap.totalCostUsd += msg.total_cost_usd ?? 0;
    snap.totalDurationMs += msg.duration_ms ?? 0;
    snap.totalApiDurationMs += msg.duration_api_ms ?? 0;
    snap.numTurns += 1;
    const u = msg.usage;
    if (u) {
      snap.tokens.input += u.input_tokens ?? 0;
      snap.tokens.output += u.output_tokens ?? 0;
      snap.tokens.cacheCreate += u.cache_creation_input_tokens ?? 0;
      snap.tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    }
  }

  async function* innerStream(completedTurns = 0): AsyncGenerator<SDKMessage, void, undefined> {
      // If there are no pending messages, wait until send() wakes us up or
      // the session is interrupted/closed. Without the abort listener,
      // interrupt() during idle wait would hang the stream forever.
      if (state.pendingMessages.length === 0 && !state.closed) {
        await new Promise<void>((resolve) => {
          const signal = state.abortController.signal;
          const wake = () => {
            signal.removeEventListener('abort', onAbort);
            state.pendingWakeUp = null;
            resolve();
          };
          state.pendingWakeUp = wake;
          // Also wake up on abort (interrupt/close) to avoid hanging
          const onAbort = () => {
            wake();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }

      if (state.closed) return;
      // If interrupted while waiting (abort fired but no pending message), just return.
      // interrupt() replaces the abort controller, so check if the signal that was
      // active when we started waiting was aborted AND no message arrived.
      if (state.pendingMessages.length === 0) return;

      // Protocol note: the `running` state change is emitted BEFORE
      // the pending-message drain + queryLoop init. Moving it later would
      // break the concurrent-stream guard — gen2 relies on gen1 being
      // suspended at this yield BEFORE draining, so the messages survive for
      // gen2 to pick up. The session-manager does NOT check "init is first
      // message", so this is safe. Revisit if a consumer ever depends on
      // strict init-first ordering.
      yield {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
        session_id: state.sessionId,
        uuid: randomUUID(),
      } as SDKMessage;

      // Drain all pending messages.
      // Payloads can be strings or Message objects (multi-modal).
      const pendingPayloads = await drainPendingPayloads();
      // Everything that woke this stream was withdrawn meanwhile: no turn.
      if (pendingPayloads.length === 0) {
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: state.sessionId, uuid: randomUUID() } as SDKMessage;
        return;
      }

      // ---------------------------------------------------------------
      // Slash command interception — must run BEFORE the input enters the
      // conversation history so `/clear`, `/compact`, `/init` etc. can
      // either replace or short-circuit the LLM round-trip.
      //
      // Only applies when the entire pending batch is plain text (a single
      // string payload). Multi-modal input or batched messages are forwarded
      // unchanged — slash commands are a CLI convenience, not a generic
      // routing layer.
      // ---------------------------------------------------------------
      const isSinglePlainText =
        pendingPayloads.length === 1 && typeof pendingPayloads[0] === 'string';
      if (isSinglePlainText) {
        const plain = pendingPayloads[0] as string;
        const invocation = parseSlashInvocation(plain);
        if (invocation) {
          const ctx = buildSlashCommandContext(state);
          let outcome: DispatchOutcome;
          let commandFailed = false;
          try {
            outcome = await dispatchSlashCommand(
              state.commandRegistry,
              invocation.name,
              invocation.args,
              ctx,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            commandFailed = true;
            log.warn('Slash command failed', { command: invocation.name, error: msg });
            outcome = {
              kind: 'local-result',
              command: { type: 'local', name: invocation.name, description: '' },
              result: {
                kind: 'system',
                markdown: `Error running /${invocation.name}: ${msg}`,
              },
            };
          }

          if (outcome.kind === 'local-result') {
            yield* yieldSlashCommandResult(
              state,
              outcome.result.markdown,
              commandFailed,
            );
            return;
          }
          if (outcome.kind === 'disabled') {
            yield* yieldSlashCommandResult(
              state,
              `Command /${invocation.name} is not available in this context`,
              /* isError */ true,
            );
            return;
          }
          if (outcome.kind === 'prompt-replacement') {
            // Replace the pending payloads with the prompt expansion. The
            // expanded messages take the user-input slot in the conversation.
            pendingPayloads.length = 0;
            for (const m of outcome.messages) {
              if (m.role === 'user') {
                pendingPayloads.push(m);
              }
            }
            // Fall through to normal user-message construction below.
          }
          // host-handled → fall through; the host (renderer) intercepts the
          // raw `/cmd` text on its end. The SDK forwards the input verbatim.
          // unknown → not a command; forwarded verbatim as a user message.
        }
      }

      const userMessage = mergePendingPayloads(pendingPayloads);
      if (state.toolContext?.needsBaseline) {
        const notice = state.toolContext.recoveryMessage();
        if (notice.content) {
          await state.transcriptWriter?.writeUserMessage(notice, { strict: true });
          state.messages.push(notice);
          state.toolContext.baselineCommitted();
        } else {
          userMessage.toolContext = { ...notice.toolContext!, baselineAttachment: false };
          await state.transcriptWriter?.writeUserMessage(userMessage, { strict: true });
          state.toolContext.baselineCommitted();
        }
      }
      state.messages.push(userMessage);

      // Persist user message to transcript (fire-and-forget)
      if (!userMessage.toolContext) void state.transcriptWriter?.writeUserMessage(userMessage);

      // Build the full conversation as initial messages for the query loop
      const initialMessages: Message[] = [...state.messages];

      // The system:init event is emitted on EVERY stream() call (every turn).
      // The consumer uses init as a per-turn boundary signal to create the
      // assistant placeholder message. Suppressing it on turns 2+ would break
      // the consumer's turn lifecycle (receivedAnyEvent would stay false,
      // results would not be persisted, and the consumer would exit).

      // Run the query loop, passing the session ID for consistent message session_id fields
      const assistantHistory = new AssistantHistoryRecorder(
        async (message, responseUuid) => {
          await state.transcriptWriter?.writeAssistantMessage(message.message, message.uuid,
            responseUuid ? { responseUuid, strict: true } : undefined);
        },
        message => { state.messages.push(message); },
        (message, responseUuid) => state.transcriptWriter?.writeAssistantMetadata(message, responseUuid),
      );
      let toolStateRevision = state.contextToolRevision;
      const queryOpts: QueryLoopOptions = {
        completedTurns,
        toolContext: state.toolContext,
        onContextMessage: async message => {
          await state.transcriptWriter?.writeUserMessage(message, { strict: true });
          state.messages.push(message);
        },
        getToolState: () => {
          getSessionToolState(state);
          if (toolStateRevision === state.toolStateRevision) return undefined;
          toolStateRevision = state.toolStateRevision;
          if (!state.toolContext) state.contextToolRevision = toolStateRevision;
          return [...state.tools];
        },
        onToolContextChange: context => { state.toolContext = context; state.contextToolRevision = toolStateRevision; },
        sessionId: state.sessionId,
        contextState: state.contextState,
        onCompact: async (messages, summary) => {
          const signal = state.config.abortSignal;
          signal.throwIfAborted();
          // Once written, the checkpoint must also become the live history.
          await state.transcriptWriter?.writeCompactCheckpoint(messages, summary);
        },
        onHistoryCompacted: messages => { state.messages = [...messages]; },
        onAssistantBlock: (message, responseUuid) => assistantHistory.recordBlock(message, responseUuid),
        onAssistantMessage: message => assistantHistory.recordMessage(message),
        onToolResultMessage: async message => {
          await state.transcriptWriter?.writeUserMessage(message.message, { strict: true, existingUuid: message.uuid });
          state.messages.push(message.message);
        },
        mcpServerStatuses: state.mcpServerStatuses.length > 0
          ? state.mcpServerStatuses
          : undefined,
        slashCommands: state.slashCommands.length > 0
          ? state.slashCommands.map((c) => c.name)
          : undefined,
        skills: state.skills.length > 0
          ? state.skills
          : undefined,
        skillCatalog: state.skillCatalog,
        ...(state.budget ? { onUsage: usage => state.budget!.observe(usage), getBudgetSpent: () => state.budget!.spent } : {}),
        ...(state.collaboration ? { getPendingUsage: () => state.collaboration?.drainUsage() ?? {} } : {}),
        getPendingNotices: () => state.backgroundTasks?.drainNotices() ?? [],
        getPendingUserMessage: async () => {
          const batch = await drainPendingPayloads();
          return batch.length > 0 ? mergePendingPayloads(batch) : null;
        },
        getTodoAttachment: () => buildTodoAttachment(state.sessionId),
        getPendingTodos: () => getTodos(state.sessionId),
        getGoal: () => getGoal(state.sessionId),
        drainGoalChange: () => drainGoalChange(state.sessionId),
        toolServices: state.backgroundTasks?.services,
        readFileState: state.readFileState,
      };
      const gen = queryLoop(
        state.config,
        state.provider,
        state.tools,
        initialMessages,
        queryOpts,
      );

      for await (const msg of gen) {
        if (state.closed) {
          gen.return(undefined);
          return;
        }

        if (msg.type === 'user' && !msg.parent_tool_use_id) {
          if (!msg.message.content.some(block => block.type === 'tool_result')) {
            state.messages.push(msg.message);
            void state.transcriptWriter?.writeUserMessage(msg.message);
          }
          if (msg.isReplay) continue;
        } else if (msg.type === 'result') {
          if (!state.collaboration) recordResultCosts(msg);
        }

        // init events are always forwarded — the consumer uses them as
        // per-turn boundary signals (see session-consumer.ts onTurnInit).

        yield msg;
      }

      // Emit session_state_changed: idle (turn complete)
      if (!state.closed) {
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
          session_id: state.sessionId,
          uuid: randomUUID(),
        } as SDKMessage;
      }
  }

  session.close = function close(options?: SessionCloseOptions): void {
    if (!state.closed) {
      // Fire SessionEnd hook (fire-and-forget with fresh signal — main signal is about to be aborted)
      const endHooks = runEventHooks(
        state.config.hooks,
        'SessionEnd',
        {
          hook_event_name: 'SessionEnd',
          session_id: state.sessionId,
          transcript_path: getTranscriptPath(state.sessionId, state.config.cwd, state.config),
          cwd: state.config.cwd,
          reason: 'other',
        },
        options?.signal ?? new AbortController().signal,
      ).catch(error => log.warn('SessionEnd hook failed', { sessionId: state.sessionId, error: String(error) }));

      state.closed = true;
      state.removeAbortListener?.();
      state.abortController.abort();
      // Wake up stream() if it is waiting — it will see closed=true and return.
      state.pendingWakeUp?.();
      state.pendingWakeUp = null;

      // Notify exit listeners (transport shim)
      for (const listener of state.exitListeners) {
        try {
          listener(undefined);
        } catch { /* advisory */ }
      }
      state.exitListeners.clear();

      const backgroundTasks = state.backgroundTasks;
      const collaboration = state.collaboration;
      state.collaboration = undefined;
      const codeSearch = state.codeSearch;
      state.codeSearch = undefined;
      const mcpManager = state.mcpManager;
      mcpManager?.disconnectAll();
      state.mcpManager = null;
      backgroundTasks?.dispose();
      state.backgroundTasks = null;
      // Include task terminal records queued by disposal before a resume reads them.
      state.closeFlushPromise = Promise.allSettled([
        state.activeStream?.return(undefined), state.startupHooks, endHooks, codeSearch?.dispose(), collaboration?.close(),
      ]).then(async stopped => {
        const flushed = await Promise.allSettled([
          state.transcriptWriter?.flush(), backgroundTasks?.flush(), mcpManager?.whenSettled(),
        ]);
        const stages = ['stream', 'startup hooks', 'end hooks', 'code search', 'collaboration', 'transcript', 'background tasks', 'MCP'];
        const failures = [...stopped, ...flushed].flatMap((result, index) =>
          result.status === 'rejected' ? [{ stage: stages[index], error: String(result.reason) }] : []);
        if (failures.length > 0) {
          log.warn('Session cleanup completed with failed operations', { sessionId: state.sessionId, failures });
        }
        state.messages = [];
        state.toolContext?.clear();
        state.toolContext = null;
        state.readFileState.clear();
        state.contextState.budget.reset();
        state.contextState.compactedHistoryTokens = undefined;
        state.contextState.deferredCompactionTokens = undefined;
        state.contextState.provider = undefined;
        state.pendingMessages = [];
        releaseSessionToolState(state.sessionId);
        state.releaseOwnership();
      });
      void state.closeFlushPromise.catch(error => log.warn('Session disposal failed', { sessionId: state.sessionId, error: String(error) }));



    }
  };

  session.interrupt = async function interrupt(): Promise<void> {
    state.backgroundTasks?.stopAll();
    state.abortController.abort();
    // Create a new abort controller for subsequent interactions
    state.abortController = new AbortController();
    state.config = { ...state.config, abortSignal: state.abortController.signal };
    bindSessionCancellation(state);
  };

  session.setModel = async function setModel(model: string | undefined): Promise<void> {
    // undefined resets to the session's initial model (from the
    // Options the consumer passed to createSession). We capture the original
    // model from the config that was resolved at session creation.
    const effectiveModel = model ?? state.initialModel;
    state.config = { ...state.config, model: effectiveModel };
  };

  session.setMaxThinkingTokens = async function setMaxThinkingTokens(
    maxThinkingTokens: number | null,
  ): Promise<void> {
    state.config = {
      ...state.config,
      thinking: thinkingForBudget(maxThinkingTokens, state.config.adaptiveThinking),
      thinkingExplicit: true,
    };
  };

  session.setPermissionMode = async function setPermissionMode(
    mode: PermissionMode,
  ): Promise<void> {
    state.config = { ...state.config, permissionMode: mode };
  };

  session.getGoal = function getSessionGoal(): Goal | null {
    return getGoal(state.sessionId);
  };

  session.setGoal = function setSessionGoal(goal: GoalInput | null): Goal | null {
    return setGoalFromHost(state.sessionId, goal);
  };

  session.flush = async function flush(): Promise<void> {
    // If close() has run, await the snapshot taken at close time so callers
    // see exactly the writes that were queued up to the close call.
    // Otherwise drain whatever is currently queued in the writer.
    if (state.closeFlushPromise) {
      await state.closeFlushPromise;
      return;
    }
    await Promise.all([state.transcriptWriter?.flush(), state.backgroundTasks?.flush(), state.collaboration?.flush()]);
  };

  Object.defineProperty(session, Symbol.asyncDispose, {
    value: async function dispose(): Promise<void> {
      const self = session as unknown as SDKSession;
      self.close();
      // Drain transcript writes so a follow-up `createSession({ resume })`
      // observes a complete on-disk transcript.
      await self.flush();
    },
    enumerable: false,
  });

  return session as unknown as SDKSession;
}

function mergePendingPayloads(payloads: Array<string | Message>): Message {
  if (payloads.every(payload => typeof payload === 'string' || typeof payload.content === 'string')) {
    return {
      role: 'user',
      content: payloads.map(payload => typeof payload === 'string' ? payload : payload.content).join('\n\n'),
    };
  }
  const content: ContentBlock[] = [];
  for (const payload of payloads) {
    if (typeof payload === 'string') content.push({ type: 'text', text: payload });
    else if (Array.isArray(payload.content)) content.push(...payload.content);
    else content.push({ type: 'text', text: payload.content });
  }
  return { role: 'user', content };
}
