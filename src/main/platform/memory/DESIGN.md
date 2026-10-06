# platform/memory -- Design Document

> Status: V4.3 — shared compact memory instructions, native file tools, agent consolidation with deterministic merge, write guard, owner settings

---

## 1. Model

Memory is plain markdown on disk, edited by the agent with its own file tools
(Read/Edit/Write/Grep). It has three parts, mirroring how a person remembers:

| Part | Like a person's | Answers | Where | At turn start the agent sees |
|---|---|---|---|---|
| `# now` | working memory | what is true right now | `memory.md` | bounded text |
| `# History` + archives | episodic memory | what happened, when, by whom | `memory.md`, `memory/run/`, `memory/archive/` | headings |
| Topics | knowledge | what is known about one subject | `memory/topics/` | a generated index |

`memory_schema` (digital-human spec) sits beside this: it says *what* a digital
human should track, not how memory is organised. It is rendered into the memory
instructions as "Declared tracking fields"; it adds focus, not a recording whitelist.

Owners:

| Owner | Scope | Written by | Read-only for |
|---|---|---|---|
| Digital human | `app` | its runs, chats, IM threads, team turns | — |
| Space | `space` | every conversation in the space | digital humans (opt-in per digital human) |
| User | `user` | reserved; resolvable, not wired | — |

Each memory has owner settings (`shared/types/memory.ts`): on/off, automatic
consolidation on/off, and a cadence (`diligent` default, `balanced`,
`economical`). A space keeps them in its preferences, a digital human in its
overrides; both are edited from settings screens that also show the memory's
size, its last consolidation, and a "consolidate now" button.

This module is the file side of all of it. It never calls a model and knows
nothing of runs, chats or apps beyond the owner kind its prompt is phrased for.
The consolidating agent lives in `services/memory-consolidation`.

---

## 2. Layout

`resolveMemoryLayout(caller, scope)` is the only place a memory path is composed.

```
memory.md                 # now + # History
memory/
  topics/                 topic wiki (agent-written)
    visitor-faq.md
    halo-product/
      index.md            category: front matter only
      migration.md
  run/                    one record per automation run (system)
  archive/                memory.md before each consolidation (system)
  .snapshots/             memory.md + topics/ before each consolidation (system)
    initial/              the first one, kept for good
  .consolidation/         a running consolidation's private copy (system)
  .state.json             last consolidation, last attempt, cooldown (system)
```

Base directory: app → `appDataPath` (default `{spacePath}/.halo/apps/{appId}`);
space → `{spacePath}/.halo` (the space's data directory, never its working
directory, so memory stays out of the user's project files). Compaction archives
written before `archive/` existed remain directly in `memory/`.

---

## 3. memory.md

```markdown
# now
## State | one-line summary          ← always first
- key: value
## [Entity]
## Patterns
## Errors
- JD scraping: stable on mobile → topic scraping/jd.md   ← pointer into a topic

# History
## 2026-01-15-1430 | summary  [topic: scraping/jd.md]  [by: schedule#a1b2]
### details
```

- Timestamps are `YYYY-MM-DD-HHmm`, local time. Automation runs get their heading
  pre-inserted by the system; sessions write their own.
- `[by: origin#id]` is stamped by the system (runs) or given to the agent
  (sessions) and names the execution that wrote the entry. Many executions share
  one memory; the tag is how a reader tells a colleague's note from its own work.
  Untagged legacy entries are never backfilled.
- `[topic: path]` is optional and links an event to the topic it belongs to.
- `memory.md` never lists topics. The index is generated (§4).

---

## 4. Topics

A topic file opens with front matter:

```markdown
---
name: Moving a digital human
description: a visitor asks how to move a digital human to another machine or edition
---
```

`description` states **when** to read the page, not what it contains — it is all
a future reader sees before deciding to open it. A category is a folder whose
`index.md` holds only that front matter; its contents are never listed by hand.

**The index is generated** (`scanTopics` + `renderTopicIndexLines`) from the files
for each opening memory snapshot and never written anywhere. Resumed turns read
current files on demand. A stored list would drift from the files, and a
consolidation could drop a line and orphan a topic.

- Categories first, then files; files carry `.md`, folders `/`; sizes shown.
- Breadth-first within a 6KB budget: the whole top level always, deeper levels
  while the budget lasts, the rest folded into `… N more in <folder>/` or a topic
  count. The budget bounds the prompt, not the wiki.
- Missing front matter / `index.md` is flagged in the index for the agent to fix.
- When folded, the agent is told to enter folders or `Grep "^description:"`.

There is no limit on topic count or size. Growth is steered by the instructions
(search before creating, one subject per page, link rather than copy, group into
categories) and by consolidation.

---

## 5. A turn

```
start   ensureMemoryFile(layout, owner) — the skeleton, when memory.md is missing
          or blank (a run's pre-inserted heading creates it the same way)
        buildMemorySnapshot(layout) → renderMemorySection(snapshot, opts)
          # now (up to a limit, cut at a `##` boundary with a note) ·
          History as "N entries" + the newest few titles ·
          generated topic index (6KB budget, shared with any read-only topics)
        instructions: generatePromptInstructions(mode, { owner, tracks, inTeam, layout, authorTag })
work    agent Reads/Edits memory.md and topics with native file tools
          shared format, mature example and topic front matter already in the system prompt
end     run record (automation only) · requestConsolidation (services)
```

| Caller | Instructions | Memory block |
|---|---|---|
| Automation run (`apps/runtime/execute.ts`) | shared compact format + digital-human policies, `run` | trigger message; `# now` ≤16KB, 8 History titles; heading pre-inserted |
| Digital-human chat / IM / team (`apps/runtime/app-chat.ts`) | same format + digital-human policies, `session`; trusted author tag in session configuration | first message of the session, same limits; no live-instance roster |
| Space chat (`services/agent/space-memory.ts`) | same format + selective-recording policy; trusted author tag in session configuration | first message of a new conversation; `# now` ≤8KB, 3 History titles |

All enabled memories receive the same annotated structural template, three-way
classification rule and mature-memory example, including empty memories. The template
explains `State`, optional entity/`Patterns`/`Errors` sections, signed History entries
and topic front matter. Examples teach short summaries with detail below, without
per-entry character limits. Run instructions demonstrate filling the pre-inserted
heading; sessions obtain the local time only when writing an entry, never guess it.
Owner policies differ in what deserves recording, not in the file format. Stable instructions
stay in the system prompt; actual memory is read with Read/Grep/Glob and updated with
Edit/Write. There is no memory-status MCP server or tutorial-fetch requirement. The
startup block carries data and locations, not another copy of the instructions.
Digital-human policies add continuity, tracked fields, guest privacy and team-state
boundaries without turning ordinary questions into mandatory memory writes. Runs
still fill their pre-inserted History heading before reporting.

The skeleton is the sections and nothing in them (`# now` / `## State` / `# History`),
created on first use rather than when a space
or app is created, and never over a file that holds anything. The agent's first
write is therefore an Edit under the writers' lock, like every later one, and
the instructions never teach creating the file. A memory is *empty*
(`snapshot.blank` for the file) while memory.md holds at most its
skeleton. The topic tree is tracked separately and remains visible even when the
file itself is empty; an empty file is rendered as "nothing recorded yet" instead
of its headings.

A digital human is one long-lived persona and leans on continuity; a space is
many unrelated conversations, so it gets the current facts and the index and
reads the rest on demand. With memory turned off, no
instructions, block, heading, run record or automatic consolidation is produced.
Digital-human sessions retain a read-only write guard; space chats omit memory
setup. The settings' manual "consolidate now" action still works on existing files.

The team guidance in a digital human's manual (never copy team state into
memory; the team tools) is given by membership (`inTeam`, from any team), not
by whether the turn is a team turn: every turn shares the memory, and a chat
with the owner can copy team state into it as easily.

A digital human may be offered its space's topics read-only (setting
`spaceMemoryAccess`, default off) — in the opening snapshot, guests' included. They are
listed one level deep after its own topics, from what is left of the shared
budget, with a note to refer to them by path rather than copy them into its own
memory, so knowledge is not held twice.

**Guests and other restricted turns.** Guests read and write the same memory as
everyone else; their History entries are signed `im-guest#xxxx`, and the
instructions ask, in one sentence, not to reveal sensitive memory content to
them. What "memory" means for a restricted turn is its content only
(`memoryContentPaths`: memory.md + topics — never run records, archives,
snapshots or state), plus the space's topics when both "use workspace memory"
and the space's memory are on. The file boundary around it — memory always,
workspace files only with a granted tool, the space data folder closed — is
`apps/runtime/turn-file-access.ts`.

---

## 6. Concurrency

**One lock per memory**, keyed by its `memory.md` path, covering the file and the
data directory (`acquireMemoryLock` / `withMemoryLock`). Every writer takes it:

- this module's writers (History headings, consolidation swap, History trim);
- the agent's file tools, through the **write guard** (`guard.ts`): engine hooks
  around `Write`, `Edit`, `MultiEdit`, `NotebookEdit` — one matcher entry per
  tool, because the Halo engine matches names exactly or by `prefix*`, never as
  an `A|B` alternation. A write into a memory takes the lock before the tool runs
  and releases it after (PostToolUse / failure / denial). A call refused after
  the guard ran never reaches a post hook, so the same agent's next write
  releases it; a 15s lease covers the rest. A writer that waits 30s is refused
  with a reason, never left hanging.
- A waiter that times out gives up its place without emptying the queue: the
  entry is cleared only once everyone ahead has released.

`hooks` is one engine option shared by every concern that watches tool calls;
all of them add through `addSdkHooks` (services/agent/sdk-config), which merges
event by event.

All path comparisons — here, in the consolidation workspace confinement and in
a restricted turn's file boundary — go through `foundation/path-containment`:
a path argument read as the engines read it (`resolveToolPath`: `~` expanded, no
environment variables), then compared with links resolved (a path not created
yet through its nearest existing ancestor) and case folded where the filesystem
ignores case (`canonicalPath` / `isPathWithin`). A Glob pattern reaches the
folder up to the last separator before its first wildcard (`globSearchRoot`).

The guard also refuses writes into system-managed paths (`run/`, `archive/`,
`.snapshots/`, `.consolidation/`, `.state.json`) and into memories the session
may only read (space memory for digital humans; its own memory when turned off).

Staleness — editing over content someone changed since reading it — is left to
the engine: its Edit/Write refuse a file modified since the agent last read it,
and the lock makes that check race-free. The instructions tell the agent to
re-read and merge on such a refusal.

Engines without hooks (Codex) degrade: no lock and no read-only boundary for the
agent's tools, logged once per process; the instructions still ask for
edit-don't-rewrite. Shell writes to memory files are out of scope.

**System writes never expose a missing file**: writes are temp-then-rename,
archives are hard links, and a consolidation never removes memory.md. If an
opening snapshot nevertheless finds it unavailable, the agent is told to re-check
the path, not recreate a file from a stale snapshot.

---

## 7. Consolidation

**When** (`isConsolidationDue`): any threshold of the owner's cadence crossed,
not cooling down, and not within the cadence's minimum interval since the last
attempt —

| Cadence | memory.md | `# now` | History entries | min interval |
|---|---|---|---|---|
| diligent (default) | 100KB | 8KB | 30 | 1h |
| balanced | 200KB | 16KB | 60 | 4h |
| economical | 400KB | 32KB | 120 | 12h |

The `# now` threshold never exceeds the owner's injection limit
(`MEMORY_SECTION_LIMITS`: space 8KB, digital human 16KB), so a `# now` too large
to be shown whole is soon consolidated rather than cut every turn.

After an attempt that did not commit, automatic attempts wait until memory.md
has grown: 20% after the first failure, doubling per consecutive failure up to
3× (`consecutiveFailures`, `cooldownUntilBytes` in `.state.json`); a commit
clears both. "Consolidate now" ignores thresholds, interval, cooldown and busy.

With automatic consolidation off, memory is not reorganised. Only History is
kept bounded (`isArchiveDue`): over its entry limit, or the file over its total
size — never because of `# now` — it is trimmed (archived first) to
`historyKeepFor(cadence)` entries. That is recorded apart from attempts
(`recordArchive`: `lastArchivedAt`), counts as no failure and sets no interval,
so turning automatic consolidation back on acts at once. Only when the file is
still over its size afterwards does archiving for size wait until it has grown
20% (`archiveCooldownUntilBytes`); otherwise every new entry would archive it
again.

An agent (`services/memory-consolidation`) reorganises the memory; this module
owns everything that must hold regardless of how the agent behaves:

| Step | Here | Guarantees |
|---|---|---|
| prepare | repair a swap a crash interrupted; copy memory.md + topic files into `.consolidation/<id>/` under the lock, with a baseline (content, per-file stats and hashes) | the live memory stays fully usable for the minutes the agent takes |
| moves | `moveWithinWorkspace` (the agent's `memory_move` tool) records every move/removal; removal requires `merged_into` | every required topic is accounted for |
| validate | `# now` + `# History` present; no topic list in memory.md; every topic described; every required topic present or moved/merged; topic bytes (all non-hidden files, same measure as the baseline) not down >40%; History trimmed if over the cadence's limit. Failure reasons are written for the agent | structural soundness, no silent loss |
| commit — merge | under the lock, before anything else: History entries the live file gained or rewrote are carried into the result (whatever else changed) — a rewritten entry replaces its old text where that still stands, matched in full; anything else goes in by timestamp; nothing is removed. Topics added, changed or removed live that the agent left untouched (same content as the baseline) are copied/removed in the workspace; a topic removed on both sides is agreement | nothing written meanwhile is lost, and nothing that can be decided mechanically is handed to the agent |
| commit — conflict | memory.md outside History changed, or a topic both sides changed: the live memory is untouched; its full current content goes to `.incoming/` in the workspace and the result lists exactly what to merge — nothing truncated or omitted | the agent sees all of what it must merge |
| rebase | when a conflict is handed to the agent, the live memory becomes the baseline at once; topics that appeared meanwhile become required, removed ones stop being required. From then on the next commit takes the workspace as the merge — completing it is the agent's part, which the harness keeps asking for until a result is accepted (services/memory-consolidation) | the next commit compares against what is really live |
| swap | snapshot (`initial` kept forever, 3 rotating), topics/ first then memory.md (archived by hard link), hidden files of the old topics tree carried over; a failure restores both | memory.md never points at topics that did not arrive; every swap is restorable — topics only until 3 more consolidations have committed (memory.md also stays in `archive/`) |
| fallback | when the agent runs out of rounds: History trimmed only if over its limit | History is bounded; `# now` and topics are never cut mechanically |

---

## 8. Files

```
src/main/platform/memory/
  index.ts          public surface; MemoryService (run records, instructions)
  types.ts          scopes, MemoryService, CONSOLIDATION_THRESHOLD_BYTES
  paths.ts          resolveMemoryLayout — the only path composer
  permissions.ts    who may write which scope through this module
  file-ops.ts       lock, atomic write, History heading, archive link
  topics.ts         front matter, scan, generated index
  snapshot.ts       buildMemorySnapshot and heading parser (pure reads)
  section.ts        renderMemorySection — the block a turn opens with
  prompt.ts         shared format + instructions (mode × owner × tracks), TOPIC_FILE_FORMAT
  guard.ts          engine-hook write guard
  consolidation.ts  file side of consolidation: assess, prepare, validate,
                    commit/rebase, trim, .state.json

src/shared/types/memory.ts                settings, status, cadences (renderer-safe)
src/main/services/memory-consolidation/   the consolidating agent, harness, scheduling, space controls
src/main/services/agent/space-memory.ts   space chat wiring
src/main/apps/runtime/turn/memory-lifecycle.ts   digital-human wiring
src/main/apps/runtime/memory-control.ts          digital-human status / consolidate now
src/renderer/components/memory/MemorySettingsPanel.tsx   the shared settings UI
```
