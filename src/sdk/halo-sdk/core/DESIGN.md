# Core execution and history

The core owns model turns, tool admission, execution and conversation history.
Session owners supply persistence callbacks; core does
not import their state. These modules are internal collaborators, not separate
public entry points.

The default execution implementation is in `native/crates/halo-core/src/core`.
`engine.rs` composes a session owner with the shared `loop_runtime.rs`;
`public_loop.rs` supplies the low-level generator's external owner through
`loop_owner.rs`. JavaScript capability ownership and public types remain at the
Node boundary. The TypeScript loop files in this directory are not executed.
The implementation names below describe their corresponding
Rust modules unless a `.ts` file is named explicitly.

## Preset instructions

`Options.ultraEffort` defaults to false. It selects only the task-effort and
failure-response guidance within `How you work`; identity and all other guidance
remain the same. The normal mode emphasizes efficient use of the token budget.
UltraEffort encourages fuller investment, varied approaches and useful parallel
collaboration with at most four active agents including the source agent. This is
prompt guidance, not a new runtime concurrency limit.

The option is independent of provider reasoning `effort`, prompt profiles,
permissions, budgets and completion checks. It stays in the stable system prefix
across model switches and is inherited by child sessions. Complete custom
system-prompt strings are not rewritten. The native Harness catalog is the text
source for work and communication guidance; the TypeScript prompt helpers use its
generated baseline. Communication is shared by both modes.

## Streaming and scheduling

`streaming.rs` assembles provider events into immutable completed blocks. Only
complete JSON objects are eligible for execution. Malformed arguments produce
an error result. Duplicate tool IDs, restarted messages and mutations of closed
blocks terminate the attempt. Interleaved blocks wait for earlier blocks to
complete before admission; newly introduced block indices must be increasing.
Legacy custom providers without block-stop events are admitted only after their
iterator finishes successfully.

The owner records each completed block before its tool can start. Public frame
UUIDs remain the transcript checkpoint UUIDs. A separate local response UUID
groups one attempt, independently of provider IDs, which providers may reuse.
Text-only failed content is discarded while reported usage is retained.
Successful text-only responses use the
same journal at completion.

`tool_execution.rs` separates preparation from execution. Preparation applies
hooks, permission decisions and schema validation to a copy of model arguments.
`tool_scheduler.rs` prepares the queue head, checks concurrency against the
effective input, then starts eligible work. Safe calls overlap up to the per-turn
limit. An unsafe call waits for earlier work and blocks later work. No scheduler
state is shared across sessions. Arbitrary tool hooks require conservative
serialization; an ordinary host permission callback does not disable parallel
safe execution.

`loop_runtime.rs` drains model frames, tool progress and tool-owned messages
through one backpressured channel. Tool execution must not wait for the provider
to finish before its messages can be consumed. The API duration stops when the
model iterator finishes, before the remaining tool execution tail is drained.

JavaScript-facing Read, Write and Edit calls enter the canonical-path queue
before asynchronous dispatch. Write and Edit retain the caller's read record
at admission, so an earlier operation cannot grant a queued call a newer read.
Independent paths can overlap; model-loop scheduling remains a separate boundary.

## Failure and cancellation

Completed end-turn responses containing only whitespace or thinking retry the
retained request at most twice, without adding instructions or empty assistant
messages to model history. Each response's reported usage and elapsed turn still
count toward the ordinary budgets. Exhaustion reports an error instead of empty
success. An empty completion-check response retains the preceding usable answer.
Usage already reported by an interrupted attempt is accounted and finalized once
before retry reset, even when no tool was admitted. Transport retries check the
execution budget before another request; missing usage is never estimated as billing.
Discarded responses retain private accounting metadata without invoking the public
completed-assistant callback or adding failed content to model history.
The same bounded recovery applies when a tool-use finish contains no actual call.
An empty refusal, stop-sequence or other terminal response reports its stop reason
without resubmission. Empty output after the existing truncation or unreadable-call
recovery budget is exhausted is an error, never empty success. Explicit refusal
text remains an ordinary visible response.

Complete provider responses also retain reported usage when tool arguments are
unreadable. They expose an optional diagnostic and withhold executable calls from
that batch; summary validation can therefore repair the response without losing
its accounting. Prompt-based tool modes use the same bounded unreadable-call
recovery and report an error after exhaustion. Valid JSON data without a tool-call
envelope remains an ordinary answer. Supplied scalar or array arguments and XML
values outside the message JSON domain are never replaced with empty objects or
internal transport markers for execution. Missing or null argument envelopes
retain compatibility with parameterless calls. Existing public parser helpers
retain their separate compatibility contracts.

Both HTTP model adapters share a bounded UTF-8 SSE decoder. It accepts fragmented
bytes, CR/LF/CRLF, an initial BOM and multiline JSON data. Complete single-line
JSON records retain compatibility with servers omitting blank separators. Invalid
JSON, invalid UTF-8 and non-object data fail the attempt rather than silently
dropping content. Undecoded data is limited to 32 MiB. Existing retry admission
rules still prevent replay after a tool checkpoint; a damaged usage tail cannot
invalidate or replay an already finished OpenAI response.
OpenAI tool names are assembled before announcing their argument stream, so a
fragment cannot select another tool sharing its prefix. Earlier tool identities
retain announcement order. Late IDs keep buffered arguments; structured argument
values are serialized without dropping fields. Identity changes, name changes
after announcement and conflicting structured/string argument fragments fail the
attempt before admission rather than changing the selected action.

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

Public result events contain one tool result each, in admission order. Model
history and the owner's durable result callback retain the complete batch once.
The individual events share that batch's UUID, which identifies the existing
journal record for resume and fork; event consumers correlate individual outcomes
by `tool_use_id`. A later provider retry cannot discard completed outcomes.

Foreground Bash commands have a default execution deadline. Background commands
have a deadline only when explicitly requested; otherwise the session owns their
lifetime. Waiting through TaskOutput does not change that deadline. Both forms
retain bounded captured output when an execution deadline is reached. External
session cancellation, explicit interruption and session close must stop managed
background processes, including between model turns. Services expected to outlive
the session need an independently managed lifecycle.

Shell launch preparation is shared by foreground and background execution through
`tools/shell.rs` and `tools/shell_platform.rs`: bounded executable-path discovery, one command's wrapper
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

## Manual compaction

A standalone `/compact [instructions]` is intercepted before user input enters
model history. A single text-only input envelope is equivalent to a string;
multimodal, batched and in-flight additions retain their ordinary input semantics.
The session command owner invokes the same summary, usage, discovery reconciliation
and strict checkpoint path as automatic compaction. It uses `manual` hook and
boundary triggers and reports maintenance usage without starting a work-model
turn. A failed summary or checkpoint retains live history; a committed checkpoint
is installed even when cancellation arrived during its write. Cancellation keeps
the session available for the next input. No safe reduction is reported as an
unchanged context, without a successful compact boundary.

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

The execution pool remains separate from the fixed provider declarations. Native
model steps retain typed tool selections: a declaration and its MCP connection
owner, configuration revision and definition fingerprint are captured together.
Only the declaration reaches the provider.
The fixed `CallTool` declaration takes an argument object. A bounded decoder at
the completed-call admission boundary also accepts legacy encoded objects and
unambiguous formatting repairs. It preserves the original envelope and repair
receipt in private history; target selection, discovery, permissions and execution
remain in their existing modules. Search results present `invoke_via`, `targets`
and `arguments_schema`, independently of private definition fingerprints.
Plain assistant text is never an execution request in native tool mode. Replacing a service with an identically
named and shaped service cannot redirect a call already admitted for the old owner.
A local ToolSearch returns whole definitions as ordinary results. Only successful,
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
Preset prompts include service instructions once per service represented by the
current filtered eager pool, including full-declaration modes. Labels and guides
are JSON-encoded untrusted usage reference, not permission or action authorization;
existing instructions and safeguards retain precedence. Deferred guides
remain in verified search results rather than the initial system prompt. Catalog
refresh invalidates eager instructions along with definitions; ordinary discovery
does not change the system prefix. An explicit system-prompt string remains a
complete replacement and receives no automatic service instructions.
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

`collaboration_adapter.rs` and the session owner transfer settled conversation and tool working state
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
