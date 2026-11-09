# Grouped worker runtime

`@hello-halo/agent-sdk/worker` is a Node-only, opt-in execution boundary. Importing
it starts nothing and does not load the agent loop. `createWorkerRuntime()` owns
a reusable pool; `initialize()` warms one worker by default. A ready worker has
loaded the SDK, not merely emitted Node's `online` event. Concurrent initialization
and acquisition share that startup. The ordinary SDK entry remains in-process.

The runtime owns placement, RPC, callback cancellation, stream backpressure,
health, retirement and shutdown. Core sessions own the loop, tools, history and
collaborators. Group keys are opaque affinity hints. Sessions never migrate; multiple
groups may share a worker, and a group may span workers. Capacity is a placement
target, not a limit on historical conversations or a refusal of new work. The
host owns the total thread budget: omitted `maxWorkers` or `Infinity` imposes no
SDK worker-count ceiling; a positive integer is enforced as a hard bound. The SDK
does not derive a limit from CPU count. New sessions expand the pool on demand,
while initialization creates only the finite warm count. Empty workers above the
warm minimum expire. An uncapped pool is still subject to OS and memory limits;
it does not provide unlimited throughput or move already assigned sessions.

Only cloneable options cross the boundary. `Options.skillCatalog` crosses as
metadata and source references, including an authoritative empty array; session
creation validates and freezes it inside the worker. Skill bodies remain on disk
and child collaborator sessions inherit the session's catalog rather than
rediscovering skills. Permissions, hooks, elicitation and
in-process MCP handlers remain host callbacks with cancellation. Custom providers
and native custom tools are created by an optional worker-side setup module,
specified by an absolute module URL; functions are never evaluated from strings.
The setup module receives session options and cloneable setup data. It must be
Node-compatible and must not import a desktop application runtime.

In-process MCP metadata crosses as plain service descriptions and instructions,
plus complete tool definitions. The bridge retains each configured server key and
original tool name separately from the normalized model-facing name. Neither
tool metadata nor server instructions grant permissions or select loading policy.
Duplicate normalized tool names are refused before a name-keyed pool can hide one.

Both public entries expose `readSessionToolContextMode(sessionId, options)` for
hosts preparing a resumed session. It reads bounded, validated SDK history at
the optional message anchor and returns the recorded `deferred` or `full` format,
independently of currently configured services. Missing, corrupt or unlocatable
anchored history raises the existing resume error. Importing the Worker entry
does not read a transcript or load its reader; inspection starts only on a call.
The standalone helper parses and validates on its calling thread. UI hosts use
`runtime.readSessionToolContextMode` to run the same validation in the existing
pool: a temporary reservation owns cancellation and cleanup, without creating an
agent session, connecting tools or invoking a model. Reads honor caller and
shutdown cancellation, and release the reservation on both success and failure.

The private host/worker protocol is version 5. The host and bundled worker must
agree on this version before creating sessions. Explicit `codeSearch` options
are cloneable configuration; the service itself stays in the host and is exposed
through the existing cancellable callback RPC. Matching workspaces and backend
settings share the host's lazy search service across SDK workers and in-process
sessions. Setup modules cannot enable or replace the host's search backend.
Preparation failure, session disposal, and worker failure release its ownership.

The host also encodes a private canonical read-deny floor for the configured
search cache. It survives setup changes, including removal of `codeSearch`, and
is inherited by child collaborator sessions. Built-in file readers enforce this
floor even when CodeSearch is filtered from the tool pool. The host search callback
independently preserves its original source restrictions and cache floor for
every request;
changing a request's workspace cannot reinterpret the host's relative rules.
This is a built-in tool policy, not a filesystem sandbox for setup code, Bash,
or custom tools. Without search configuration, no cache restriction is added.

The host proxy owns accepted input synchronously. Posting a command alone is not
completion: ordinary sends await acknowledgement, consumption receipts release
pending input, and withdrawal awaits the execution-side decision. Failure retires
the proxy and errors its stream, rather than silently replaying possibly executed
tools. Goal reads and writes are asynchronous on this surface. History stays in
the worker. Stream batches have count/byte limits and acknowledgement-based flow
control; a slow reader backpressures execution without losing final messages.

Closing a session first rejects new work, aborts pending callbacks and execution,
then drains hooks, streams, MCP and persistence. A new session resuming the same
transcript waits for retirement. Interrupt never terminates a shared worker.
An unresponsive worker has a bounded deadline and retires all its sessions;
replacements are demand-driven with a crash circuit breaker. Workers cannot
isolate native crashes or process-wide exhaustion.

Read/Edit/Write use a host-coordinated lock keyed by the canonical path, shared
by all runtimes in the host. A dead worker's locks are released only after Node
confirms its exit. The lock coordinates SDK tools, not unrelated filesystem
writers or separate host processes. Session transcript ownership is also held
until close finishes. Lifecycle logs and a diagnostics snapshot expose counts,
pending operations, stream backlog and worker health without user content.

The host callback registry uses `AsyncResource` to preserve its session's async
context across worker messages, following Node's worker-pool guidance. Thread
counts, idle expiry and placement targets are separate policies, as in mature
worker pools; long-lived bidirectional sessions retain their own lifecycle rather
than being represented as one-shot jobs.

References: [Node worker-pool async context](https://nodejs.org/api/async_context.html#using-asyncresource-for-a-worker-thread-pool),
[Piscina pool configuration](https://github.com/piscinajs/piscina#constructor-new-piscinaoptions).

Abrupt worker exit is not graceful session disposal. The host terminates tracked
process groups after exit, but on POSIX a terminated child can retain a zombie
wait status until the host exits when Node has destroyed its owning worker's
process handle. Normal disposal awaits child closure. Crash tests distinguish a
running orphan from this terminated OS bookkeeping state; worker threads do not
provide a process-supervisor or native-crash boundary.

External MCP connections own their preparation before the first asynchronous
handshake. Concurrent connection requests share one attempt; disconnect, removal
and disposal invalidate that attempt before closing it. A late success or failure
cannot publish over a replacement connection. HTTP requests retain cancellation
through response-body consumption, SSE feeds and their POSTs share a connection
lifetime, and session preparation aborts pending MCP handshakes. Session disposal
awaits preparation unwind so these resources cannot return after a close receipt.

The independent SDK workflow runs worker/MCP regressions and records the same
synthetic benchmark on Windows, Linux and macOS with Node 20/22/24. Workflow
configuration is a validation mechanism, not evidence that the matrix has run.
Low-end Windows measurements and the host application's packaged tests remain
separate acceptance items.

Placement reads active collaborator counts from the shared collaboration runtime
through `getRuntimeStats()`, including collaborators that produce no frames on
the source session's stream. The counts are constant-time metadata; no task
descriptions or history are copied for scheduling. Foreground and background
shell execution likewise share one bounded provider cache keyed by
shell-selection environment, so a prewarmed worker cannot substitute another
session's shell path.

Advisory end hooks have a cancellation signal independent of the already stopped
turn. The runtime cancels them halfway through its close deadline, leaving time
for persistence and resource release. Custom preparation can also be abandoned
without creating a late SDK session. Extension modules still own resources they
create outside SDK APIs and must respect their preparation signal.

On Windows, Git Bash can replace a POSIX process without preserving its native
Windows parent chain. Shell termination combines a bounded native process
snapshot with the shell installation's POSIX process table before calling
`taskkill`. Concurrent terminations share only in-flight snapshots; completed
snapshots are not cached. This work runs only during termination and is asynchronous. The
supervisor forwards the shell context to the host so abrupt worker exit uses the
same cleanup path. If discovery is unavailable, native tree termination remains
the fallback and emits a diagnostic warning. File snapshots compare opened
handles on Windows because path-based `stat` can report a different device ID.
