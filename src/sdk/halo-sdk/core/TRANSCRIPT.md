# Session transcript journal

A transcript is an append-only JSONL journal. The main session and each collaborator
have separate files. Conversation messages preserve UUID and parent UUID links
in write order; metadata annotations point to the preceding message without
advancing this conversation chain.

Completed assistant blocks are appended before their tools become eligible to
execute. Each block keeps the UUID exposed by the live stream. Blocks belonging
to one local response attempt share `responseUuid`; provider message IDs are not
used for grouping because providers may reuse them. Execution checkpoints reject
on append failure. Completed tool results are recorded independently of public
iterator consumption, including cancellation cleanup.

Streamed `assistant` records contain block content but omit `message.usage`.
Finalization appends one `assistant_metadata` record with the same `responseUuid`
and the final response ID, model, usage, stop reason and stop sequence. This record
has no content. It avoids copying the entire response and prevents cumulative
usage snapshots from being counted once per block. Metadata writes are advisory:
failure is logged, but does not prevent the tool results from being recorded.
Legacy whole-response assistant records retain their existing format and usage.

History restoration joins consecutive assistant blocks only when their local
response and agent scope match. Metadata does not enter model history. Resuming
at a public block UUID stops at that exact block. Paginated transcript reads count
only visible messages and merge final metadata into the last included assistant
block for its response; they do not produce an empty metadata bubble. Readers may
look past the end of a page through non-message metadata, within the existing byte
budget, but stop before the next visible message. A page ending before a response's
last block does not inherit that response's usage.

## Compaction checkpoints

Main-session result records reuse their emitted user-frame UUID. Forking at a
completed search result therefore includes its committed discovery; the preceding
assistant-call checkpoint does not. A fork or explicit resume boundary saves its
inherited history in a strict checkpoint before new work, so reopening the branch
does not depend on the source session's later records.

Clearing a discovery-format session uses the same strict checkpoint ordering:
save a fresh baseline first, then replace live history and discovery state. A
failed reset keeps the previous state. The original journal is never deleted,
and a reset requires no model request.

Compaction appends a private `compact_checkpoint` record with `checkpointVersion: 1` for legacy history,
`uuid`, `summary` and `messages` (the complete reduced model history). The usual
session, timestamp, sidechain and parent UUID fields remain present. The checkpoint
annotates the preceding conversation record without advancing its UUID chain.
Original messages are never removed or rewritten. Public transcript pages, even
with system messages enabled, do not expose checkpoints or count them as chat.

Tool-discovery history uses `checkpointVersion: 2`. Its messages include a
self-contained, versioned tool-context baseline followed by any retained discovery
deltas and original call wrappers. Definitions are verified before installation;
missing or invalid tool state cannot downgrade a new checkpoint to legacy history.
Legacy version 1 remains readable and cannot carry tool-context metadata.

Ordinary messages carry private `toolContext` fields for baselines, committed
discoveries, presentations and call origins. Presentation references identify
complete definitions and guides actually delivered by a successful search,
including an explicit re-display that creates no new discovery. They never grant
tool access. A direct-call marker preserves an eager call's original form if a
later configuration makes that tool deferred. Once a writer enters this mode, its JSONL records
start with `toolContextVersion: 1`; `toolContextRecord` distinguishes records
that require private metadata from ordinary work messages. A resumed owner marks
the writer before appending, without rereading the file. This keeps the mode
detectable in a bounded tail even when the original baseline is no longer there,
and losing a required private field cannot resemble a legacy record.
Reader grouping merges private fields alongside completed blocks and tool
results, respecting each public message UUID. Public transcript pages omit the
private fields and internal directory notices. Final response-accounting records
do not repeat call origins.

Host hooks may surround a search payload with ordinary tool-result text. The
execution owner records that envelope only for the internal search instance;
settlement accepts the exact original payload within it, with the complete
result still subject to character and UTF-8 byte limits. Optional presentation
offsets identify the JSON span in UTF-16 code units, allowing checkpoint dedup to
verify definitions without interpreting surrounding host text. Bare payloads
keep their original metadata shape. Replaced or truncated payloads do not commit.

Parallel searches reconcile after their output hooks settle, in result order.
Only the first surviving delivery of a definition emits its discovery delta.
Later ordinary matches become references; explicit re-displays retain the full
schema with presentation metadata alone. Failed or unsettled results cannot own
a discovery or suppress a later successful definition or guide.
Cancellation during a search's output hook records a bounded error instead of
the unaccepted schema text. Completed business-tool results retain their normal
cancellation semantics; discovery is internal readonly state, not an external
effect that must be reported as completed.

Compacted baselines retain prior definition versions privately only while a
retained call origin or presentation references them. These historical definitions are neither
model-visible recovery instructions nor renewed discovery or execution grants.
Rejected calls carry their own record, so a direct call refused by the runtime
does not masquerade as a successful normalized call with missing metadata.

Before candidate size and progress checks, compaction keeps one current baseline
and removes redundant internal baseline attachments. A baseline on a real user
message is stripped without dropping that message's body. Retained old discovery
deltas cannot restore a definition absent from the current snapshot. The recovery
attachment omits schemas already delivered completely in retained search results,
verified against presentation metadata and the exact payload; a missing guide is
restored independently. The private snapshot still holds every current definition,
so a later compaction can restore it after those search results leave the tail.
`baselineAttachment` distinguishes disposable SDK notices from user or summary
messages carrying the same metadata. Only an explicitly marked attachment may
be removed or omitted from public history. Empty recovery state attaches to the
existing summary instead of introducing an empty model message; the summary body
survives later checkpoint reconciliation.

A damaged tool context, or one whose baseline fell outside the bounded history
read, refuses resume even without the optional strict legacy-resume setting.
A later valid, self-contained checkpoint can establish a complete recovery state.

`QueryLoopOptions.onCompact(messages, summary)` is an async durable-checkpoint
callback. The loop awaits it before installing reduced history, invoking the
synchronous `onHistoryCompacted` callback, or emitting `compact_boundary`.
Sessions and collaborators use their existing serialized write queues with strict
error propagation. A failed checkpoint does not install the candidate history;
cancellation before checkpoint submission leaves the original history unchanged.
Once the write succeeds, the loop installs that same checkpoint even if cancellation
arrived during the append, then settles cancellation before another model request.
This keeps disk and live history consistent; original records remain recoverable.
Generic history rewrites still use only `onHistoryCompacted`.

Restoration replaces active history only after a complete, valid checkpoint has
been parsed. Checkpoint messages are already grouped: neither pre-checkpoint
responses nor later responses may merge into them. Subsequent ordinary records
append normally, and an explicit earlier public message UUID still restores the
original prefix. Invalid, unsupported-version or truncated checkpoints count as
damage without clearing the previously readable history. Legacy Claude Code
`system/compact_boundary` followed by summary records remain supported.

Checkpoints are limited to 4,096 messages and 16 MiB of encoded JSON per record,
including metadata. Writers reject larger candidates before appending, rather
than committing history that the bounded reader cannot restore. This is below
the JSONL line limit of 32 MiB and the retained history budget of 64 MiB (which
accounts for two bytes per encoded byte). Normal tens-of-thousands-token summaries
fit within these bounds. Existing tail-read and retained-message limits still
apply; omitted records are reported rather than silently treated as complete.

Append completion is not an fsync or an exactly-once transaction with external
tool side effects. A process or machine failure between a tool effect and its
result record can still leave an unknown outcome; history repair must not invent
success or silently replay it.
