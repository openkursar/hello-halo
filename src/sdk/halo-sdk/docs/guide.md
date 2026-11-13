# Integration guide

Detailed configuration and lifecycle contracts for Halo Agent SDK. Start with the [README](../README.md) for a minimal example.

For measured resource limits, live-model soak tests and release acceptance, see
[Resource and lifecycle validation](../validation/README.md).

## Native Runtime and Build

Both the direct and Worker entries execute the in-process Rust core. The core
owns model execution, tool scheduling, history and context management. The Node
binding owns JavaScript callbacks and public object references. Native loading
has no fallback runtime.

Source builds need Node.js 20 or later, the rustup-managed Rust 1.90.0 toolchain
pinned in `native/rust-toolchain.toml`, and the target platform's C compiler and
linker. `npm run build` generates the JavaScript facade, bundles the Worker,
compiles the native library, and removes executable output outside the runtime
dependency closure. `npm run dev` watches TypeScript only; rebuild native inputs
after Rust changes.

By default the native build targets the current OS and CPU. A package must retain
its platform-qualified library, `dist/native/build-info.json`, and license
notices. Build target names are `darwin-arm64`, `darwin-x64`, `win32-arm64`,
`win32-x64`, `linux-arm64` and `linux-x64`; Windows targets use MSVC. Selecting
another target with `HALO_SDK_NATIVE_TARGETS` requires its Rust target and C
toolchain. Target configuration is not evidence of execution on that platform.

The native entry exposes the loaded implementation and source identity:

```js
import { runtimeInfo } from '@hello-halo/agent-sdk/native';

console.log(runtimeInfo());
```

`@hello-halo/agent-sdk/collaboration/protocol` remains a pure JavaScript entry for
browser-safe protocol helpers. The runtime and stateful collaboration entries
require Node and the native library.

## Grouped Worker Execution

The optional Node-only Worker entry places the JavaScript facade and worker-side
callbacks on shared Workers. Both public entries execute the same native core
outside the host's JavaScript thread. The SDK has no Electron or
application-specific dependencies.

```ts
import { createWorkerRuntime } from '@hello-halo/agent-sdk/worker';

const runtime = createWorkerRuntime();
await runtime.initialize(); // Start after the host's latency-sensitive startup.

const session = await runtime.createSession({
  model: 'your-model',
  apiKey: process.env.ANTHROPIC_API_KEY,
  cwd: process.cwd(),
}, { group: 'optional-affinity-key' });

try {
  await session.send('Explain this project');
  for await (const event of session.stream()) console.log(event.type);
} finally {
  await session[Symbol.asyncDispose]();
  await runtime.close();
}
```

- Importing the entry or constructing a runtime starts no threads. Explicit
  initialization warms one by default; `warmWorkers: 0` disables prewarming.
  Creating a session initializes on demand and shares concurrent worker startup.
- Workers are shared, including by collaborators. Group keys are affinity hints.
  The default placement target is eight active sessions; idle sessions and
  collaborators also contribute to placement. By default there is no SDK limit on
  worker count: new sessions reuse existing capacity or start another worker.
  Hosts may set `maxWorkers` to a positive integer to enforce their own thread
  budget; omitting it or setting `Infinity` leaves the pool uncapped. CPU count
  does not impose a hidden ceiling. The placement target does not reject new
  sessions. Sessions stay on their original worker until closed. Empty excess
  workers expire after 60 seconds.
  This is demand-driven allocation, not a promise of unlimited machine resources
  or automatic redistribution when existing sessions become busy.
- Preparing a session creates the real session without sending a model request.
  Its normal skills, MCP, history and SessionStart hooks still run. The application
  owns deduplicating preparation for a conversation and invalidating configuration.
- Plain options are cloned per session. Permissions, hooks, elicitation and SDK
  MCP handlers execute in the host with cancellation signals. Such host code is
  outside the worker isolation guarantee. Asynchronous callbacks must honor their
  signal; the runtime rejects late replies but cannot forcibly stop host code.
- `send()` awaits execution-side acceptance. `sendIntoLiveTurn()` transfers
  ownership to the proxy synchronously; `hasPendingInput()` follows consumption
  receipts, and `withdrawUnreadInput()` waits for the worker's withdrawal decision.
  A failed worker errors all its sessions instead of replaying possibly executed
  input. Interrupting one session leaves its neighbors alive.
- `getGoal()` and `setGoal()` are asynchronous on worker sessions. `close()`
  retires the proxy immediately; `flush()` and async disposal await cleanup.
  `close({ signal })` can cancel advisory end hooks while persistence still
  drains. The worker runtime reserves half its close deadline for those hooks;
  a stalled hook does not by itself terminate neighboring sessions.
  Resuming a retiring transcript waits for its final writes. Concurrent live
  ownership of one transcript is refused.
- Read/Edit/Write coordinate canonical file paths across runtime instances in the
  same host module. This does not lock unrelated applications, Bash commands, or
  another host process. Streaming uses bounded acknowledged batches, without a
  host-side history mirror or shared memory.
- Worker startup, close and heartbeat deadlines default to 30 seconds. Session
  preparation has a separate 120-second deadline for external MCP handshakes and
  custom setup (`sessionStartupTimeoutMs`). A host can separately set
  `shutdownTimeoutMs` for application exit without shortening ordinary session
  retirement. Three failures
  within a minute open the restart circuit; replacements otherwise start on demand
  with bounded exponential delay. A deadlocked worker's sessions fail together.
  Native crashes and process-wide exhaustion still require process isolation.
  `resourceLimits` can be supplied when the host has measured an appropriate heap
  budget. `diagnostics()` returns counts and health without conversation content.
  Sessions and one-shot queries also expose `getRuntimeStats()` for execution-owned
  pending-input and active-collaborator counts, plus shared cost when collaboration
  accounting is active.

Shell selection uses each session's `env`, including `AGENT_SHELL` and, on
Windows, `AGENT_GIT_BASH_PATH`. A prewarmed worker therefore accepts a shell path
configured later by its host. Foreground and background commands use the same
bounded selection cache; credentials and conversation state are not cached there.
Grep likewise runs the absolute ripgrep path in the session's `AGENT_RIPGREP_PATH`
when the host ships its own copy, and `rg` from the session PATH otherwise.

Standard Anthropic and OpenAI-compatible providers need no setup module:

```ts
const session = await runtime.createSession({
  model: 'your-model',
  providerConfig: { type: 'openai-compat', apiKey: process.env.MODEL_API_KEY!, baseUrl: 'https://your-provider.example/v1' },
});
```

`openai-compat` names the OpenAI Chat Completions wire protocol, not a
Claude Code adapter: it calls `/chat/completions` directly and serves OpenAI
as well as other endpoints implementing that protocol. The Anthropic provider
calls `/v1/messages` independently. Neither requires the Claude Code executable.
Select `provider` or `providerConfig` explicitly; the older `apiKey` /
`anthropicBaseUrl` convenience path still selects Anthropic rather than inferring
a protocol from an arbitrary URL.

Anthropic-specific beta selection lives in `llm/anthropic-betas.ts`. Ordinary
caching and `output_config.effort` use stable request fields without an automatic
beta header. Adaptive thinking also does not add the legacy interleaved-thinking
header. Explicit budgeted thinking retains that opt-in; context management, an
explicit 1M opt-in, and task budgets retain their public beta identifiers. Caller
`betas` remain an explicit extension point and are not a promise of endpoint
support. Existing version dates in a beta identifier are not expiry dates.

These protocol distinctions were checked against the official API SDK revision
[`590e9494` (2026-11-05)](https://github.com/anthropics/anthropic-sdk-typescript/tree/590e9494f0214710614c1d6b929b07666f1e3080):
`src/resources/messages/messages.ts` declares stable cache control, effort and
adaptive thinking; `src/resources/beta/beta.ts` lists the retained opt-ins and
`src/resources/beta/messages/messages.ts` declares task budgets. Model and
third-party endpoint support must still be checked independently.

Custom providers, native tools, and computation that must stay in the worker can
be constructed by a Node-compatible setup module:

```ts
// provider-setup.mjs — runs inside the worker
export async function setup(options, data) {
  return { ...options, provider: createYourProvider(data) };
}

// host
const runtime = createWorkerRuntime({
  setup: { module: new URL('./provider-setup.mjs', import.meta.url).href, data: {} },
});
```

Setup data must be cloneable; the module URL must be a local file URL. Host
provider and tool instances are refused rather than silently moved back onto the
host thread. In-process SDK MCP tools are the supported host-tool bridge. A setup
module owns any resources it creates outside the SDK's tool lifecycle.

Build with `npm run build`; the shipped worker includes its JavaScript dependencies
and loads the package's matching native library. Hosts that archive application
files must place the SDK package and their setup modules outside the archive,
and can supply `workerUrl` using
`getWorkerEntryUrl()` to resolve the relocated execution entry.

Run `npm test -- worker` for real-thread failure and lifecycle regressions.
`npm run benchmark:workers -- --sessions=10` compares direct and worker execution
in fresh processes against a local mock model. It records cold readiness, warm
creation, restore, first-request arrival, main-loop delay, process RSS and CPU.
Run it on the target Windows hardware; synthetic Mac numbers are not a Windows
acceptance threshold. See [runtime design](../worker/DESIGN.md).

## Filesystem Conventions

`Options.conventions` controls where the SDK finds instructions, skills and
commands, and where it stores user state. Instruction and skill directories are
searched in the configured order; the first matching name takes precedence.
Files and directories reached through symlinks are de-duplicated by resolved path.

Anything the engine reads or writes derives from these conventions, so all of it moves together. The user-level state lives under the config directory:

```
<configDir>/skills/                       installed user skills
<configDir>/todos/<sessionId>.json        working memory (todo list)
<configDir>/goals/<sessionId>.json        working memory (session goal)
<configDir>/projects/<project>/<id>.jsonl session transcripts
```

Override any of it per query:

```ts
import { query, createWellKnownProvider } from '@hello-halo/agent-sdk';

query({
  prompt: '...',
  options: {
    model: 'deepseek-chat',
    provider: createWellKnownProvider('deepseek'),
    conventions: {
      // Full replacement of the defaults:
      agentDirs: ['.myagent', '.agents'],
      memoryFiles: ['AGENTS.md'],
    },
  },
});
```

Omitting a field keeps its default; supplying an array replaces that array wholesale. See `core/conventions.ts` for the full shape.

### Resuming stored sessions

`resume` reads transcripts written by this SDK and by Claude Code. Claude Code
records one reply over several lines sharing a message id, puts parallel tool
results and their attachments on separate lines, and marks compaction with a
`compact_boundary` record followed by a summary; the reader rebuilds the replies
and results the model saw and restores only what follows the last boundary.
Sidechain records in a main-session transcript are skipped. The shapes are pinned
by synthetic fixtures of Claude Code 2.1.89 and 2.1.310 in
`core/fixtures/cc-transcripts/`; re-check them against real transcripts before a
host recommends another Claude Code version.

With `strictResume: true`, session creation rejects instead of continuing from
history that is missing, unreadable or would lose recorded content (damaged
records, recorded results that cannot be paired, duplicate calls). The error
carries `code: 'RESUME_HISTORY_UNAVAILABLE'` and `reason: 'missing' |
'unreadable' | 'incomplete'`, also across the worker boundary
(`isResumeHistoryError`). A call with no recorded result and history left out
by the size bounds are not treated as losses.

## Design Principles

### 1. Direct execution

The direct entry runs the Rust loop in the host process on shared native execution
threads. The optional Worker entry additionally moves its JavaScript ownership
and callbacks to shared Workers and uses message passing. Neither entry starts a
separate agent executable. Shell commands, MCP transports and optional search
backends may still create subprocesses.

```ts
import { query, createWellKnownProvider } from '@hello-halo/agent-sdk';

for await (const message of query({
  prompt: 'Refactor the auth module',
  options: { model: 'deepseek-chat', provider: createWellKnownProvider('deepseek') },
})) {
  console.log(message.type);
}
```

### 2. Collaboration Without a Separate Agent Process

Local collaboration creates independent SDK sessions in the source session's
runtime: in-process for the direct entry, or within the same Worker for the Worker
entry. Each collaborator has its own history and context window; its assignment
is delivered explicitly rather than copying the source conversation. Creating a
collaborator does not start another agent process or Worker. Tools and optional
Git worktree isolation can still create subprocesses, and resource costs depend
on the workload.

`query()` and `createSession()` install collaboration according to
`Options.collaboration`; Worker sessions use the same selection:

| Configuration | Ownership and behavior |
| --- | --- |
| `{ mode: 'local' }` | The SDK installs the `halo-team` MCP tools and lazily creates local coordination, storage and collaborator sessions when used. Optional settings are `maxConcurrentTurns`, `maxMembers`, `idleTimeoutMs`, `maxIdleSessions`, `maxRecords` and `maxBytes`. |
| `{ mode: 'hosted' }` | The SDK creates no local collaboration owner or tools. The host supplies scoped tools, execution, identities, authorization, storage and transport. |
| `false` | The SDK creates no local collaboration owner or tools. This does not remove independently supplied MCP or custom tools. |
| Omitted | Local collaboration is available by default unless a `halo-team` MCP server is supplied, a `tools` array omits `spawn_agent`, or `disallowedTools` contains the compatibility `Agent` alias, `spawn_agent` or `mcp__halo-team__spawn_agent`. |

`Agent` in `disallowedTools` is only a compatibility alias; this SDK exposes no
built-in tool by that name.

Explicit local mode can be used with a restricted built-in `tools` array.
`disallowedTools` still filters the exposed MCP names. Supplying both explicit
local mode and `mcpServers['halo-team']` is rejected: one session must have one
collaboration owner.

The local model-facing tools include `mcp__halo-team__spawn_agent` for an
asynchronous assignment and `mcp__halo-team__team_send` for directed messages,
including follow-ups to an existing collaborator. Board tasks, findings, member
records, artifact reads and stopping work are available through the same tool
set. A board task does not dispatch an assignment; send it separately. Optional
`isolation: 'worktree'` on `spawn_agent` gives a collaborator a separate Git
working directory, not an operating-system sandbox.

Application hosts can build their integration with `createCollaborationServer`
and the engine-independent contracts exported by
`@hello-halo/agent-sdk/collaboration`. Importing that entry starts no model loop
or background work; the host supplies the operations. Built-in sub-agent tools
and `Options.agents` definitions are not part of this interface. See the
[API limits](#api-limits) for the supported surface.

### 3. Open-Model Harness Optimization

The harness exposes model and endpoint adaptations that hosts can evaluate for their workloads:

- **Tool-call formats** — native function calling is the default. Explicit XML or JSON adapters are available for endpoints that need a prompt-based tool protocol; select them based on the actual endpoint and evaluation results.
- **Stagnation detection** — code-level analysis of recent tool calls detects repeated identical calls or errors and injects a factual notice, steering the model away from loops (critical for models with lower tool-use compliance)
- **Goal** — for long, complex work the model records the objective and checkable done-when criteria; the goal lives outside message history, survives compaction, and is recited at the start of each run and whenever it has been out of view for a while
- **End-of-turn checks** — when the model stops while the goal is open or todo items are unfinished, the harness states what is still open once per distinct state and leaves the decision to the model; an optional completion check asks it to confirm nothing requested is missing
- **Steering-quality tool returns** — every truncation, error, and denial message is engineered to tell the model what happened, what was lost, and what to do next

## Architecture

The Rust session owner and low-level generator share one ReAct loop in
`native/crates/halo-core/src/core/loop_runtime.rs`. JavaScript public signatures
remain in the SDK's TypeScript facade and declarations; the TypeScript loop files
are not executed. Rust paths below are relative to `native/crates/halo-core/src/` in the source checkout:

| Layer | File | Purpose |
|-------|------|---------|
| Input budget | `core/token_budget.rs` | Complete-request estimates, optional usage calibration and output reservation |
| Tool ingress | `core/tool_execution.rs` | Bound each new result before it enters history; never repeatedly rewrite old results |
| Summary | `core/compact/` | Structured handover using the effective request's cacheable prefix |
| Recitation | `tools/working_state.rs` | Working memory persisted outside message history, re-injected on change and after compaction |
| Reminders | `core/goal_reminders.rs` | Goal recitation, user-edit notices and end-of-turn checks |
| Stagnation | `core/stagnation.rs` | Fact-based loop detection appended to tool results |
| Hooks | `core/hooks.rs` | Pre/post tool-use lifecycle with deterministic input threading |
| Caching | `llm/cache.rs` | Prefix-cache-safe message ordering (stable content first, volatile last) |
| Scheduling | `core/tool_scheduler.rs` | Incremental, bounded execution with ordered exclusive barriers |
| Tool lifecycle | `core/tool_execution.rs` | Permissions and hooks prepare effective arguments before scheduling |
| Streaming | `core/streaming.rs`, `core/event_flow.rs` | Bounded multiplexing of model output and tool messages |
| History | `history/`, `core/messages.rs` | Completed-block checkpoints and response finalization |
| Harness text | `harness/catalogs/`, `harness/resources/` | Model wording templates and fixed protocol resources |

Normal turns append history without clearing old tool results or silently trimming
messages. Before a request, the loop reserves a bounded working-response allowance
and triggers a summary at 90% of the remaining input capacity, targeting 55%.
The user's `maxOutputTokens` is an output ceiling, not an unconditional reservation
of that entire size. Explicit thinking also needs headroom. The request includes
system instructions, tool definitions, injected context and history. Missing or
zero provider usage uses local estimates; estimates never become billed usage.
Valid calibration survives user turns within one session; changing model, thinking
or request-prefix content invalidates it. Resume starts with local estimates.
A summary retains recent complete exchanges, the latest user request, working state and archive recovery
information. The 55% target guides allocation, not acceptance: a useful smaller
history is retained even when it misses that target. Unusable summary output gets
one changed handover request; transient transport errors retry only the affected
segment. If proactive summarization remains unusable below estimated input
capacity, work can continue with intact history instead of ending the task.

An actual context-overflow error permits one recovery before another model response,
including immediately after proactive compaction. Oversized summary input is
summarized in ordered, tool-paired groups and merged, with a 16-request limit and
cost/cancellation checks. Oversized merges reduce their output reservation, then
shorten the existing ordered handovers when needed; unsuccessful shortening stops
without dropping records. Records are not silently trimmed. Fixed context or an
indivisible exchange that cannot fit, exhausted recovery, unavailable providers,
and checkpoint storage failures preserve state and report the failure.

The summary keeps the current model, system, tools and thinking configuration,
with its instruction appended to the history. It never executes tools. Cache
hits still depend on provider support, expiry and request identity. Summary
usage is included when supplied; absent usage or prices do not establish a
complete bill. The explicit `microCompact` and `apiCompact` utility exports
remain available, but the automatic loop does not call them.

See [the core execution contract](../core/DESIGN.md) for retry, cancellation and history ownership.

## Declaring the Context Window

The SDK budgets compaction against `contextWindow`, and never infers it from the
model name — the caller knows which endpoint it is talking to, and a wrong guess
either overflows the request or compacts away context the model could still have
used. It defaults to 200k tokens, so declare it for anything else:

```ts
query({
  prompt: '...',
  options: { model, provider, contextWindow: 1_000_000 },
});
```

Here `model` and `provider` are your configured model and provider; use the
context-window size supported by that endpoint. `setModel` changes the model ID,
not the endpoint's declared capacity or output reservation. Configure a window
supported by every model in the session; switching endpoints or capacity requires
a newly configured session. Provider-reported overflows still have bounded recovery.

## Goals and End-of-Turn Checks

The model sets the session goal with the `Goal` tool. The host can seed it,
read it, and edit or clear it on the user's behalf; the model learns about an
edit at the start of its next turn, and every change is reported as a
`system` / `goal_updated` event with `source: 'agent' | 'user'`.

```ts
import { createSession, createWellKnownProvider } from '@hello-halo/agent-sdk';

const session = await createSession({
  model: 'deepseek-chat',
  provider: createWellKnownProvider('deepseek'),
  goal: { objective: 'Reconcile last year\'s invoices', doneWhen: ['Every invoice marked'] },
  turnEndChecks: { openWork: true, completion: false }, // the defaults
});

session.getGoal();                                   // Goal | null
session.setGoal({ objective: 'Reconcile Q4 only' }); // tell the model next turn
session.setGoal(null);                               // remove it
```

`Options.goal` is ignored when a resumed session already has a goal.
`turnEndChecks.completion` adds one model call per turn; enable it only where
the extra check is worth the cost.

## Workflows and Prompt Profiles

`ultraEffort` changes two preset instructions: task investment and response to
failed attempts. The normal mode uses the token budget efficiently within the
requested scope. UltraEffort encourages fullest effort, different approaches and
method combinations, and useful parallel collaboration with no more than four
active agents in total, including the source agent. The agent-count wording is
guidance, not a runtime admission limit. Identity and all other instructions,
including communication, are shared by both modes.

```ts
const session = await createSession({
  model: 'your-model',
  ultraEffort: true,
});
```

This advanced option defaults to false and is never inferred from a model name.
It does not change provider reasoning `effort`, token or cost limits, permissions,
tool protocols or end-of-turn checks. Child sessions inherit it, and Worker
sessions accept the same option. Complete string `systemPrompt` replacements,
including an empty string, are untouched; preset append text is preserved.
The selection stays in the stable prefix across model switches. Task quality and
usage differences need a real-model comparison, not an assumption.

Skills advertise a short name and description; their instructions are loaded
only when selected. The bundled `commit` and `pull-request` workflows cover
repository commits and pull/merge requests. Project and user skills override
these defaults, and host commands retain their existing precedence. An explicit
skill slash command expands its selected instructions directly. Disabling the
Skill tool also hides its catalog and generated commands. Bash describes shell
execution; repository workflows live in skills.

An opt-in profile mapping can select small wording variations for the actual
model used by a request, including a fallback model:

```ts
const session = await createSession({
  model: 'your-model',
  promptProfile: {
    default: 'default',
    models: { 'your-model': 'explicit' },
  },
});
```

`default` adds no model-specific guidance. `explicit` adds brief execution
checkpoints; it is opt-in and should be compared against the default on the
host's tasks. Exact model IDs avoid guessing the model behind a gateway alias.
These settings do not change the tool protocol, permissions or context window.
A string `systemPrompt` remains a complete replacement; a preset's `append`
remains an addition to the generated prompt. Summaries use their own handover
instructions and may use the selected profile's summary guidance.

After context reduction, a bounded reminder can identify recently used skills
so the model can reload relevant instructions. It neither repeats every skill's
body nor authorizes new actions.

### SDK-authored Harness text

`getHarnessTextCatalog()` exposes configurable text identifiers, baseline wording
and required placeholders. `Options.harnessText.templates` supplies common
overrides; `Options.harnessText.models[modelId]` overrides them for an exact model
ID. Omitted entries retain the baseline. Templates are resolved once into
immutable, model-scoped configuration rather than changing global text.

```ts
import { getHarnessTextCatalog } from '@hello-halo/agent-sdk';

const templates = getHarnessTextCatalog();
console.log(templates.find(template => template.id === 'permissions.denied_reason'));
```

Keep every placeholder listed in `slots`, such as `{reason}`. Unknown text IDs,
non-string replacements and missing required placeholders reject configuration
before execution. Overrides affect SDK-authored wording, not host instructions,
user data, permissions or the tool protocol. Parsed envelopes and protocol grammar
remain fixed resources outside this override catalog. Evaluate changed wording
on the intended model and tasks; the baseline is used unless the host opts in.

## Writing Tools

A tool that can safely run alongside the other calls in the same turn says so:

```ts
const ReadTool: Tool = {
  name: 'Read',
  // ...
  isConcurrencySafe: () => true,
};
```

Judged per call, since the same tool can be safe or unsafe depending on its
input. Say nothing and the call runs on its own — a tool that mutates shared
state and stays silent would otherwise corrupt it, which is worse than slow.
MCP tools inherit this from the protocol's `readOnlyHint`.

Complete tool blocks can execute while the model is still generating later
blocks. Permissions and hooks run before concurrency is decided, using the
actual input that will execute. Safe calls share a bounded pool (default 10,
`HALO_MAX_TOOL_CONCURRENCY` to override); unsafe calls remain ordered barriers.
Configured tool hooks conservatively serialize preparation with execution,
since arbitrary hooks may mutate shared state.

A stream retry is allowed before tool calls have been committed. After that,
a failed stream stops the turn and preserves known results rather than replaying
possible side effects. Compaction runs only after the tool exchange is settled.
Providers that deliver all tool boundaries at response end still get bounded
parallel execution, but cannot benefit from model/tool overlap.

## Client-side MCP discovery

Hosts can opt into native tool discovery without a provider-specific deferred
protocol. The same option works with `createSession`, `query` and the Worker
runtime. The SDK does not require Halo as its host.

```ts
const session = await createSession({
  model: 'your-model',
  mcpServers: {
    records: { type: 'http', url: 'http://127.0.0.1:3100/mcp' },
  },
  toolDiscovery: {
    services: {
      records: {
        identity: 'records-installation',
        loading: 'deferred',
        summary: 'Find customer records and order history.',
        toolOverrides: { current_user: 'eager' },
      },
    },
  },
});
```

Service keys match `mcpServers`; override keys are the server's original tool
names. An identity names a stable source instance and must contain no credentials.
Hosts choose policy. Unspecified services, native tools and ordinary custom tools
retain their existing full declarations. Disabling a tool still removes it before
discovery; changing loading policy never grants permission or connects a disabled
service. This feature defers model context, not MCP connections.

The model receives a short service directory and fixed `ToolSearch` and `CallTool`
declarations alongside eager tools. `ToolSearch` accepts `query`, optional `server`
and `max_results` (default 5, range 1–10); `select:<full tool name>` requests an exact
definition. Queries are bounded to 4,096 Unicode characters. `CallTool` accepts
exactly two strings: `tool` and `arguments`, with the
latter containing a JSON object. The SDK restores the real tool before hooks,
permissions, schema validation and scheduling. Public progress reports the real
tool, while model history preserves the exact original wrapper.

Searches append complete definitions to history without expanding the provider's
tool array. Repeated keyword discovery returns an already-loaded reference;
explicit selection may show the full definition again. A search result is bounded
to 32 KiB UTF-8 and the configured result-character budget. A definition that
cannot fit completely, including its recoverable state, is not loaded. Output
hooks that replace or truncate discovery content cannot authorize a new tool.
The additional deferred catalog is bounded to 16 MiB of serialized definitions,
and committed discovered definitions to 4 MiB, alongside the model context and
checkpoint limits. Exceeding a bound reports a capacity problem rather than
truncating a schema, unloading an old definition or silently switching modes.

Optional `summary` and `usageGuide` describe the service. Without a host summary,
the SDK uses bounded server metadata or a deterministic description excerpt.
Guides accompany discovery rather than becoming higher-priority instructions.
Keep mandatory host rules in the host's own system instructions. A complete
`systemPrompt` string is preserved.

Recorded definitions and versions survive automatic compaction independently of
the model's summary. Resume and forks recover the state at the selected history
boundary and intersect it with currently allowed tools. Revoked or changed tools
cannot execute through old discoveries. Damaged new-format records fail resume
instead of silently becoming old full-tool history.

In a discovery-format session, `/clear` saves a reset checkpoint before confirming
success. Failed writes retain the old working context; successful resets survive
close and resume without deleting the original journal. Main-session tool-result
event UUIDs are persisted unchanged, so a fork at a completed search result includes
that discovery, while a fork at the preceding call does not.

The option is off when omitted and does not modify explicit XML/JSON calling
modes. Existing histories without a discovery baseline retain full declarations;
start a new session to adopt discovery. Hosts needing to select interface behavior
before resuming can use `readSessionToolContextMode(sessionId, { cwd, env,
resumeSessionAt })`, exported by both public SDK entries. It returns `deferred`
for the recorded client-context format and `full` for legacy history; missing or
damaged records raise the ordinary resume error. Worker hosts should use
`runtime.readSessionToolContextMode(sessionId, options, { signal, group })`,
which borrows the existing pool without creating a session or connecting tools.
The standalone helper validates bounded history on the calling thread. Call
either during preparation, not while opening a menu or on every model step.

Stable declarations avoid one source of cache-prefix changes; they do not promise
provider cache hits or lower total task cost. Discovery adds a model step and
generic calls can affect argument accuracy. Evaluate complete tasks with the
intended models before claiming a cost or latency improvement.

## Provider Support

- **Anthropic** — native provider with extended thinking, prompt caching, server tool use
- **OpenAI-compatible** — any provider implementing the Chat Completions API (DeepSeek, Qwen, GLM, OpenRouter, Ollama, vLLM, etc.)

For compatible endpoints that accept `reasoning_effort`, opt in with
`providerConfig.quirks.reasoningEffort: true`. With `thinking: { type: 'adaptive' }`,
the session's `effort` applies to both normal responses and context summaries.
Explicitly disabled thinking does not acquire a reasoning-effort parameter.
Provider-reported cached prompt tokens are counted separately from uncached input;
both still count toward the context window.

### Optional Anthropic task budget

`Options.taskBudget: { total: number }` opts into Anthropic's API-side token task
budget, sent as `output_config.task_budget: { type: 'tokens', total }` with the
`task-budgets-2026-03-13` beta header. Leave it unset unless the selected Anthropic
model and endpoint support that feature. It is not a generic SDK-wide local hard
token ceiling: the SDK does not track or decrement a remaining task-token balance
across requests or collaborators. The built-in OpenAI-compatible provider does
not send this option; custom-provider support must be implemented separately. `maxOutputTokens`
controls work-response output, and `maxBudgetUsd` is a separate cost limit whose
accuracy depends on supplied usage and model pricing.

## Optional local code search

This backend is experimental and opt-in. It adds ranked code candidates while
Grep retains exact keyword, regular-expression and enumeration behavior. The
current native dependency tree and memory cost are substantial, and the default
model has limited Chinese-to-English retrieval in the measured fixture. See
[backend measurements and limits](../search/VALIDATION.md) before enabling it.

`Options.codeSearch` enables the `CodeSearch` built-in for `query`, sessions, and
worker sessions. It is absent by default. Supply absolute paths to a separately
installed Node 22+ executable, the public entry of `@zvec/zvec-grep`, and a cache
directory outside the source workspace:

```ts
const options = {
  model: 'your-model',
  codeSearch: {
    backend: 'zvec-grep' as const,
    nodePath: '/absolute/path/to/node',
    modulePath: '/absolute/path/to/zvec-grep/dist/index.js',
    cachePath: '/absolute/path/to/search-cache',
  },
};
```

Creating a session starts no search process. The first search prepares a local
index; later searches can request a refresh. SDK workers forward searches through
the host callback bridge, so matching workspaces and backend settings share one
host-managed search process and index. Session close/flush and worker failure
release that session's ownership. Worker setup modules may not enable or replace
the configured search backend. Node 20 SDK operation without this optional
backend is unchanged; no zg package is installed or downloaded by the SDK.

Read restrictions are enforced again on the host. This backend refuses to index
a workspace when a read-deny rule overlaps it; Grep remains available for exact
permission-aware searches. Ranked candidates are not exhaustive and may be
stale. Verify current source with Read before making changes.

Use a dedicated cache directory: it can contain copied source snippets. The SDK
rejects workspace-overlapping, home, and shared temporary roots as cache paths,
and denies its built-in Read, Grep, and Glob tools access to that directory in
the session and its children, including after worker setup changes. The host
must keep unrelated files out of this directory. These are built-in tool read
rules, not an operating-system sandbox for Bash or custom tools. Sessions with
no search configuration do not gain this additional read restriction.

Standalone hosts can use `createCodeSearchService`, `createCodeSearchTool`, and
the exported `CodeSearch*` types. Such hosts own the service and must await its
`dispose()` method. `getCodeSearchDiagnostics()` reports shared process and queue
counts without queries or source content.

## Tool selection and permission rules

All SDK entry points use `tools` to select built-ins (`tools: []` selects none).
Custom tools override matching built-ins; `disallowedTools` removes tools after
composition, including MCP tools and later reconnections. `CodeSearch` follows
these same rules. Local collaborators inherit the source session's tool selection
and permission policy, receive scoped collaboration tools, and do not receive
`Goal`. See
[collaboration selection](#2-collaboration-without-a-separate-agent-process) for
how a `tools` array affects default local collaboration.

`allowedTools` supplies permission preapprovals, not a tool-pool filter. A bare
tool name such as `Bash` preapproves that tool. Conditional strings such as
`Bash(git status:*)` are delegated to `canUseTool`; the SDK does not implement a
shell permission-rule parser. Without that callback, a conditional rule does
not authorize the tool, unless the session explicitly uses `bypassPermissions`
or also contains a bare approval. Interactive tools still use the host callback.

## API Limits

The SDK runs directly or in shared Workers, without a separate agent executable.
Executable-path and CLI-argument options for subprocess-based harnesses are not
declared by `Options`. The retained `settings` field does not load or apply a
settings file or object; `settingSources` selects instruction-file sources for
injected context, not general CLI settings. Unknown option keys are ignored
rather than rejected. Accepting a shared options object across engines is not
evidence that every field has an effect.

The following operations are unsupported:

- `query().streamInput()` rejects additional input. Use `createSession().send()`
  or `session.sendIntoLiveTurn()` instead.
- The built-in `/compact` command returns an error; automatic context
  compaction is unaffected. Hosts may provide their own slash-command handler.
- `listSessions({ includeWorktrees: true })` rejects worktree enumeration.
  List each working directory explicitly with `cwd` instead.

### Collaboration ownership

Sessions use one collaboration host. Standalone SDK sessions provide the scoped
`spawn_agent`, messaging, board, artifact and stop tools through the local
adapter. Setup is lazy; `collaboration: false` disables it, and
`collaboration: { mode: 'hosted' }` leaves ownership to the application. Never
install both owners for the same session.

The host chooses the model and permission floor. Collaborators keep separate
conversation histories and can delegate within the source's concurrency and
creation budget. Idle SDK execution objects are bounded by `maxIdleSessions`
and retired after `idleTimeoutMs`; their identity and working state remain
available for continuation. Background shell tasks belong to that identity and
survive idle retirement, while explicit stops and host shutdown stop them.

Related historical records can be read with `listArchivedRecords()` and
`getArchivedRecordMessages()`. These describe stored records, not executable
configurations. Current collaborator transcripts use ordinary session APIs.

### Command metadata is not a security policy

Command definitions include registration, display and execution fields alongside
metadata. A local command runs through its `call` handler; a prompt command
expands through `getPromptForCommand`. Without the corresponding handler,
dispatch reports the command as host-handled. `isEnabled`, `isHidden` and
`userInvocable` only control listing and dispatch; they are not authentication or
permission enforcement.

The SDK does not support these command fields: `isSensitive`,
`disableModelInvocation`, `supportsNonInteractive`, `argNames`, `availability`
(with `AvailabilityContext`), `kind` / `version` / `userFacingName`, and
prompt-command `model` / `allowedTools`. TypeScript integrations that declare
them must omit them; they do not provide argument redaction, execution modes,
model selection or permission enforcement. Command names, aliases and handlers
work as documented. Session-level model selection and `allowedTools` are
unaffected.
Do not put secrets in command arguments expecting automatic redaction. Enforce
permissions through the session tool selection and `canUseTool` contracts above.

The provider-specific `enableTokenEfficientTools` option is unsupported and does
not inject a beta header. Hosts requiring a documented provider extension can
supply its header value explicitly through the provider's `betas` configuration.

## Quick Start

Requires Node.js 20 or newer.

```bash
npm install @hello-halo/agent-sdk
```

```ts
import { query, createSession, createWellKnownProvider } from '@hello-halo/agent-sdk';

const provider = createWellKnownProvider('deepseek'); // reads DEEPSEEK_API_KEY
const model = 'deepseek-chat'; // required — the SDK never picks a model

// One-shot query
for await (const message of query({ prompt: 'List files', options: { model, provider } })) {
  console.log(message.type, message);
}

// Multi-turn session
const session = await createSession({ model, provider });
await session.send('What does this project do?');
for await (const msg of session.stream()) {
  console.log(msg.type);
  if (msg.type === 'result') break;
}
session.close();
await session.flush();
```

## Input during an active turn

`session.sendIntoLiveTurn(message)` synchronously accepts the same text or
multimodal envelope as `send`. The query loop combines messages in arrival order
before the next model step after the current tools finish. Input arriving while
the model finishes its answer keeps the query running. If the result already
escaped, re-entering `stream()` immediately consumes the pending continuation.
`hasPendingInput()` identifies that gap so a host must not mark the session idle
or rebuild it before consuming the input. A closed session declines live input.

`UserPromptSubmit` hooks run in input order when the message batch is consumed,
including batches delivered during a turn. The synchronous acceptance never waits
for advisory hooks. The host remains responsible for authorizing the sender and
persisting its own display record.

## License

[MIT](../LICENSE)

## Dynamic MCP invocation

Deferred MCP tools use fixed `ToolSearch` and native `CallTool` declarations.
Search returns `invoke_via: "CallTool"` and `targets` containing `tool`,
`description` and the complete `arguments_schema`. Pass target inputs directly
as the `arguments` object; discovered targets are not added to the provider's
formal tools.

The Rust admission decoder also accepts legacy JSON-object strings, up to two
string-decoding layers, complete JSON fences and one bounded trailing-comma
repair pass. It rejects conflicting duplicate keys, incomplete values, missing
targets and inputs beyond 1 MiB or 64 nesting levels. It never infers a target,
fills business values or recursively parses strings inside business arguments.
Ordinary assistant JSON/XML text does not execute tools.

Unrecoverable input receives natural-language feedback and a compact input
example. Format correction uses the existing turn budget, permits at most two
correction requests, and stops earlier when the same invalid input repeats.
Permission denials and uncertain execution outcomes do not enter this recovery
path. Discovery, current-definition, hook, permission and scheduling checks still
apply after local recovery. The existing lightweight schema validator checks
basic types, required fields, scalar enums and array items; it is not a complete
JSON Schema validator and does not resolve composition or `$ref` constraints.
Target implementations remain responsible for their own validation.
