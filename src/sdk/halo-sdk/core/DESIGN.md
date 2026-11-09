# Core execution and history

The core owns model turns, tool admission, execution and conversation history.
Session owners supply persistence callbacks; core does
not import their state. These modules are internal collaborators, not separate
public entry points.

## Streaming and scheduling

`query-loop.ts` assembles provider events into immutable completed blocks. Only
complete JSON objects are eligible for execution. Malformed arguments produce
an error result. Duplicate tool IDs, restarted messages and mutations of closed
blocks terminate the attempt. Interleaved blocks wait for earlier blocks to
complete before admission; newly introduced block indices must be increasing.
Legacy custom providers without block-stop events are admitted only after their
iterator finishes successfully.

The owner records each completed block before its tool can start. Public frame
UUIDs remain the transcript checkpoint UUIDs. A separate local response UUID
groups one attempt, independently of provider IDs, which providers may reuse.
Text-only failed attempts are discarded. Successful text-only responses use the
same journal at completion.

`tool-execution.ts` separates preparation from execution. Preparation applies
hooks, permission decisions and schema validation to a copy of model arguments.
`tool-scheduler.ts` prepares the queue head, checks concurrency against the
effective input, then starts eligible work. Safe calls overlap up to the per-turn
limit. An unsafe call waits for earlier work and blocks later work. No scheduler
state is shared across sessions. Arbitrary tool hooks require conservative
serialization; an ordinary host permission callback does not disable parallel
safe execution.

`streaming-turn.ts` drains model frames, tool progress and tool-owned messages
through one backpressured channel. Tool execution must not wait for the provider
to finish before its messages can be consumed. The API duration stops when the
model iterator finishes, before the remaining tool execution tail is drained.

## Failure and cancellation

Provider retry/fallback remains available before a tool checkpoint. After
admission, the attempt is never automatically replayed: tools may already have
changed external state. Stop queued work, cancel active operations, retain known
results and report a terminal error. Missing results explicitly describe an
interruption and require checking effects before repeating an action.

Each turn derives a cancellation signal without aborting the host's controller.
An execution failure notifies cancellation immediately, before waiting for
sibling tasks to settle. Closing the public iterator follows the same cleanup
path. Operations that ignore cancellation may still finish externally; core
observes their rejected promises but does not invent an exactly-once guarantee.

Completed results are retained before output hooks. A failing or interrupted
output hook cannot erase a completed write. Compaction runs after tools settle
and their result message has been recorded, never across an active exchange.

Foreground Bash commands have a default execution deadline. Background commands
have a deadline only when explicitly requested; otherwise the session owns their
lifetime. Waiting through TaskOutput does not change that deadline. Both forms
retain bounded captured output when an execution deadline is reached. External
session cancellation, explicit interruption and session close must stop managed
background processes, including between model turns. Services expected to outlive
the session need an independently managed lifecycle.

Shell launch preparation is shared by the two process owners through
`tools/bash/provider.ts`: bounded executable-path discovery, one command's wrapper
and spawn arguments, and a fresh spawn-time environment. Cached entries contain
no session environment or command state. Foreground and background execution keep
their distinct deadlines, output handling and cleanup; preparation does not own
a child process or change tool-result text.

## Owner callbacks

- `onAssistantBlock(message, responseUuid)` records an incremental checkpoint.
  It must finish before that block can execute. SDK owners use strict append
  errors here. Checkpoints contain only new content, avoiding quadratic logs.
- `onAssistantMessage(message)` finalizes the response represented by
  `message.uuid`. Owners merge it with existing checkpoints, without duplicating
  content. Interrupted attempts finalize only their retained completed blocks.
- `onToolResultMessage(message)` records tool results independently of iterator
  delivery. Owners must not append them again when the public frame arrives.
  It also runs when the consumer closes before ordinary result delivery.
- `onHistoryCompacted(messages)` replaces the owner's retained model history.

The shared history recorder and transcript reader merge explicit local response
groups. Final usage is recorded once in a compact metadata record; see [the journal format](TRANSCRIPT.md). Legacy records remain readable. Resume at a public block UUID stops at
that checkpoint. Strict writes establish successful append ordering; they do
not imply filesystem fsync or transactional atomicity with external tool effects.

## Context capacity and caching

The loop's normal history is append-only. Per-result truncation happens at tool
settlement, not by repeatedly clearing old evidence. The loop never calls the
explicit `microCompact` or `apiCompact` utilities. One `TokenBudget` estimates
the complete effective request, including system, tools and injected messages;
valid input usage calibrates it, while missing usage leaves estimates active.
A session retains calibration across user turns, scoped to its provider, model,
thinking mode and unchanged request prefix. History rewrites reset it; closing
or clearing the session releases it. Resumed sessions estimate until fresh usage.
The user output ceiling is not an input reservation. Working input reserves at
most 20000 output tokens or one quarter of the window, unless explicit thinking
needs more room; it never reserves more than the work ceiling. Explicit thinking
retains the budget the provider could send under that ceiling, plus up to 1024
answer tokens. Actual work output is bounded by the user ceiling and remaining
estimated context, not by the smaller reservation. The pre-request summary trigger
is 90%, with a preferred size of 55%. This target allocates summary output and
recent-history space; it never rejects a useful handover solely for missing that size.

A summary reuses the effective model, system, tools, history and thinking mode,
then appends a handover instruction. No tool executor is attached. Maintenance has
its own bounded output allowance, independent of the work ceiling: up to 20000
text tokens or one quarter of the window, with explicit thinking added only to the
request allowance, never the handover text target. Available context can lower
the allowance without lowering effective thinking. A recovery
envelope already beyond the local working window is submitted to the provider;
only an actual input rejection starts ordered segmentation. Transient failures
retry the affected summary segment through the ordinary backoff budget, respecting
provider-exhausted retries and cancellation. Empty, truncated or tool-calling
responses permit one changed handover request. Summary usage counts before
validation and before any subsequent request; estimates never enter billing.

An explicit 400/422 output-parameter range rejection may lower the allowance once
per provider/model run, before any work content starts. It changes neither the
saved user ceiling nor the request history. The same evidence bounds subsequent
work and summaries in that run; switching models discards it. Ambiguous errors,
context overflows and limits incompatible with effective thinking are not output
corrections. Collected summaries require the provider's explicit pre-stream HTTP
rejection marker; an error from a response stream is not proof that content never
started. Validation and repair use the actual sent output allowance. No provider
catalog is guessed or probed by the loop.

When the provider rejects a summary's input, recovery first supplies only the
head being replaced. If that is still oversized, ordered tool-paired groups are
summarized and merged without silently dropping records. An oversized merge first
reduces its output reservation without reducing the effective thinking budget,
then shortens both ordered handovers if necessary. Each shortening must make
progress; every request shares the same 16-call budget. Truncation repair cannot
raise a reservation that overflow recovery already reduced. At most 16 summary
requests run per compaction, excluding bounded transport retries. A single
indivisible exchange or fixed context that cannot fit reports a capacity error.

History installation follows net-size reduction and the owner's asynchronous
`onCompact` checkpoint. Invalid or ineffective summaries cannot replace history.
Owners may reconcile private recovery state through `prepareCandidate` before
fixed-state budgeting and final progress checks. The returned candidate is the
one measured and persisted; recovery normalization must not mutate live history.
Failed writes and cancellation before checkpoint submission retain the old history.
A successful checkpoint write is installed even if cancellation arrived during
writing, so live state and restoration agree. Failed proactive summarization may
continue with intact history below estimated capacity. Without substantial new
work, another proactive summary is deferred, not treated as a task failure.
Reaching input capacity permits one further reduction; an actual provider overflow
permits one distinct recovery even immediately after a proactive summary. Repeated
rejection stops safely rather than looping or invoking `apiCompact`.
Goal, todos, active skill references, tool ownership and arrivals survive replacement.
Recovery reads the original transcript rather than repeating recorded side effects.

## Client tool context

`core/tool-context/` owns the presentation of MCP tools for native tool calling.
The session owns one mutable discovery state; one-shot queries and child
collaborator sessions create independent instances. Host policy enters through
`Options.toolDiscovery`, after the ordinary tool pool and deny filters. The
module knows no application accounts, workspaces or installation database.

The execution pool remains separate from the fixed provider declarations. A
local ToolSearch returns whole definitions as ordinary results. Only successful,
unchanged results acquire SDK-authored journal metadata, and discovery becomes
usable after strict result persistence. Completed CallTool blocks normalize to
real calls before checkpoints, hooks, permission checks and scheduling. Their
private origin metadata retains the exact wrapper for provider history; public
events expose real tool names. Ordinary calls keep streaming as before.

The MCP manager publishes a bounded revision signal for real definition or
availability changes. Owners refresh their filtered tool pool only at the next
model boundary; children filter that pool independently. Held MCP tools reject
changed or removed definitions before execution and after reconnection. Ordinary
discoveries never rebuild the catalog, change provider declarations or reconnect
a service.

Compaction reconciles one self-contained snapshot before candidate size and
net-progress checks. Full definitions already carried by retained, verified
search results are not rendered twice. Call origins and inert presentation refs
may require old definitions in private checkpoint metadata; those versions grant
no current execution access. Baseline carriers retain their user or summary text.
The journal reader validates metadata independently of visible prose and refuses
damaged new-format state. See [the journal contract](TRANSCRIPT.md).

An omitted option preserves full declarations; explicit XML/JSON modes do too.
Previously recorded histories without a new-format baseline remain full, even
when the host now supplies discovery policy. A configured new native session
with no deferred tools records only private format metadata on its first input,
with no additional model message or discovery entry points. The public
`readSessionToolContextMode` helper lets a host inspect this distinction during
actual preparation without reading private records itself.

## Verification

Deterministic tests hold the provider open until tools execute, proving real
overlap rather than earlier UI notifications. They cover modified permission
inputs, exclusive barriers, concurrency limits, interrupted streams, duplicate
IDs, backpressure, consumer closure, retained write results and actual session
resume. The offline streaming benchmark isolates overlap using identical
scripted provider events and a buffered control; it is not a model-quality or
Terminal-Bench score measurement.

## Idle execution retirement

`session-checkpoint.ts` transfers settled conversation and tool working state
between local execution objects. It is internal ownership plumbing, not a model
tool. Identity and workspace must match. A healthy persisted transcript owns
history; an in-memory session or a failed append retains messages in its
checkpoint. Re-enabling persistence writes a self-contained history checkpoint
before executing more work. Permission and tool configuration are rebuilt from
the host rather than copied from the old executor.

Tool working memory uses the session's configured storage directory and obeys
`persistSession: false`. Shell cwd/environment, todos, goal state and file-read
checks survive retirement. Background shell resources can be borrowed from the
collaboration owner so retiring an SDK execution object does not kill a command
or lose its output. Explicit interruption still stops those resources; final
host disposal releases them.
