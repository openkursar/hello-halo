# Team task workbench

## Ownership and boundaries

This directory owns the task workspace's presentation and navigation. Persistence,
viewer relationships and lifecycle admission belong to
[`apps/team`](../../../../main/apps/team/DESIGN.md) and `apps/runtime/team`.
A task and a selected member are separate navigation coordinates. Selecting a
member must not change the task or grant access to another person's private chat.

`TaskRoom` composes the conversation, decisions and execution observation.
`TaskConversation` and `model.ts` project persisted messages into human exchanges
and compact coordination. `TeamSessionChat` remains the shared team session
transport and streaming surface. `TaskExecutionView` reuses the chat thought/tool
components; it does not implement another tool renderer. The task activity drawer
contains the selected task's team record, not a cross-task notification feed.

## Interaction contract

The renderer has one task selection and a three-column workbench. Task activity
is a modal drawer bound to that selection; it has no independent task selector.
It contains unfinished work, outputs, coordination history and internal member
reports. Switching the selected digital human changes only the member view inside
the current task. Every team member uses the same conversation and execution
renderer; a teammate-owned digital human is read-only and keeps its ownership
boundary visible where the composer would otherwise appear.
The team header keeps the selected task visually primary: the team goal is
available on demand instead of occupying a persistent subtitle. Sidebar group
names describe the task source plainly; inbound channel work is labelled as IM
conversations, while unrelated work in the same team is labelled as other tasks.
Answers occur in the room, scoped by the persisted question's execution id,
never by a member-wide waiting flag. The sender picker targets only the viewer's
own installed digital humans. Member-rail selection is task observation for every
member and preserves the current task and per-member draft; it never opens a
separate direct channel. Member details remain a separate explicit action in the
member summary. One owned member renders a static identity instead of a selector.
The client remembers the last task per team and member choice per task. An
explicit decision entry instead selects the relevant member and question.
New-task guidance explains this scope and links to active tasks. Member work
links navigate to that task and, when owned, that member; status does not inject
another task's context into the current conversation.
Internal member conversations expose the latest execution as a collapsed row
below collaboration messages, with the existing thought/tool rendering on expansion.
Human-facing conversations use their normal process display without a duplicate
status row. Completed internal execution stays collapsed; older rounds remain in
execution history. Task activity can drill into a member's execution inputs, persisted results and live work using
the existing thought/tool components. Read-only state snapshots recover local
work already in flight; remote work uses the existing stream and replicated
history. Missing execution events are reported as unavailable, not interpreted as
a stalled agent. Conversation subscriptions are reference-counted across mounted
views so closing an inspector does not unsubscribe the chat beneath it.

Decision requests occupy their creation time in the member conversation. Their
request and answer are also append-only team activities, so every teammate sees
the blocking question and its resolution while only the digital human's owner
receives controls. Another person's decision never enters the viewer's "Needs my
decision" group. A fixed
composer reminder locates unanswered requests, switching the owned member when
needed. Answered cards retain the answer and timestamp with an expandable original
question. The activity store supplies this history after reopening; pending team
detail supplies immediate requests, and response events update the same records.
When a tool receipt identifies the request, its card follows that turn's thought
panel, before the persisted reply. Live requests follow the streaming work;
unmatched historical requests retain their own timestamp position.

Task rooms contain human exchanges with the selected member, interleaved
with compact coordination segments. Only directed messages involving that member
in the selected task qualify; prior collaboration does not expose unrelated acts.
Consecutive coordination is grouped between human exchanges, collapsed by default,
with the latest three messages on expansion and a link into full task activity.
Delivery failures remain visible. A member's conversation becomes human-facing
from its first human input in that task: later assistant results remain in the
conversation even when a teammate or system notification resumes the work.
Earlier internal results are not backfilled, and other member/task histories do
not confer this audience. Raw team inputs remain outside human message bubbles.
Internal assistant results from conversations without human input and shared
board records stay in task activity. Actual system inputs (turn-end reports,
periodic checks and run starts) appear there as collapsed notification records,
with consecutive notices grouped per recipient and full input text on expansion.
Human-facing results are not duplicated in task activity.
Activity groups are newest first by their latest record; expanded groups and
conversation coordination previews retain chronological order. Interacting with
the activity history holds its visible records steady; newly arriving records
are revealed through an explicit update button instead of shifting the reader.
The room and drawer share one task board read; live events merge into that board.
The transcript trigger carries team origin and correlation; display routing uses
that provenance only, never message text. Invalid timestamps retain their records
with an unknown-time label and sort after dated records. Activity loads member reports on demand with
bounded concurrency and refreshes them on history notifications. A missing
report is shown as unavailable rather than silently treated as empty.
Task grouping prioritizes the human creator over member involvement. Completion
is a filter/status within that relationship, not a separate destination.

## History resources and rendering limits

`team/session-history.ts` shares a transcript between chat, member reports and
the execution inspector. The first explicit read uses the existing full-history
API; subsequent reads merge the changed sequence tail while a reader remains
mounted. The last reader releases the retained transcript.
`workbench/execution-state.ts` similarly shares one polling loop per execution
and stops it when the last observer leaves.

The conversation renders 50 rows per page, task activity renders 50 groups per
page with at most 20 records per group, and execution history renders 30 turns
per page. These are DOM limits, not server-side history pagination: opening a
large history still incurs its initial full response and in-memory projection.
The team detail's 500-record live window is a refresh buffer, not the complete
selected task history.
