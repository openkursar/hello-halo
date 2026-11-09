/**
 * @module agent-sdk
 * Public entry point for the Agent SDK.
 *
 * Provides: query(), createSession(), unstable_v2_createSession(),
 * and all public types.
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Core runtime
// ---------------------------------------------------------------------------

export { getBuiltinSkillDefinitions } from './skills/index.js';
export type { BuiltinSkillDefinition, SkillCatalog, SkillEntry, SkillMetadata, SkillSource } from './skills/index.js';
export { createSession } from './core/session.js';
export type { SDKSession, SessionCloseOptions, SessionRuntimeStats } from './core/session.js';
export { queryLoop } from './core/query-loop.js';
export type { SDKMessage, QueryLoopOptions, MutableConfigOverrides } from './core/query-types.js';
export { CostTracker } from './core/cost.js';
export type { ModelUsageEntry, ModelPricing, ModelPricingTable } from './core/cost.js';
export { TokenBudget } from './core/token-budget.js';
export { resolveQueryConfig } from './core/context.js';
export { resolvePromptProfile } from './prompt/profiles/index.js';
export type { PromptProfile } from './prompt/profiles/index.js';
export type { PromptProfileId, PromptProfileSelection } from './types/config.js';
export {
  microCompact,
  apiCompact,
  autoCompactIfNeeded,
  fullCompact,
  AutoCompactState,
  formatCompactSummary,
  getCompactPrompt,
} from './core/compact.js';
export {
  runHooks,
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  runEventHooks,
} from './core/hooks.js';
export type {
  PreToolUseHookResult,
  PostToolUseHookResult,
} from './core/hooks.js';

// ---------------------------------------------------------------------------
// Slash command registry — built-in commands + caller-extensible registry
// ---------------------------------------------------------------------------

export {
  BUILT_IN_COMMANDS,
  BUILT_IN_COMMAND_NAMES,
  CommandRegistry,
  buildSessionRegistry,
  createSessionRegistry,
  filterUserInvocable,
  getBuiltInCommands,
  getCommandName,
  globalRegistry,
  isCommand,
  isCommandEnabled,
  listUserInvocableNames,
  listUserInvocableSlashCommands,
  normalizeUserCommands,
  resolveCommand,
  toSlashCommand,
  toSlashCommandList,
} from './commands/index.js';
export type {
  Command,
  CommandBase,
  CommandKind,
  CommandSource,
  LocalCommand,
  PromptCommand,
} from './commands/index.js';

// ---------------------------------------------------------------------------
// Tool calling adapter for non-native-tool-calling models
// ---------------------------------------------------------------------------

export { PromptToolCallingAdapter } from './llm/tool-calling/index.js';
export { resolveToolCallingMode, detectModelFamily } from './llm/tool-calling/index.js';
export { renderToolsBlock } from './llm/tool-calling/index.js';
export { parseXmlToolCalls } from './llm/tool-calling/index.js';
export type { ToolCallingMode, ModelFamily, ModelAdapter } from './llm/tool-calling/types.js';

// ---------------------------------------------------------------------------
// query() — the primary public API
// ---------------------------------------------------------------------------

import { getLogger } from './utils/logger.js';
import type {
  Options,
  PermissionMode,
  SlashCommand,
  ModelInfo,
  AccountInfo,
  McpServerStatus,
  McpSetServersResult,
  SDKControlInitializeResponse,
} from './types/config.js';
import type { Tool } from './types/tool.js';
import { createSession } from './core/session.js';
import type { SessionRuntimeStats } from './core/session.js';
import { queryLoop } from './core/query-loop.js';
import { prepareToolContext } from './core/tool-context/index.js';
import { loadResumeHistory } from './core/resume-history.js';
export { readSessionToolContextMode } from './core/session-tool-context.js';
export type { ReadSessionToolContextModeOptions, SessionToolContextMode } from './core/session-tool-context.js';
import type { SDKMessage, QueryLoopOptions, MutableConfigOverrides } from './core/query-types.js';
import type { SDKUserMessage } from './core/query-types.js';
import { configuredModels, resolveQueryConfig } from './core/context.js';
import { filterTools } from './tools/registry.js';
import { configuredBuiltInTools, borrowedMcpSource, bindBorrowedToolSource } from './core/tool-selection.js';
import { prepareCodeSearch, bindCodeSearchBridge } from './core/code-search.js';
import { resolveSkillCatalog, type SkillCatalog } from './skills/index.js';
import { extractSdkMcpTools, bridgeSdkMcpTools, assertUniqueMcpToolNames, McpToolIdentityError } from './tools/mcp/bridge.js';
import { createSdkCollaboration, localCollaborationSettings, appendCollaborationPrompt } from './collaboration/sdk/index.js';
import { COLLABORATION_GUIDANCE } from './collaboration/guidance.js';
import { AssistantHistoryRecorder } from './core/assistant-history.js';
import { bindReadDenyFloor } from './core/read-policy.js';
import { streamCollaboration } from './collaboration/sdk/stream.js';
import type { McpServerConnectionStatus } from './tools/mcp/bridge.js';
import {
  McpConnectionManager,
  createMcpConnectionManager,
} from './tools/mcp/connection-manager.js';
import { createSessionBackgroundTasks } from './core/background-tasks.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { PromptToolCallingAdapter } from './llm/tool-calling/index.js';
import { releaseSessionToolState } from './tools/session-state.js';
import { configureSessionStorage } from './tools/session-storage.js';
import { buildTodoAttachment, getTodos } from './tools/todo-write/index.js';
import { drainGoalChange, getGoal, setGoalFromHost } from './tools/goal/index.js';
import type { Goal, GoalInput } from './types/goal.js';
import {
  buildSessionRegistry,
  dispatchSlashCommand,
  listUserInvocableNames,
  listUserInvocableSlashCommands,
  loadSkillCommands,
  parseSlashInvocation,
  type CommandRegistry,
  type DispatchOutcome,
  type SessionCostSnapshot,
  type SlashCommandContext,
} from './commands/index.js';
import type { Message } from './types/provider.js';

const log = getLogger('SDK');

/** Auto-create a provider from options.env or process.env when options.provider is omitted. */
function resolveProvider(options: Options) {
  if (options.provider) return options.provider;
  const env = options.env as Record<string, string | undefined> | undefined;
  // Support convenience alias fields: options.apiKey / options.anthropicBaseUrl
  const apiKey = options.apiKey ?? env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl = options.anthropicBaseUrl ?? env?.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;
  if (!apiKey) {
    throw new Error(
      'query() requires options.provider, options.apiKey, or ANTHROPIC_API_KEY in env.',
    );
  }
  const requestIdentity = options.requestIdentity as import('./llm/request-identity.js').RequestIdentity | undefined;
  return new AnthropicProvider({ apiKey, baseUrl, requestIdentity });
}

/**
 * Project the registry's user-invocable subset into the
 * {@link SlashCommandContext.commands} shape. The dispatcher already
 * re-applies `filterUserInvocable` when running a command — this is the
 * read-only view that handlers like `/help` enumerate.
 */
function listUserInvocableSlashCommandsForCtx(
  registry: CommandRegistry,
): SlashCommandContext['commands'] {
  return registry.listUserInvocable();
}

/**
 * Yield the system + result events that close out a slash command turn
 * inside the top-level `query()` generator. Compared with
 * `yieldSlashCommandResult` in session.ts, this variant omits the
 * `session_state_changed` event (single-turn `query()` has no such state
 * transitions to broadcast).
 */
async function* yieldQuerySlashResult(
  sessionId: string,
  markdown: string,
  isError: boolean,
): AsyncGenerator<SDKMessage, void, undefined> {
  yield {
    type: 'system',
    subtype: 'local_command_output',
    content: markdown,
    session_id: sessionId,
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
      session_id: sessionId,
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
      session_id: sessionId,
      stop_reason: 'end_turn',
      duration_ms: 0,
      duration_api_ms: 0,
      permission_denials: [],
      uuid: randomUUID(),
    } as SDKMessage;
  }
}

/**
 * The Query object — an AsyncGenerator<SDKMessage> with additional
 * control methods for mid-stream interaction.
 *
 * The Query object returned by the `query()` function.
 */
export interface Query extends AsyncGenerator<SDKMessage, void, undefined> {
  /** Execution-owned task counts, without task contents. */
  getRuntimeStats(): Promise<SessionRuntimeStats>;
  /** Interrupt the current query. */
  interrupt(): Promise<void>;
  /** Change the permission mode mid-conversation. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Change the model mid-conversation. */
  setModel(model?: string): Promise<void>;
  /** Change max thinking tokens mid-conversation. */
  setMaxThinkingTokens(n: number | null): Promise<void>;
  /** Get the full initialization response. */
  initializationResult(): Promise<SDKControlInitializeResponse>;
  /** Get available slash commands. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Get available models. */
  supportedModels(): Promise<ModelInfo[]>;
  /** Get MCP server connection statuses. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Get account info for the authenticated user. */
  accountInfo(): Promise<AccountInfo>;
  /** Reconnect a specific MCP server by name. */
  reconnectMcpServer(serverName: string): Promise<void>;
  /** Turn a named MCP server on or off. */
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  /** Replace the set of dynamic MCP servers. */
  setMcpServers(servers: Record<string, unknown>): Promise<McpSetServersResult>;
  /** Stop a running background task. */
  stopTask(taskId: string): Promise<void>;
  /** The goal of this query (active or finished), or null when none is set. */
  getGoal(): Goal | null;
  /**
   * Replace the goal on the user's behalf, or clear it with null. The model
   * is told at the start of its next turn.
   *
   * @throws TypeError when the objective is missing or blank.
   */
  setGoal(goal: GoalInput | null): Goal | null;
  /** Close the query and stop its background tasks. */
  close(): void;
  /**
   * Rejects additional input: query() is a one-shot API. Use
   * createSession().send() or sendIntoLiveTurn() for subsequent messages.
   */
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
}

/**
 * The main entry point for the Agent SDK.
 *
 * Starts a new agentic query that runs the ReAct loop against the LLM.
 * Returns a Query object (AsyncGenerator<SDKMessage>) that yields events
 * as they are produced.
 *
 * Returns a Query object (AsyncGenerator<SDKMessage>) compatible with the standard query signature.
 *
 * @example
 * ```ts
 * import { query } from '@hello-halo/agent-sdk';
 *
 * const q = query({
 *   prompt: 'Write a hello world function',
 *   options: { model: 'deepseek-chat', provider: myProvider }
 * });
 *
 * for await (const msg of q) {
 *   console.log(msg.type, msg);
 * }
 * ```
 */
export function query(params: {
  prompt: string | AsyncIterable<{ role: 'user'; content: string }>;
  options?: Options;
}): Query {
  const { prompt, options = {} } = params;

  // bypassPermissions and allowDangerouslySkipPermissions are independent OR'd
  // switches — either alone bypasses permission checks.

  // Resolve provider — explicit or auto-created from env
  const baseProvider = resolveProvider(options);

  // Resolve config
  const config = resolveQueryConfig(options);

  // Wrap with adapter when the resolved mode is not native.
  const provider = config.toolCallingMode !== 'native'
    ? new PromptToolCallingAdapter(baseProvider, config.toolCallingMode)
    : baseProvider;
  log.info('tool-calling', { model: config.model, mode: config.toolCallingMode });
  const abortController = options.abortController ?? new AbortController();
  const configWithSignal = { ...config, abortSignal: abortController.signal };

  // Shared mutable config overrides for Query control methods
  const configOverrides: MutableConfigOverrides = {};

  // Build tool list (built-in + custom + MCP SDK tools)
  const codeSearch = prepareCodeSearch(options);
  const builtIns = configuredBuiltInTools(options, codeSearch ? [codeSearch.tool] : []);
  let tools: Tool[];
  if (options.customTools && options.customTools.length > 0) {
    const customToolNames = new Set(options.customTools.map((t) => t.name));
    const builtInTools = builtIns.filter((t) => !customToolNames.has(t.name));
    tools = [...builtInTools, ...options.customTools];
  } else {
    tools = builtIns;
  }

  // Bridge SDK MCP server tools into the tool list
  const mcpTools = extractSdkMcpTools(
    options.mcpServers as Record<string, unknown> | undefined,
  );
  if (mcpTools.length > 0) {
    const mcpToolNames = new Set(mcpTools.map((t) => t.name));
    tools = tools.filter((t) => !mcpToolNames.has(t.name));
    tools.push(...mcpTools);
  }

  tools = filterTools(tools, {
    disallowedTools: config.disallowedTools,
  });


  // Wrap in an async generator that connects external MCP servers first,
  // then runs the query loop, and disconnects on cleanup.
  const mcpServersConfig = options.mcpServers as Record<string, unknown> | undefined;

  // Collect SDK MCP server statuses (in-process — always connected)
  const mcpStatuses: McpServerConnectionStatus[] = [];
  if (mcpServersConfig) {
    for (const [name, cfg] of Object.entries(mcpServersConfig)) {
      if (cfg && typeof cfg === 'object' && (cfg as Record<string, unknown>).type === 'sdk') {
        mcpStatuses.push({ name, status: 'connected' });
      }
    }
  }

  // Shell processes belong to this query, independent of collaborator sessions.
  const querySessionId = randomUUID();
  let observedMcpRevision = -1;
  let toolPoolRevision = 0;
  const currentToolState = (): { revision: number; tools: Tool[] } => {
    if (mcpManager.getToolCatalogRevision() !== observedMcpRevision) {
      syncToolsFromManager(tools, mcpManager, config.disallowedTools);
      observedMcpRevision = mcpManager.getToolCatalogRevision();
      toolPoolRevision++;
    }
    return { revision: toolPoolRevision, tools };
  };
  const backgroundTasks = createSessionBackgroundTasks({
    config: configWithSignal,
    sessionId: querySessionId,
    persistSession: options.persistSession,
  });
  const pendingCollaborationMessages: string[] = [];
  const shareMcp = borrowedMcpSource(currentToolState);
  const collaborationSettings = localCollaborationSettings(options);
  const collaboration = collaborationSettings === false ? undefined : createSdkCollaboration({
    sessionId: querySessionId, settings: collaborationSettings,
    getOptions: () => {
      const shared = shareMcp();
      const current: Options = {
        ...options, provider: baseProvider, model: configOverrides.model ?? config.model,
        permissionMode: (configOverrides.permissionMode as PermissionMode | undefined) ?? config.permissionMode,
        maxBudgetUsd: config.maxBudgetUsd, maxTurns: config.maxTurns,
        toolResultBudget: config.toolResultBudget, toolDiscovery: config.toolDiscovery,
        mcpServers: {},
        customTools: [
          ...(options.customTools ?? []).filter(tool => !tool.mcpSource),
          ...shared.tools,
        ],
      };
      bindBorrowedToolSource(current, { read: shareMcp, initial: shared.tools });
      bindReadDenyFloor(current, config.readDenyRoots);
      if (codeSearch) bindCodeSearchBridge(current, codeSearch.borrow());
      return current;
    },
    deliverToSource: async envelope => { pendingCollaborationMessages.push(envelope.body); return 'buffered'; },
  });
  if (collaboration) {
    tools = filterTools([...tools, ...bridgeSdkMcpTools(collaboration.server)], { disallowedTools: config.disallowedTools });
    if (tools.some(tool => tool.name === 'mcp__halo-team__spawn_agent')) {
      configWithSignal.systemPrompt = appendCollaborationPrompt(configWithSignal.systemPrompt, COLLABORATION_GUIDANCE)!;
    }
    mcpStatuses.push({ name: 'halo-team', status: 'connected' });
  }

  // Hoist the MCP manager so Query control methods (toggleMcpServer/setMcpServers)
  // can mutate it between turns while the generator is running.
  const mcpManager = createMcpConnectionManager(
    mcpServersConfig,
    options.onElicitation ? { onElicitation: options.onElicitation } : undefined,
  );

  configureSessionStorage(querySessionId, config, options.persistSession !== false);
  if (options.goal) setGoalFromHost(querySessionId, options.goal);

  // Per-query slash command registry: SDK built-ins + skills overlay + caller overlay.
  //
  // Skills (filesystem + bundled) are loaded the same way `createSession` does
  // so that the top-level `query()` path surfaces an identical command set.
  // A malformed skill must NOT break query setup — wrap in try/catch.
  let querySkillCommands: ReturnType<typeof loadSkillCommands> = [];
  let skillCatalog: SkillCatalog = [];
  try {
    if (tools.some((tool) => tool.name === 'Skill')) {
      skillCatalog = resolveSkillCatalog(config);
    }
    querySkillCommands = loadSkillCommands({
      enabled: tools.some((tool) => tool.name === 'Skill'),
      cwd: config.cwd,
      env: config.env,
      conventions: config.conventions,
      skillCatalog,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('query: failed to load skill commands', { err: msg });
  }
  const commandRegistry: CommandRegistry = buildSessionRegistry({
    user: options.slashCommands,
    skills: querySkillCommands,
  });

  let disposing: Promise<void> | undefined;
  const disposeQuery = (): Promise<void> => disposing ??= (async () => {
    backgroundTasks.dispose();
    mcpManager.disconnectAll();
    const outcomes = await Promise.allSettled([collaboration?.close(), backgroundTasks.flush(), mcpManager.whenSettled(), codeSearch?.dispose()]);
    releaseSessionToolState(querySessionId, { discardPersisted: true });
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') log.warn('Query resource disposal failed', { sessionId: querySessionId, stage: index, error: String(outcome.reason) });
    });
  })();

  const execution = async function* (): AsyncGenerator<SDKMessage, void, undefined> {
    // Connect external MCP servers via connection manager (with reconnection support)
    try {
      await mcpManager.connectAll();
      const extTools = mcpManager.getBridgedTools();
      assertUniqueMcpToolNames([...mcpTools, ...extTools]);
      if (extTools.length > 0) {
        const extToolNames = new Set(extTools.map((t) => t.name));
        const retained = tools.filter(t => !extToolNames.has(t.name));
        tools.splice(0, tools.length, ...retained, ...extTools);
      }
      const selected = filterTools(tools, { disallowedTools: config.disallowedTools });
      if (selected !== tools) tools.splice(0, tools.length, ...selected);
      // Merge external server statuses
      mcpStatuses.push(...mcpManager.getStatuses());
    } catch (err: unknown) {
      if (err instanceof McpToolIdentityError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('external MCP connection error', { err: msg });
    }

    // Build the per-query slash command registry (built-ins + caller overlay)
    const slashCommandNames = listUserInvocableNames(commandRegistry);
    let queryToolRevision = currentToolState().revision;

    const queryOpts: QueryLoopOptions = {
      ...(collaboration ? {
        onUsage: usage => collaboration.budget.observe(usage),
        getBudgetSpent: () => collaboration.budget.spent,
        getPendingUsage: () => collaboration.drainUsage(),
      } : {}),
      skillCatalog,
      sessionId: querySessionId,
      mcpServerStatuses: mcpStatuses.length > 0 ? mcpStatuses : undefined,
      slashCommands: slashCommandNames.length > 0 ? slashCommandNames : undefined,
      skills: options.skills && options.skills.length > 0 ? options.skills : undefined,
      configOverrides,
      getToolState: () => {
        const current = currentToolState();
        if (current.revision === queryToolRevision) return undefined;
        queryToolRevision = current.revision;
        return [...current.tools];
      },
      getPendingNotices: () => backgroundTasks.drainNotices(),
      getTodoAttachment: () => buildTodoAttachment(querySessionId),
      getPendingTodos: () => getTodos(querySessionId),
      getGoal: () => getGoal(querySessionId),
      drainGoalChange: () => drainGoalChange(querySessionId),
      toolServices: backgroundTasks.services,
    };

    // continue/resume: load prior conversation history from transcript
    let resumeSessionId = options.resume as string | undefined;
    if (options.continue && !resumeSessionId) {
      const projectDir = dirname(getTranscriptPath('__placeholder__', config.cwd, config));
      try {
        const files = await readdir(projectDir);
        let latestMtime = 0;
        let latestId: string | null = null;
        for (const file of files) {
          if (!file.endsWith('.jsonl') || file.startsWith('.') || file.startsWith('agent-')) continue;
          try {
            const { mtimeMs } = await stat(join(projectDir, file));
            if (mtimeMs > latestMtime) { latestMtime = mtimeMs; latestId = file.slice(0, -'.jsonl'.length); }
          } catch { /* skip unreadable files */ }
        }
        if (latestId) {
          resumeSessionId = latestId;
          log.info('query continue: resuming session', { sessionId: latestId });
        }
      } catch { /* no project dir or unreadable */ }
    }

    const resumedMessages = resumeSessionId
      ? await loadResumeHistory({
          sessionId: resumeSessionId, cwd: config.cwd, stopAtMessageUuid: options.resumeSessionAt,
          options: config, strict: options.strictResume === true,
        })
      : null;
    queryOpts.toolContext = prepareToolContext(config, tools, resumedMessages ?? [], !!resumedMessages?.length);
    queryOpts.onToolContextChange = context => { queryOpts.toolContext = context; };

    const stopBackgroundWork = (): void => {
      backgroundTasks.stopAll();
      void collaboration?.stopAll().catch(error => log.warn('Collaborator stop failed', { error: String(error) }));
    };
    try {
      abortController.signal.addEventListener('abort', stopBackgroundWork, { once: true });
      if (abortController.signal.aborted) stopBackgroundWork();
      // Extract the text prompt — either from a string or the first item of an AsyncIterable
      let textPrompt: string;
      if (typeof prompt === 'string') {
        textPrompt = prompt;
      } else {
        textPrompt = '';
        for await (const msg of prompt) {
          textPrompt = typeof msg.content === 'string' ? msg.content : String(msg.content);
          break;
        }
        if (!textPrompt) return;
      }

      // -----------------------------------------------------------------
      // Slash command interception (same logic as the stream() path in session.ts).
      //
      // Single-turn query() has no resident history or successor turn for
      // clearMessages / setModel to mutate. Manual compaction is rejected.
      //
      // Outcomes:
      //   - local-result        → yield system + result, return (skip LLM)
      //   - prompt-replacement  → swap textPrompt, fall through to queryLoop
      //   - disabled            → yield error system + result, return
      //   - unknown / host-handled → fall through unchanged
      // -----------------------------------------------------------------
      const invocation = parseSlashInvocation(textPrompt);
      if (invocation) {
        const slashCtx: SlashCommandContext = {
          sessionId: querySessionId,
          cwd: configWithSignal.cwd,
          model: configWithSignal.model ?? '',
          setModel: () => {
            // Single-turn query: model switching has no successor turn.
          },
          mcpServerStatuses: mcpStatuses.map((s) => ({
            name: s.name,
            status: s.status,
          })),
          messages: (resumedMessages ?? []) as readonly Message[],
          clearMessages: () => {
            // Single-turn query: no resident history to clear.
          },
          compactSession: async () => {
            throw new Error('Manual /compact is not supported. Automatic context compaction remains enabled.');
          },
          getCostSnapshot: (): SessionCostSnapshot =>
            Object.freeze({
              totalCostUsd: 0,
              totalDurationMs: 0,
              totalApiDurationMs: 0,
              numTurns: 0,
              tokens: Object.freeze({
                input: 0,
                output: 0,
                cacheCreate: 0,
                cacheRead: 0,
              }),
            }) as SessionCostSnapshot,
          commands: listUserInvocableSlashCommandsForCtx(commandRegistry),
        };

        let outcome: DispatchOutcome;
        let commandFailed = false;
        try {
          outcome = await dispatchSlashCommand(
            commandRegistry,
            invocation.name,
            invocation.args,
            slashCtx,
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
          yield* yieldQuerySlashResult(
            querySessionId,
            outcome.result.markdown,
            commandFailed,
          );
          return;
        }
        if (outcome.kind === 'disabled') {
          yield* yieldQuerySlashResult(
            querySessionId,
            `Command /${invocation.name} is not available in this context`,
            /* isError */ true,
          );
          return;
        }
        if (outcome.kind === 'prompt-replacement') {
          // Replace the user's `/cmd …` input with the prompt expansion's
          // first user-message text content. Single-turn query() does not
          // accept multi-message replacements; we take the first user
          // message and concatenate any additional ones with blank lines.
          const userMessages = outcome.messages.filter((m) => m.role === 'user');
          if (userMessages.length > 0) {
            textPrompt = userMessages
              .map((m) =>
                typeof m.content === 'string'
                  ? m.content
                  : m.content
                      .map((b) => (b.type === 'text' ? b.text : ''))
                      .join(''),
              )
              .join('\n\n');
          }
          // Fall through to the normal query loop below.
        }
        // host-handled → fall through with the original textPrompt unchanged.
      }

      if (collaboration) {
        let history: Message[] = [...(resumedMessages ?? []), { role: 'user', content: textPrompt }];
        if (queryOpts.toolContext?.needsBaseline) {
          const notice = queryOpts.toolContext.recoveryMessage();
          const hasToolContext = history.some(message => message.toolContext);
          if (!notice.content && !hasToolContext) {
            history[0] = { ...history[0], toolContext: { ...notice.toolContext!, baselineAttachment: false } };
          } else if (hasToolContext) {
            history.push(notice);
          } else {
            history.unshift(notice);
          }
          queryOpts.toolContext.baselineCommitted();
        }
        queryOpts.onContextMessage = message => { history.push(message); };
        const recorder = new AssistantHistoryRecorder(() => {}, message => history.push(message));
        queryOpts.onAssistantBlock = (message, responseUuid) => recorder.recordBlock(message, responseUuid);
        queryOpts.onAssistantMessage = message => recorder.recordMessage(message);
        queryOpts.onToolResultMessage = message => { history.push(message.message); };
        queryOpts.onHistoryCompacted = messages => { history = [...messages]; };
        const takeInput = (): Message | null => {
          if (!pendingCollaborationMessages.length) return null;
          const input: Message = { role: 'user', content: pendingCollaborationMessages.splice(0).join('\n\n') };
          history.push(input);
          return input;
        };
        queryOpts.getPendingUserMessage = async () => takeInput();
        yield* streamCollaboration({
          collaboration, signal: abortController.signal,
          run: completedTurns => queryLoop(configWithSignal, provider, tools, history, { ...queryOpts, completedTurns }),
          hasInput: () => pendingCollaborationMessages.length > 0,
          prepareNext: () => { takeInput(); },
          wait: () => collaboration.waitForChange(collaboration.revision, abortController.signal),
        });
      } else if (resumedMessages && resumedMessages.length > 0) {
        // Resume: pass prior history + new user message to query loop
        const initialMessages = [
          ...resumedMessages,
          { role: 'user' as const, content: textPrompt },
        ];
        yield* queryLoop(configWithSignal, provider, tools, initialMessages, queryOpts);
      } else {
        yield* queryLoop(configWithSignal, provider, tools, textPrompt, queryOpts);
      }
    } finally {
      abortController.signal.removeEventListener('abort', stopBackgroundWork);
    }
  };
  const gen = (async function* (): AsyncGenerator<SDKMessage, void, undefined> {
    try { yield* execution(); }
    finally { await disposeQuery(); }
  })();

  // Capture metadata for Query control methods.
  // slashCommands carries the user-invocable subset of the registry, projected
  // to wire format — name / description / argumentHint.
  const queryMeta: QueryMetadata = {
    slashCommands: listUserInvocableSlashCommands(commandRegistry),
    mcpStatuses: mcpStatuses as unknown as McpServerStatus[],
    config: configWithSignal,
  };

  const streamInputImpl = async (): Promise<void> => {
    log.warn('query.streamInput rejected: one-shot queries do not consume additional input');
    throw new Error('query.streamInput() is not supported. Use createSession().send() or sendIntoLiveTurn() for additional input.');
  };

  // ---------------------------------------------------------------------------
  const queryExtras: QueryExtras = {
    dispose: disposeQuery,
    getRuntimeStats: () => ({ pendingInputs: pendingCollaborationMessages.length, activeCollaborators: collaboration?.activeCount ?? 0,
      ...(collaboration ? { sharedCostUsd: collaboration.budget.total } : {}) }),
    streamInputImpl,
    stopTask: (taskId) => backgroundTasks.stopTask(taskId),
    stopAll: () => backgroundTasks.stopAll(),
    getGoal: () => getGoal(querySessionId),
    setGoal: (goal) => setGoalFromHost(querySessionId, goal),
  };

  return wrapGeneratorAsQuery(gen, abortController, configOverrides, queryMeta, mcpManager, tools, queryExtras);
}

/** Internal metadata bag for Query control methods. */
interface QueryMetadata {
  slashCommands: SlashCommand[];
  mcpStatuses: McpServerStatus[];
  config: import('./types/config.js').QueryConfig;
}

/**
 * Synchronize external MCP tools from the connection manager into a mutable
 * tools array. Removes stale manager-owned tools and appends current ones.
 * In-process (SDK) MCP tools are left untouched.
 */
function syncToolsFromManager(tools: Tool[], mgr: McpConnectionManager, disallowed: readonly string[] = []): void {
  const retained = tools.filter(tool => !mgr.ownsTool(tool));
  const current = mgr.getBridgedTools();
  assertUniqueMcpToolNames([...retained.filter(tool => tool.mcpSource), ...current]);
  const next = filterTools([...retained, ...current], { disallowedTools: [...disallowed] });
  tools.splice(0, tools.length, ...next);
}

/** Extra per-query callbacks that cannot be derived from generic metadata. */
interface QueryExtras {
  dispose(): Promise<void>;
  getRuntimeStats: () => SessionRuntimeStats;
  streamInputImpl: (stream: AsyncIterable<SDKUserMessage>) => Promise<void>;
  /** Stops a background task owned by this query. */
  stopTask: (taskId: string) => void;
  stopAll: () => void;
  getGoal: () => Goal | null;
  setGoal: (goal: GoalInput | null) => Goal | null;
}

/**
 * Wrap an AsyncGenerator<SDKMessage> with Query control methods.
 * Control methods write to the shared `overrides` object which the
 * query loop reads at the start of each turn.
 *
 * @param mcpManager - Optional external MCP connection manager to expose
 *   via toggleMcpServer / setMcpServers. When provided, dynamic MCP changes
 *   are applied to the manager and take effect on the next tool lookup.
 * @param toolsRef - Mutable tools array shared with the generator closure.
 *   Dynamic MCP changes update this array in-place.
 * @param extras - Optional per-query overrides for streamInput / rewindFiles.
 */
function wrapGeneratorAsQuery(
  gen: AsyncGenerator<SDKMessage, void, undefined>,
  abortController: AbortController,
  overrides: MutableConfigOverrides,
  meta: QueryMetadata,
  mcpManager: McpConnectionManager | undefined,
  toolsRef: Tool[] | undefined,
  extras: QueryExtras,
): Query {
  const query = gen as Query;
  const finish = gen.return.bind(gen);
  query.return = async value => {
    abortController.abort();
    try { return await finish(value); }
    finally { await extras.dispose(); }
  };
  query.getRuntimeStats = async () => extras.getRuntimeStats();

  query.interrupt = async () => {
    abortController.abort();
    extras.stopAll();
  };

  query.setPermissionMode = async (mode: PermissionMode) => {
    overrides.permissionMode = mode;
  };

  query.setModel = async (model?: string) => {
    overrides.model = model ?? meta.config.model;
  };

  query.setMaxThinkingTokens = async (n: number | null) => {
    overrides.maxThinkingTokens = n;
  };

  query.supportedCommands = async () => meta.slashCommands;

  query.supportedModels = async () => configuredModels(meta.config);

  query.mcpServerStatus = async () => {
    if (mcpManager) {
      // Live statuses from the external MCP manager (updates after reconnects/failures).
      const liveStatuses = mcpManager.getStatuses() as unknown as McpServerStatus[];
      // SDK MCP servers (in-process, always connected) are tracked in meta.mcpStatuses
      // but are NOT managed by mcpManager — keep them, replace external server entries.
      const managedNames = new Set(liveStatuses.map((s) => s.name));
      const sdkOnlyStatuses = meta.mcpStatuses.filter((s) => !managedNames.has(s.name));
      return [...sdkOnlyStatuses, ...liveStatuses];
    }
    return meta.mcpStatuses;
  };

  query.accountInfo = async () => ({
    apiKeySource: 'user',
  });

  query.reconnectMcpServer = async (serverName: string) => {
    if (mcpManager) {
      await mcpManager.restart(serverName);
      // Sync updated tools into the shared tools array (in-place splice)
      if (toolsRef) syncToolsFromManager(toolsRef, mcpManager, meta.config.disallowedTools);
    }
  };

  query.toggleMcpServer = async (serverName: string, enabled: boolean) => {
    if (mcpManager) {
      await mcpManager.toggle(serverName, enabled);
      if (toolsRef) syncToolsFromManager(toolsRef, mcpManager, meta.config.disallowedTools);
    }
  };

  query.setMcpServers = async (servers: Record<string, Record<string, unknown>>) => {
    if (!mcpManager) return { added: [], removed: [], errors: {} };
    const result = await mcpManager.setServers(servers);
    if (toolsRef) syncToolsFromManager(toolsRef, mcpManager, meta.config.disallowedTools);
    return result;
  };

  query.stopTask = async (taskId: string) => {
    extras?.stopTask?.(taskId);
  };

  query.getGoal = () => extras.getGoal();

  query.setGoal = (goal: GoalInput | null) => extras.setGoal(goal);

  query.initializationResult = async () => ({
    commands: meta.slashCommands,
    models: await query.supportedModels(),
    accountInfo: await query.accountInfo(),
    mcpServers: meta.mcpStatuses,
  });

  query.close = () => {
    abortController.abort();
    extras.stopAll();
    void gen.return(undefined).catch(error => log.warn('Query disposal failed', { error: String(error) }));
  };

  query.streamInput = extras.streamInputImpl;

  return query;
}

// ---------------------------------------------------------------------------
// unstable_v2_createSession — compatibility alias
// ---------------------------------------------------------------------------

/**
 * Alias for createSession() — exported under the legacy function name
 * `unstable_v2_createSession()` for zero-change compatibility with
 * existing consumer code.
 */
export const unstable_v2_createSession = createSession;

/**
 * Send a single prompt and collect the full result.
 *
 * Convenience wrapper: creates a disposable session, sends the message,
 * streams until a `result` message arrives, then closes the session.
 *
 * Signature: `unstable_v2_prompt(message, options): Promise<SDKResultMessage>`
 */
export async function unstable_v2_prompt(
  message: string,
  options: Options,
): Promise<Record<string, unknown>> {
  const session = await createSession(options);
  try {
    await session.send(message);
    for await (const msg of session.stream()) {
      if (msg.type === 'result') {
        return msg as unknown as Record<string, unknown>;
      }
    }
    // Stream ended without a result message — should not happen
    throw new Error('Stream completed without a result message');
  } finally {
    session.close();
  }
}

/**
 * Resume a previous session by its session ID.
 *
 * Creates a session with the supplied `sessionId` and loads conversation
 * history from the transcript file on disk.
 *
 * Signature: `unstable_v2_resumeSession(sessionId, options): Promise<SDKSession>`
 */
export async function unstable_v2_resumeSession(
  sessionId: string,
  options: Parameters<typeof createSession>[0],
): ReturnType<typeof createSession> {
  // Pass resume: sessionId so createSession loads conversation history from transcript
  return createSession({ ...options, sessionId, resume: sessionId });
}

// ---------------------------------------------------------------------------
// Types — full re-exports
// ---------------------------------------------------------------------------

export type {
  Options,
  ToolDiscoveryOptions,
  ToolLoadingMode,
  QueryConfig,
  PermissionMode,
  PermissionBehavior,
  PermissionDecisionClassification,
  PermissionUpdate,
  PermissionUpdateDestination,
  PermissionRuleValue,
  CanUseTool,
  PermissionResult,
  HookEvent,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  BaseHookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  UserPromptSubmitHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  StopHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerStatus,
  McpSetServersResult,
  AccountInfo,
  SdkBeta,
  SettingSource,
  ModelInfo,
  SlashCommand,
  ThinkingConfig,
  EffortLevel,
  SDKControlInitializeResponse,
  SDKPermissionDenial,
} from './types/config.js';

export type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  UsageInfo,
  SystemPromptBlock,
  ToolDefinition,
} from './types/provider.js';

export type {
  Tool,
  ToolResult,
  ToolContext,
  ShellState,
  PermissionLevel,
} from './types/tool.js';

export { toolSuccess, toolError, toToolDefinition } from './types/tool.js';

export type {
  Goal,
  GoalInput,
  GoalStatus,
  GoalChangeSource,
  TurnEndChecks,
} from './types/goal.js';

// ---------------------------------------------------------------------------
// Settings Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SDK Message Subtypes
// ---------------------------------------------------------------------------

export type {
  AssistantMessageError,
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKDeferredToolUse,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKLocalCommandOutputMessage,
  SDKMaxTurnsReachedMessage,
  SDKGoalUpdatedMessage,
  SDKModelFallbackMessage,
  SDKPartialAssistantMessage,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSessionStateChangedMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
  // Note: SDKPermissionDenial is exported from types/config.ts
} from './core/query-types.js';


// ---------------------------------------------------------------------------
// LLM Providers
// ---------------------------------------------------------------------------

export {
  createProvider,
  createWellKnownProvider,
  listWellKnownProviders,
  AnthropicProvider,
  OpenAiCompatProvider,
  parseSSEStream,
  applyModelQuirks,
  applyStreamQuirks,
  isQuirkyModel,
} from './llm/provider.js';

export type {
  ProviderConfig,
} from './llm/provider.js';

export type {
  AnthropicProviderConfig,
} from './llm/anthropic.js';

export type {
  RequestIdentity,
} from './llm/request-identity.js';

export type {
  OpenAiCompatProviderConfig,
  ProviderQuirks,
} from './llm/openai-compat.js';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export { getAllTools, filterTools, findToolByName } from './tools/registry.js';
export { createCodeSearchService, getCodeSearchDiagnostics } from './search/index.js';
export { createCodeSearchTool } from './tools/code-search/index.js';
export type { CodeSearchOptions, CodeSearchRequest, CodeSearchResult, CodeSearchHit, CodeSearchDiagnostics, CodeSearchService } from './search/index.js';

// MCP SDK server — tool() and createSdkMcpServer()
export { tool, createSdkMcpServer } from './tools/mcp/sdk-server.js';
export type {
  SdkMcpToolDefinition,
  CallToolResult,
  ToolAnnotations as McpToolAnnotations,
  CreateSdkMcpServerOptions,
  McpSdkServerConfig,
  McpSdkServerConfigWithInstance,
  SdkMcpServerInstance,
  AnyZodRawShape,
  InferShape,
} from './tools/mcp/sdk-server.js';
export {
  bridgeSdkMcpTools,
  extractSdkMcpTools,
  isSdkMcpServerConfig,
  connectExternalMcpServers,
} from './tools/mcp/bridge.js';
export type { ExternalMcpConnection, McpServerConnectionStatus } from './tools/mcp/bridge.js';

// MCP connection manager (reconnection + health monitoring)
export { McpConnectionManager, createMcpConnectionManager } from './tools/mcp/connection-manager.js';
export type { McpServerLiveStatus, CreateMcpConnectionManagerOptions } from './tools/mcp/connection-manager.js';
export type { McpElicitationHandler } from './tools/mcp/client.js';

// MCP external transport — client, transports, JSON-RPC
export { McpClient } from './tools/mcp/client.js';
export type {
  McpServerCapabilities,
  McpServerInfo,
  McpToolDefinition,
  McpCallToolResult,
} from './tools/mcp/client.js';
export { StdioTransport, SSETransport, HttpTransport } from './tools/mcp/transports.js';
export type {
  StdioTransportOptions,
  SSETransportOptions,
  HttpTransportOptions,
} from './tools/mcp/transports.js';
export type {
  McpTransport,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
} from './tools/mcp/jsonrpc.js';

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export { assembleSystemPrompt, splitAtBoundary } from './prompt/system-prompt.js';
export type { SystemPromptConfig } from './prompt/system-prompt.js';
export {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  PROMPT_CACHE_BOUNDARY,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOOL_RESULT_BUDGET,
  AUTO_COMPACT_THRESHOLD,
  MAX_INPUT_TOKENS,
  TARGET_INPUT_TOKENS,
  API_COMPACT_THRESHOLD_PCT,
  API_COMPACT_TARGET_PCT,
  KEEP_RECENT_MESSAGES,
  MAX_CONSECUTIVE_COMPACT_FAILURES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  MAX_TOKENS_RECOVERY_LIMIT,
  UNREADABLE_TOOL_CALL_RETRY_LIMIT,
  MAX_TOKENS_RECOVERY_MSG,
  GOAL_RECITATION_INTERVAL,
} from './prompt/constants.js';

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

export { truncateToolResult } from './utils/truncate.js';
export { estimateTokens, estimateMessageTokens } from './utils/tokens.js';
export {
  SDKError,
  ProviderError,
  AbortError,
  ToolExecutionError,
  BudgetExceededError,
  MaxTurnsExceededError,
  CompactError,
  ResumeHistoryError,
  RESUME_HISTORY_UNAVAILABLE,
  isResumeHistoryError,
} from './utils/errors.js';
export type { ResumeHistoryReason } from './utils/errors.js';

// Logger — hexagonal port for structured logging
export { setLogger, getLogger, getRootLogger } from './utils/logger.js';
export type { Logger, LogLevel, LogFields } from './utils/logger.js';

// Redaction utilities
export { redactHeaders, redactSecrets, truncateField } from './utils/redact.js';

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------
// These functions operate on transcript files stored under the user config
// directory: <configDir>/projects/<project>/<session>.jsonl.

import { randomUUID } from 'node:crypto';
import {
  transcriptExists,
  getTranscriptPath,
  listLegacyRecordIds,
  readLegacyRecordMessages as readLegacyTranscriptMessages,
  type TranscriptOptions,
} from './core/transcript.js';
import { readdir, readFile, writeFile, stat, mkdir, open, rm } from 'node:fs/promises';
import { readJsonl } from './utils/jsonl-reader.js';
import { readTranscriptPage } from './core/transcript-reader.js';
import { join, basename, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Session info returned by listSessions / getSessionInfo. */
export interface SDKSessionInfo {
  sessionId: string;
  /** Display title: customTitle ?? firstPrompt ?? sessionId. */
  summary: string;
  /** Last write time, epoch milliseconds. */
  lastModified: number;
  /** File size of the transcript in bytes. */
  fileSize?: number;
  /** User-set custom title (via renameSession). */
  customTitle?: string;
  /** Earliest substantive user prompt. */
  firstPrompt?: string;
  /** Git branch at session creation time. */
  gitBranch?: string;
  /** Working directory. */
  cwd?: string;
  /** User-set tag (via tagSession). */
  tag?: string;
  /** Creation time, epoch milliseconds. */
  createdAt?: number;
}

/** Session message returned by getSessionMessages. */
export interface SessionMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

/** Options for listing sessions. */
export interface ListSessionsOptions extends TranscriptOptions {
  /** Project directory path. Alias: `dir`. */
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
  limit?: number;
  offset?: number;
  /** Worktree enumeration is unsupported; true rejects instead of silently narrowing results. */
  includeWorktrees?: boolean;
}

/** Options for getting session info. */
export interface GetSessionInfoOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
}

/** Options for getting session messages. */
export interface GetSessionMessagesOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
  limit?: number;
  offset?: number;
  /** When true, include system messages in the returned list. */
  includeSystemMessages?: boolean;
}

/** Options for reading a historical related transcript. */
export interface GetArchivedRecordMessagesOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
  /** Cap on how many messages are returned. */
  limit?: number;
  /** How many leading messages to skip. */
  offset?: number;
}

/** Options for listing historical related transcripts. */
export interface ListArchivedRecordsOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
}

/** Options for forking a session into a new one. */
export interface ForkSessionOptions extends SessionMutationOptions {
  /** Fork up to (and including) this message UUID. */
  upToMessageId?: string;
  /** Title for the forked session. */
  title?: string;
}

/** Result of forking a session. */
export interface ForkSessionResult {
  sessionId: string;
}

/** Options for session mutation operations. */
export interface SessionMutationOptions extends TranscriptOptions {
  cwd?: string;
}

/**
 * Read the first meaningful user text from a JSONL transcript file.
 * Stops at the first ordinary user text or a bounded prefix, including internal notices.
 */
async function readFirstPrompt(filePath: string): Promise<string | undefined> {
  const textFromLine = (line: string): string | undefined => {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' || entry.isMeta === true || entry.message?.toolContext?.baselineAttachment === true) return undefined;
      const content = entry.message?.content;
      if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 200);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'text') continue;
          const text = String(block.text ?? '').trim();
          if (text) return text.slice(0, 200);
        }
      }
    } catch { /* A partial or damaged record cannot supply a public title. */ }
    return undefined;
  };
  try {
    const fd = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let scanFrom = 0;
      for (let position = 0; position < 256 * 1024;) {
        const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, 256 * 1024 - position), position);
        if (!bytesRead) return textFromLine(pending + decoder.end());
        position += bytesRead;
        pending += decoder.write(buf.subarray(0, bytesRead));
        let start = 0;
        let newline = pending.indexOf('\n', scanFrom);
        while (newline >= 0) {
          const text = textFromLine(pending.slice(start, newline));
          if (text) return text;
          start = newline + 1;
          newline = pending.indexOf('\n', start);
        }
        pending = pending.slice(start);
        scanFrom = pending.length;
      }
    } finally {
      await fd.close();
    }
  } catch { /* file unreadable */ }
  return undefined;
}

/**
 * List sessions for the given working directory.
 * Scans transcript files in `<configDir>/projects/<project>/`.
 */
export async function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
  if (options?.includeWorktrees) {
    log.warn('Session listing rejected: worktree enumeration is not supported');
    throw new Error('listSessions({ includeWorktrees: true }) is not supported. List each worktree explicitly with cwd.');
  }
  const cwd = options?.dir ?? options?.cwd ?? process.cwd();
  const projectDir = dirname(getTranscriptPath('_placeholder_', cwd, options));
  try {
    const files = await readdir(projectDir);
    const sessions: SDKSessionInfo[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = basename(file, '.jsonl');
      const filePath = join(projectDir, file);
      let fileSize: number | undefined;
      let lastModified = 0;
      let createdAt: number | undefined;
      try {
        const fstat = await stat(filePath);
        fileSize = fstat.size;
        lastModified = fstat.mtimeMs;
        createdAt = fstat.birthtimeMs;
      } catch { /* stat failure — use defaults */ }
      sessions.push({
        sessionId,
        summary: sessionId,
        lastModified,
        fileSize,
        cwd,
        createdAt,
      });
    }
    // Sort by lastModified descending (most recent first)
    sessions.sort((a, b) => b.lastModified - a.lastModified);
    // Apply pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? sessions.length;
    const paged = sessions.slice(offset, offset + limit);
    // Enrich with sidecar metadata + firstPrompt in parallel
    await Promise.all(paged.map(async (s) => {
      const [meta, firstPrompt] = await Promise.all([
        readMeta(s.sessionId, cwd, options),
        readFirstPrompt(join(projectDir, `${s.sessionId}.jsonl`)),
      ]);
      if (meta.title) s.customTitle = meta.title;
      if (meta.tag !== undefined && meta.tag !== null) s.tag = meta.tag;
      if (firstPrompt) s.firstPrompt = firstPrompt;
      s.summary = s.customTitle ?? s.firstPrompt ?? s.sessionId;
    }));
    return paged;
  } catch {
    return [];
  }
}

/**
 * Get info about a specific session.
 */
export async function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  const cwd = options?.dir ?? options?.cwd ?? process.cwd();
  if (!transcriptExists(sessionId, cwd, options)) return undefined;
  const filePath = getTranscriptPath(sessionId, cwd, options);
  let fileSize: number | undefined;
  let lastModified = 0;
  let createdAt: number | undefined;
  try {
    const fstat = await stat(filePath);
    fileSize = fstat.size;
    lastModified = fstat.mtimeMs;
    createdAt = fstat.birthtimeMs;
  } catch { /* stat failure — use defaults */ }
  const info: SDKSessionInfo = { sessionId, summary: sessionId, lastModified, fileSize, cwd, createdAt };
  // Enrich with sidecar metadata (custom title / tag) and firstPrompt in parallel
  const [meta, firstPrompt] = await Promise.all([
    readMeta(sessionId, cwd, options),
    readFirstPrompt(filePath),
  ]);
  if (meta.title) info.customTitle = meta.title;
  if (meta.tag !== undefined && meta.tag !== null) info.tag = meta.tag;
  if (firstPrompt) info.firstPrompt = firstPrompt;
  info.summary = info.customTitle ?? info.firstPrompt ?? sessionId;
  return info;
}

/**
 * Get messages from a session transcript.
 */
export async function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  const cwd = options?.dir ?? options?.cwd ?? process.cwd();
  const filePath = getTranscriptPath(sessionId, cwd, options);
  return readTranscriptPage(filePath, sessionId, options);
}

/** Read a related transcript archived by an earlier SDK version. */
export async function getArchivedRecordMessages(
  sessionId: string,
  agentId: string,
  options?: GetArchivedRecordMessagesOptions,
): Promise<SessionMessage[]> {
  const cwd = options?.dir ?? options?.cwd ?? process.cwd();
  return readLegacyTranscriptMessages(sessionId, agentId, cwd, options) as Promise<SessionMessage[]>;
}

/** List archived transcript identifiers, not currently executable collaborators. */
export async function listArchivedRecords(
  sessionId: string,
  options?: ListArchivedRecordsOptions,
): Promise<string[]> {
  const cwd = options?.dir ?? options?.cwd ?? process.cwd();
  return listLegacyRecordIds(sessionId, cwd, options);
}

/**
 * Fork a session, optionally truncating at a specific message UUID.
 */
export async function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const cwd = options?.cwd ?? process.cwd();
  const filePath = getTranscriptPath(sessionId, cwd, options);
  const newSessionId = randomUUID();
  const newPath = getTranscriptPath(newSessionId, cwd, options);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let damaged = 0;
  let anchorFound = options?.upToMessageId === undefined;
  try {
    for await (const record of readJsonl(filePath)) {
      output ??= await open(newPath, 'wx', 0o600);
      const entry = record.value;
      const line = entry ? JSON.stringify({ ...entry, sessionId: newSessionId }) : record.line;
      if (!entry) damaged++;
      await output.writeFile(line + '\n');
      if (options?.upToMessageId !== undefined && entry?.uuid === options.upToMessageId) {
        anchorFound = true;
        break;
      }
    }
    if (!anchorFound) throw new Error('Requested fork message was not found in session history');
  } catch (error) {
    if (output) { await output.close(); output = undefined; await rm(newPath, { force: true }); }
    log.warn('session fork failed', { sessionId, error: String(error) });
    throw error;
  } finally {
    await output?.close();
    if (damaged) log.warn('session fork preserved malformed records', { sessionId, count: damaged });
  }
  return { sessionId: newSessionId };
}

// ---------------------------------------------------------------------------
// Session metadata sidecar helpers
// ---------------------------------------------------------------------------

/** Sidecar metadata stored alongside a session transcript. */
interface SessionMetadata {
  title?: string;
  tag?: string | null;
}

/** Path to the sidecar metadata file for a given session. */
function metaPath(sessionId: string, cwd: string, options?: TranscriptOptions): string {
  return getTranscriptPath(sessionId, cwd, options).replace(/\.jsonl$/, '.meta.json');
}

/** Read sidecar metadata; returns `{}` when absent or malformed. */
async function readMeta(sessionId: string, cwd: string, options?: TranscriptOptions): Promise<SessionMetadata> {
  try {
    const raw = await readFile(metaPath(sessionId, cwd, options), 'utf-8');
    return JSON.parse(raw) as SessionMetadata;
  } catch {
    return {};
  }
}

/** Merge `patch` into the existing sidecar metadata (atomic write). */
async function writeMeta(sessionId: string, cwd: string, patch: Partial<SessionMetadata>, options?: TranscriptOptions): Promise<void> {
  const existing = await readMeta(sessionId, cwd, options);
  const updated = { ...existing, ...patch };
  // Omit null tag so the field is absent rather than explicit null
  if (updated.tag === null) delete updated.tag;
  const filePath = metaPath(sessionId, cwd, options);
  // Ensure directory exists before writing
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true }).catch(() => {});
  await writeFile(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// renameSession / tagSession — real implementations backed by sidecar
// ---------------------------------------------------------------------------

/**
 * Rename a session by persisting a custom title to the metadata sidecar.
 */
export async function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void> {
  const cwd = options?.cwd ?? process.cwd();
  try {
    await writeMeta(sessionId, cwd, { title }, options);
  } catch { /* advisory — transcript directory may not exist yet */ }
}

/**
 * Set a session's tag; `null` removes it.
 */
export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void> {
  const cwd = options?.cwd ?? process.cwd();
  try {
    await writeMeta(sessionId, cwd, { tag }, options);
  } catch { /* advisory */ }
}

