# Work history

How a reply's work reads in every chat surface: one folded line above the
reply, opened to a timeline. `WorkHistory` draws it; `ThoughtProcess` (live)
and `CollapsedThoughtProcess` / `LazyCollapsedThoughtProcess` (saved) own its
state. Both derive from the same incremental `ThoughtPanelModel`
(`../thought-utils`).

## Reading order

| Layer | Shows | Opened by |
|---|---|---|
| Folded line | Saved: "Work process · 33 min" with a History icon. Live: a spinner and the task in progress, else "Replying…" while words are written, else the latest activity, else "Working…"; plus "Tasks i/n" | — |
| Timeline | What the AI said along the way (muted), records received, lines of their own (session notice, compaction, sub-agent task, engine error), and between them each stretch of operations as one line; then the task plan | the folded line |
| Stretch | Its steps — tools and reasoning — one line each; long lists scroll below their summary, opening at the end of the latest `GROUP_PAGE` steps, with earlier steps on request | its line |
| One step | Halo's existing detail: `ToolResultViewer`, raw input, `NestedToolTimeline`, `ErrorContent` | its line |

- A stretch's line sums up its counted kinds in order of first appearance
  ("Ran 5 commands, searched 3 times and read 1 file", `group-summary`) and,
  live, names the step still running in the primary color. A stretch with
  at most one operation is drawn as its own lines (reasoning, then the
  operation), so that operation opens its result in one click.
- Reasoning and session notices are never counted. The session notice
  ("Connected | Model: …", which model answered) is the work's first line, as
  it always read: quiet, with nothing to open, never inside a stretch. It
  alone does not make a reply's work worth opening. Titles never say
  "thinking": the work is more than reasoning.
- The task plan is the latest TodoWrite (`TodoCard`); TodoWrite is never a
  step line.
- A reply whose steps hold nothing but its answer (and session notices) has no
  folded line. Separated thoughts decide this from their digest.
- Trace views (`showOperations`: run detail, the team workbench) open every
  stretch from the start.

## Rules that are easy to break

- **A tool's error is not a failure of the reply.** The harness answering a
  command or search with an error is normal work the AI reads and moves on
  from. Nothing in the work says "not successful" or "no result" on a line;
  only that tool's own icon is tinted (faint amber), for whoever goes looking.
  Engine errors (`error` steps) keep their red icon, and how a reply ended is
  the reply's own note.
- **One spinner.** Only the header spins while the reply runs; a running
  stretch keeps its tool icon and names the operation in progress in the
  primary color (reasoning in progress is what the header's "Working…"
  already says, so the stretch does not repeat it); a running step is drawn
  in the primary color.
- **Lines end at a fixed length.** Every line in the work shares
  `../process-line` (shape, cue, detail indent) and cuts its subject to
  `PROCESS_SUBJECT_COLUMNS` columns (a CJK character counts two), reasoning
  folded onto one line. What opens repeats a command or path only when its
  line cut it short — by that length or by a narrow window, measured when it
  opens — then the result, then a quiet footer (time · duration · raw input).
- **What the person opened stays open.** `view-memory` keeps, per transcript,
  whether each reply's work is open and which stretches and steps inside it
  are (`group:<first step id>` / step id). The running reply is remembered as
  `LIVE_WORK`; when its saved reply appears the view moves to it
  (`TranscriptWorkView`). A reply that finished with its work open shows the
  steps it streamed while its saved steps are read once, then the saved ones
  (they can differ: a tool result that lands as the turn stops is saved, not
  streamed). A reply finished folded is not read or kept in memory. A step
  the person opened keeps its stretch open when the next step joins it, until
  they fold the stretch. A digital human's saved steps are rebuilt with new
  ids, so only the work itself reopens there. Hosts without a memory (trace
  views) keep choices only while drawn.
- **A saved work is read once.** Opening it and reopening it on mount share
  one read (`LazyCollapsedThoughtProcess`).
- **Icons follow the tool family.** `operationIcon` gives MCP tools the icon
  of what they are (collaborator, message, team, browser, terminal, web
  search, skill, image), the same family `group-summary` counts them under;
  only a tool Halo knows nothing about keeps the generic `{}`.
- **Received records are lines.** A teammate's or another conversation's
  message inside the work is icon + sender + clipped summary, opening to its
  text. A notice the runtime wrote for the coordinating AI (no sender) reads
  "Team progress", with its text only when opened.

- **Each sentence once.** The words under the work are never repeated in it.
  Saved: `answerTextIds` takes the latest text steps whose words end the answer
  (a stopped reply's last words included). Live: the reply's latest words stay
  in `StreamingBubble` — never moved into the work, so they keep the body color
  — and `liveTextIds` takes the text steps that bubble already shows: the
  engine joins every text block since its last substantive tool into it, so
  the whole run is matched, however long. The
  owner keeps that set's identity while it names the same steps, so a folded
  `ThoughtProcess` is not redrawn per token. Words shown below do not split
  the stretch around them.
- **Cost follows what was said, not how much ran.** The timeline is built only
  while open; an entry whose steps did not change keeps its identity, so only
  the stretch being worked on is drawn again. A stretch draws its steps only
  when opened, a page at a time; the timeline draws its latest
  `TIMELINE_PAGE` entries. The store's per-step copies and keeping every tool
  output in memory are not solved here.
- **A step's line never changes shape when opened.** A long command or path
  is repeated whole as the first line of what opens.
- **In-progress states only while live.** Saved steps can keep a streaming
  flag or miss a result; saved, a tool without a result is a plain line whose
  detail says "No result".
- Nothing here asks the model for a summary or reads the clock: the duration is
  measured between the reply's own first and last step.
- A compaction is a `system` step with `compaction` set
  (`shared/compaction-step`), recorded where the engine reported it. Older
  readers show it as a plain notice.

Not part of this module: how a reply ended before its answer was done is the
reply's own note (`../ReplyEndingNote.tsx`, from `metadata.ending`), and the
conversation's temporary team bar is `../../team/TeamCollabBar.tsx`.
