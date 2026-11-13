# Native SDK boundary

`crates/halo-core` contains host-independent execution modules. It has no
Electron, Halo application, Node or Node-API dependency. `crates/halo-node`
converts the public JavaScript facade's calls into core operations through
Node-API. Browser consumers of collaboration protocol helpers do not load this
binding.

The default package entry routes execution and computational helpers through this
facade. The optional Worker entry runs the same core in its worker's JavaScript
environment; it does not select another execution implementation. Public runtime
exports retain their existing signatures, and the `module-sync` and `import`
conditions resolve to the same module instance.

`NativeRuntime` accepts standard `providerConfig` on sessions and one-shot
queries. It constructs that provider before the optional setup module, matching
the Worker runtime's preparation order. An explicit configuration overrides the
legacy Anthropic credential path; an incomplete configuration fails before
session creation instead of selecting ambient credentials.

The JavaScript facade owns JavaScript callbacks and public iterator objects.
Pure redaction helpers use an explicit versioned wire document into `JsValue` and
`JsText`, preserving lone UTF-16 code units and non-finite truncation limits.
Header values remain caller-owned references; only header names and reference
indices cross this boundary. JavaScript retains ordinary property enumeration
and assignment semantics, while the core owns masking and truncation decisions.

Scalar token estimation, tool-result truncation and cache-boundary splitting use
direct Node-API UTF-16 strings. Their core algorithms share borrowed UTF-8 and
UTF-16 views; ordinary internal UTF-8 calls do not first copy the entire input
into code-unit arrays. This boundary preserves lone units and embedded NULs. It
returns UTF-16 ranges for cache-boundary splitting so the facade can retain slices
of the original prompt without copying both results through Node-API. It does not
change the separate message, tool-payload or history transport contracts.

The public XML tool-call parser uses the shared UTF-8/UTF-16 JSON grammar and
returns typed text and values. Parameter own properties and the resulting
prototype travel in separate, explicit control fields; JavaScript restores the
object shape without interpreting model-supplied keys as transport markers.
The existing model-message parser still projects own properties into its JSON
domain and rejects text that this boundary cannot represent. That projection
does not establish lossless message, tool or history transport.

Model arguments and retained transcript messages use plain JSON semantics.
Literal business keys matching private transport markers remain ordinary data
through policy callbacks, execution, provider history and resume. Model JSON
parsing preserves JavaScript numeric semantics within that domain and rejects
unrepresentable values; model argument JSON has a bounded nesting depth. Encoded
configuration options and public scalar helpers retain their separate contracts.

`HostBridge::call_data` declares a lossless callback boundary separately from the
legacy JSON callback path. Hosts must implement it explicitly; unsupported hosts
return an error instead of narrowing data to JSON. Operation IDs and callback
methods belong to the private control envelope. Payload keys cannot create
callbacks or signals. Host errors can retain a typed data payload alongside the
metadata used for retry and error-reference routing. This capability alone does
not make legacy session or history callers lossless.

Public MCP clients retain caller-owned arguments, tool definitions and response
objects in JavaScript; only protocol metadata and operation-scoped reference
receipts cross the typed boundary.

The public in-process MCP bridge likewise keeps schemas, arguments and raw
results in JavaScript. An asynchronous call returns an explicit reference receipt;
its synchronous Node formatter borrows the original values only for that call.
Core chooses content branches, feedback and image limits, while Node performs the
selected property accesses, coercions and `JSON.stringify`. Borrowed values and
their JavaScript environment never cross an asynchronous boundary.

The core owns execution history, accepted input, tool working state and task
cancellation. A callback request identifies one session-owned operation; its
cancellation travels back to JavaScript so stopping Rust's wait also stops the
host operation. Public stream envelopes and callback control envelopes cross a
bounded channel. Neither layer holds a second authoritative conversation history.

Live input is accepted synchronously under the core inbox lock. The acceptance
receipt establishes ownership before JavaScript returns. Consumption and
withdrawal receipts release the corresponding callback records exactly once.
Closing refuses new input before cancelling execution, and disposal waits for
resource and transcript cleanup.

Native execution uses a shared asynchronous runtime, not a process or thread
pool per session. Tool and collaboration state is session-owned. File lock
coordination may span sessions, but does not hold conversation content or policy.

`HostServices` carries environment-scoped search and HTTP trust capabilities;
execution resource activity remains separate. Node owns one trust-material store
per environment, and collaborator owners capture that capability when created.
Retiring a parent cannot select another trust source for its children. HTTP clients,
credentials and request state remain with their execution or provider owners.
Node updates certificate material on its own thread before HTTP work; a changed
trust generation affects later client preparation. This adds no JavaScript
constructor parameter. Where Node cannot enumerate its default CAs, the existing
native trust source remains in use, and verification must state that compatibility
limit explicitly.

The build script emits a platform-qualified `.node` library and a manifest with
its source identity. Native loading errors are explicit; the loader has no
fallback runtime.

TypeScript source tests load the SDK's `dist/native` library only after its build
identity matches the current native sources. The source loader and builder share
one fingerprint implementation. Compiled package loading reads the manifest and
library identity without scanning source files.

The package build retains the JavaScript dependency closure of every declared
runtime entry and the Worker dispatcher. Retired executable JavaScript and its
source maps are removed; declarations remain available for the public contracts.
The native manifest, platform libraries and license notices are explicit assets.
Unclassified dynamic module loads stop the build before pruning. Host setup
modules remain absolute file URLs supplied by the embedding host, and the
collaboration protocol entry is checked independently for browser compatibility.


The session actor and the public low-level generator share `core/loop_runtime`.
`LoopOwner` supplies input, accounting observations and persistence callbacks;
the loop does not fabricate a session or journal for an external owner. Completed
blocks cross the owner's checkpoint before their tools start. A consumer closing
its iterator still allows completed effects to reach the owner's result callback.
The low-level generator acknowledges each yielded frame on the next pull, so a
caller returning after initialization cannot accidentally start a model request.

Shared JavaScript contexts refer to narrow Rust cost and file-read stores. A
cost store belongs to one loop run; file-read state belongs to its execution owner.
Retaining a context after a tool finishes does not redirect it to another tool or
a later run. Caller-supplied maps and services keep their JavaScript ownership.

Skill catalog views use the execution instance's initial identity and effective
Harness scope. Rust selects and retains each metadata snapshot; JavaScript keeps
one immutable array, entry and source view until that owner retires. Session
release notifications reuse its activity callback, including for retired children;
loop and standalone callback scopes release their views when closed. These views
retain no session, callback transport or conversation history.

`HostServices` groups environment-owned capabilities supplied before execution:
the search pool and immutable HTTP trust material selected by that host. Node
creates this capability scope independently for each JavaScript environment;
children inherit their owner's scope. Session resource activity remains separate,
and HTTP clients, credentials, requests and cancellation remain execution-owned.
Host trust is supplied as data, never added to model options or conversation
history. A host's explicit empty trust set is distinct from an absent capability.

Public compaction operations return private origin receipts for retained history,
attachments and callback-created messages. The JavaScript facade uses those
receipts to preserve caller object and array references. It retains references
only for the operation, without another authored history payload. Internal
compaction uses the same origins to track retained replies across index changes;
a checkpoint transformation that clones messages clears their prior identity.

Low-level loop discovery handles share Rust state with their execution owner.
A catalog change creates replacement state, so a handle retained from an earlier
callback continues to refer to that earlier catalog. An unchanged catalog reuses
its existing handle. The JavaScript facade supplies public object identities and
the caller's tool references; discovery decisions remain in the core.

Harness templates and resources are classified under `halo-core/src/harness`.
Each execution resolves immutable shared templates for its current model; cached
source data and pending errors retain their provenance rather than another model's
rendered feedback. Build-generated JavaScript baseline assets serve synchronous
constants and error classes without loading a native library or maintaining a
second authored text source. Native model execution uses the resolved Rust catalog.
Skill invocation and recovery envelopes, and MCP wire feedback, use fixed
protocol resources borrowed from the immutable baseline. Model wording overrides
cannot change those parsed structures; wrappers consumed only by the model remain
templates.

Ordinary sessions acknowledge the `running` and `init` admission boundaries when
the iterator advances. Input remains queued until the running boundary is consumed,
and a model request cannot start while the consumer is paused at initialization.
Tool progress and tool-authored messages use the same consumption acknowledgements;
returning at a tool announcement cancels its pending execution. Token stream events
continue through bounded asynchronous queues without a synchronous acknowledgement
for every token. Replacing or returning a session iterator drains its cancelled
boundary before another reader can observe a later turn.
Replacement cancels the old turn before waiting for a pending JavaScript read to
return. Concurrent replacement requests admit only the latest reader. Rust claims
queued input and updates stream/running state under the same inbox lock; an
interruption observes the old state before cancellation can finish that actor.
This prevents a second terminal boundary from ending the replacement reader.

Node liveness combines execution and owned-resource activity independently. An
idle listener holds neither reference. Preparation, interruption and closing keep
short delivery receipts until their observable boundaries reach the JavaScript
owner. Resource cleanup finishing does not release the final error or closed
delivery prematurely. Forced environment shutdown cancels these receipts directly.
Background output pipes and persistent transports retain their own resource
leases; a model turn becoming idle cannot release another resource's reference.

Session closure and physical process retirement have distinct completion points.
Logical closure stops admission, marks background tasks stopped and flushes the
session. An opaque retirement handle owns only process registries and transport
close jobs, so natural cleanup does not retain conversation history. Node retains
that handle until cleanup finishes and aborts it when its environment exits.
The Worker and host runtime force and await their own handles after flushing,
within their existing shutdown deadline. Native process counts remain separate
from JavaScript child-process handles; only the Rust owner may signal or reap its
processes. Public raw MCP transports retain their original close grace period.

Session tool-result frames await consumer advancement before the next model
step consumes live input. A live input remains withdrawable while the consumer
handles that frame. Ordinary sessions do not emit another user replay frame for
these host-owned inputs; low-level query owners retain their replay contract.
