/**
 * platform/memory -- Prompt Instructions
 *
 * The system prompt fragment that teaches an agent how to keep its memory.
 *
 * Every owner of a memory — a digital human, a space — uses the same three
 * parts (`# now`, `# History`, topics) with the same native file tools. What
 * varies is stated as inputs:
 *   - `owner`: a digital human is one long-lived persona and gets the full
 *     manual; a space is many unrelated conversations and gets a compact one
 *   - `mode`: whether a `# History` heading was pre-inserted for this turn
 *   - `tracks`: what the owner declared worth tracking (`memory_schema`)
 *   - `empty`: a space whose memory records nothing yet gets only what to
 *     record in it
 */

import type { MemoryTurnMode } from './types'

export type MemoryOwnerKind = 'digital-human' | 'space'

/** One item the owner declared worth tracking. */
export interface MemoryTrackedItem {
  name: string
  type: string
  description?: string
}

export interface MemoryPromptOptions {
  owner?: MemoryOwnerKind
  tracks?: MemoryTrackedItem[]
  /**
   * The memory records nothing yet (at most its skeleton). A space then gets a
   * few lines rather than the whole manual: most spaces are many unrelated
   * tasks, and most of their conversations never write memory at all.
   */
  empty?: boolean
  /**
   * Whether the digital human belongs to any team. Decided by membership, not
   * by whether this turn is a team turn: memory is shared by every turn, and a
   * chat with the owner can copy team state into it as easily as a team turn.
   * Unset keeps the team guidance.
   */
  inTeam?: boolean
}

export function generatePromptInstructions(
  mode: MemoryTurnMode,
  opts: MemoryPromptOptions = {}
): string {
  if (opts.owner === 'space') return opts.empty ? SPACE_EMPTY : SPACE_FULL
  const team = opts.inTeam !== false
  const parts = [
    INTRO.replace('{{MEMORY_LOADING}}', LOADING_BY_MODE[mode]),
    STRUCTURE.replace('{{MEMORY_HISTORY_WRITING}}', HISTORY_BY_MODE[mode]),
    SHARING
      .replace('{{OTHER_INSTANCES}}', team ? OTHER_INSTANCES_TEAM : OTHER_INSTANCES)
      .replace('{{TEAM_TOOLS}}', team ? ' If you need a teammate, use the team tools.' : ''),
    EXAMPLE,
    WHEN_TO_UPDATE.replace('{{MEMORY_HISTORY_UPDATES}}', HISTORY_UPDATES_BY_MODE[mode]),
    ...(team ? [TEAM_STATE] : []),
    HOW_TO_UPDATE,
    TOPICS.replace('{{TEAM_BOARD}}', team ? ' team-board state,' : ''),
    ARCHIVES,
  ]
  const tracks = renderTracks(opts.tracks)
  if (tracks) parts.push(tracks)
  return parts.join('\n\n')
}

/** `memory_schema` as the owner wrote it; nothing when there is none. */
function renderTracks(tracks: MemoryTrackedItem[] | undefined): string {
  if (!tracks || tracks.length === 0) return ''
  const lines = [
    '### What this memory tracks',
    '',
    'The owner declared what matters most for this digital human. Keep each item current —',
    'in `# now` if it is a current value, in a topic if it accumulates knowledge. These come',
    'on top of everything else worth remembering, not instead of it.',
    '',
  ]
  for (const t of tracks) {
    lines.push(`- \`${t.name}\` (${t.type})${t.description ? `: ${t.description}` : ''}`)
  }
  return lines.join('\n')
}

// ============================================================================
// Space
// ============================================================================

const SPACE_EMPTY = `
## Memory

This space has a memory shared by all its conversations; nothing is recorded yet.
Its \`memory.md\` is ready with two empty sections: \`# now\` (current facts, one
\`- key: value\` per line) and \`# History\` (\`## YYYY-MM-DD-HHmm | summary  [by: <your tag>]\`,
newest first). When a conversation produces something future conversations here
will need — a decision, a lasting preference, a verified fact about the project, a
procedure that worked — Edit it in under the matching heading. Most conversations
record nothing.`.trim()

const SPACE_FULL = `
## Memory

This space keeps a memory shared by all its conversations: \`memory.md\` with \`# now\`
(what is true now) and \`# History\` (what happened, newest first), and topics under
\`memory/topics/\` — one subject per file, lasting know-how. What you were shown when
this conversation started is a summary; Read the files for more.

Record only what a future conversation here will need: a decision, a lasting
preference, a verified project fact, a procedure that worked. Most conversations
record nothing.
- \`# now\`: short \`- key: value\` lines. Update in place with Edit; remove what is obsolete.
- \`# History\`: add \`## YYYY-MM-DD-HHmm | summary  [by: <your tag>]\` at the top.
- Topics: when knowledge on one subject settles, search the topics, extend one or
  create one, and leave a one-line pointer in \`# now\`. A topic file starts with
  front matter — \`name:\` and \`description:\` saying WHEN to read it. A folder groups
  topics; its \`index.md\` holds only that front matter. The topic list you were
  shown is generated — never copy it into memory.md.
- Write facts that stay true, never your progress on the current task.
- Other conversations write here too: Edit rather than rewrite, and if an edit is
  refused because the file changed, Read it again and merge.`.trim()

// ============================================================================
// Mode-dependent fragments
// ============================================================================

const LOADING_BY_MODE: Record<MemoryTurnMode, string> = {
  run: 'Your `# now` block is pre-loaded in the trigger message each run.',
  session: 'Your `# now` block was loaded into this session when it started, so it is already in context.',
}

const HISTORY_UPDATES_BY_MODE: Record<MemoryTurnMode, string> = {
  run:
    '**`# History` updates:**\n' +
    '- The system already inserted a heading for this run, stamped with your instance\n' +
    '- Edit your summary into it, before the tag:\n' +
    '  `## 2026-01-15-1430 | your summary here  [by: schedule#a1b2]`\n' +
    '- For important events, add `###` details below the heading\n' +
    '- For routine runs with no changes, a brief summary is sufficient',
  session:
    '**`# History` updates:**\n' +
    '- Write the whole heading yourself, newest at the top, ending with the instance\n' +
    '  tag you were given: `## YYYY-MM-DD-HHmm | your summary here  [by: ...]`\n' +
    '- For important events, add `###` details below the heading',
}

const HISTORY_BY_MODE: Record<MemoryTurnMode, string> = {
  run:
    '**`# History`** is your timeline. The system pre-inserts a `## YYYY-MM-DD-HHmm` heading\n' +
    'at the top before each run. You Edit in the summary after `|` and optionally add details.\n\n' +
    '- **Important events**: add a `###` sub-heading with details below the `##` timestamp\n' +
    '- **Routine events**: just fill in the summary — one line is enough',
  session:
    '**`# History`** is your timeline. No heading is written for you here, so add your own\n' +
    '`## YYYY-MM-DD-HHmm | summary  [by: ...]` entry at the top.\n\n' +
    '- **Important events**: add a `###` sub-heading with details below the `##` timestamp\n' +
    '- **Routine events**: just fill in the summary — one line is enough',
}

// ============================================================================
// Digital human
// ============================================================================

const INTRO = `
## Memory

You have a persistent \`memory.md\` file that carries state across sessions, and a
topic wiki next to it. \`memory.md\` has two top-level sections: \`# now\` (working
memory) and \`# History\` (timeline).
{{MEMORY_LOADING}}`.trim()

const STRUCTURE = `
### Structure

\`\`\`
# now                          ← working memory
## State | one-line summary    ← always first, keep it current
## [Entity Name]               ← per-entity tracking (optional)
## Patterns                    ← learned rules (accumulates)
## Errors                      ← failure lessons (compact)

# History                                ← timeline (newest first)
## YYYY-MM-DD-HHmm | summary  [by: ...]  ← one event; the tag names who wrote it
### details heading                      ← optional, for important events
\`\`\`

**\`# now\`** holds your current state. Use \`- key: value\` format, one field per line.
Each field is one fact. Each line is independently editable. The \`| description\`
after \`## State\` is your one-line summary of the current situation; add a
\`## [Entity Name]\` section whenever you start tracking a new item.

{{MEMORY_HISTORY_WRITING}}`.trim()

const OTHER_INSTANCES = 'a scheduled run, a chat with the owner, an IM conversation'
const OTHER_INSTANCES_TEAM = `${OTHER_INSTANCES}, a turn inside a team`

const SHARING = `
### One memory, many instances

This memory belongs to the digital human (the AI agent this app runs), not to
you. You are one instance of it —
one execution. Others may be running right now: {{OTHER_INSTANCES}}. You cannot
see them and they cannot see you. Memory is the one thing you share.

A \`# History\` entry ends with \`[by: ...]\` naming the instance that wrote it, and
the message that started your turn tells you which one you are. An entry whose tag
is not yours was written by another instance — read it as a colleague's note, not
as something you did. Entries written before the tag existed carry none: they could
be from any instance, so read them as history rather than as anyone's current work,
and never stamp one yourself.

So: work described as in progress belongs to the instance doing it. Do not pick it
up, continue it, or report on it as yours. If the user wants you to take it over,
they will tell you in this conversation — that hand-off is the only thing that
makes it yours.

Memory is a shared record, not a way to reach each other. Do not leave messages,
instructions, or claims for other instances in it, and do not wait on one.{{TEAM_TOOLS}}

When you are talking with a guest rather than your owner, do not reveal sensitive
content from memory to them.`.trim()

const EXAMPLE = `
### Example: Mature Memory

\`\`\`markdown
# now

## State | 3 items tracked, AirPods ¥1199 stable, MacBook ¥7999↑
- items_tracked: 3
- runs_completed: 84
- alerts_sent: 5
- JD scraping: stable on the mobile site → topic scraping/jd.md

## AirPods Pro (JD.com)
- current_price: ¥1199
- lowest_seen: ¥1099 (2026-01-08)
- last_change: 2026-01-10, ¥1299→¥1199
- trend: stable (5 days)

## MacBook Air M3 (Taobao)
- current_price: ¥7999
- lowest_seen: ¥7499 (2026-01-12)
- trend: rising

## Patterns
- prices are lowest on weekday mornings, highest on weekends
- user prefers notification only when price drops below previous lowest

## Errors
- Taobao layout changed 2026-01-11: use selector .price-current

# History

## 2026-01-15-1430 | routine check, no change  [by: schedule#a1b2]

## 2026-01-15-1412 | answered owner on alert threshold  [by: chat#0d71]

## 2026-01-15-1400 | MacBook ¥7999↑, alerted user  [by: schedule#a1b2]
### Price alert
- MacBook Air: ¥7499→¥7999
- exceeded previous highest, sent notification
\`\`\``.trim()

const WHEN_TO_UPDATE = `
### When to Update

Update memory **after completing your task, before reporting**. This is required.

Workflow: trigger → do work → compare results with memory → update memory → report.

**\`# now\` updates:**
- **Whenever state moved**: update State fields that changed, update the \`| description\`
- **When you learn something new**: add a line to Patterns or Errors
- **When tracking a new entity**: create a new \`##\` section under \`# now\`
- **When a field is obsolete**: remove it with Edit

{{MEMORY_HISTORY_UPDATES}}

**Record what helps future work.** Important discoveries, pattern changes,
and error resolutions deserve detailed recording. Routine unchanged checks
can be a single line.

Your \`# now\` was captured when this execution started. After long work, Read it
again before editing — another instance may have moved it since.

**Write what the digital human knows. Not what you are doing.**

A fact still true after you finish belongs in \`# now\`. Your own progress through
this execution does not — another instance reading it will think it is theirs.

- ✅ \`- current_price: ¥1199\`
- ✅ \`- user prefers alerts only below the previous lowest\`
- ✅ \`- release_status: notes drafted, waiting on QA sign-off\`
- ❌ \`- currently on page 3 of 12 of the crawl\`
- ❌ \`- waiting for the user to reply about the price threshold\`
- ❌ \`- TODO next: finish the Taobao selector fix\`

The state of the *work* is a fact about the digital human. Your position in it and
what you are blocked on are yours alone — put those in your report, not here.`.trim()

/** For a digital human in a team; its memory outlives every team conversation. */
const TEAM_STATE = `
**Never copy team state into memory.** Tasks, assignments, who is working on what,
findings, whether something is done — that lives on the team board and belongs to
ONE conversation. Open a new conversation and the board is empty by design; a copy
in memory outlives it and becomes a confident lie. Read the board every time, and
never conclude from memory that a task is assigned, in progress, or finished.

What does belong here is what you learned that stays true: what a teammate is good
at, how the team likes to work, where the recurring snags are.

- ✅ \`- Ada handles the DB migrations; ask before touching schema\`
- ✅ \`- releases go out Friday afternoon; QA needs 2h notice\`
- ❌ \`- task "run integration tests" assigned to Ada, in progress\`
- ❌ \`- I am the lead of the release team\`

The last one is there deliberately: which team you are in, and your role in it, are
told to you per turn. They are not facts about the digital human.`.trim()

const HOW_TO_UPDATE = `
### How to Update

Use **Edit** for all routine updates:

\`\`\`
Edit(memory.md, "- current_price: ¥1199", "- current_price: ¥1099")
\`\`\`

Fill in a History summary. The summary goes before the \`[by: ...]\` tag, which the
system wrote — carry it over unchanged rather than appending after it:

\`\`\`
Edit(memory.md,
  "## 2026-01-15-1430  [by: schedule#a1b2]",
  "## 2026-01-15-1430 | MacBook ¥7999↑, alerted user  [by: schedule#a1b2]")
\`\`\`

\`memory.md\` always exists — the system creates it with its sections in place — so
never Write it whole. Use **Read** to load sections not in context.

**Shared files.** Other executions write here too. Edit rather than rewrite, and
Read a file again before editing it if you read it a while ago. If an edit is
refused because the file changed, Read it again and merge — never overwrite.`.trim()

// ============================================================================
// Topics
// ============================================================================

/**
 * How a topic file and a category are written. Shared with the consolidation
 * agent, which must produce exactly the files this index reads.
 */
export const TOPIC_FILE_FORMAT = `
**Format.** Every topic file starts with:

    ---
    name: <short name>
    description: <WHEN to read it — the situations that call for it>
    ---

The description is all a future reader sees before deciding to open the page.
Write the trigger, not a summary: "when a visitor asks how to migrate a digital
human", not "notes about migration".

A category is a folder with an \`index.md\` holding only that front matter
(description = when to enter the folder). Do not list its contents; nest as deep
as the subject needs.`.trim()

const TOPICS = `
### Three kinds of memory

- \`# now\` — what is true right now across all your work. Short, overwritten often.
- \`# History\` — what happened, when, and by whom. Old entries are archived for you.
- **Topics** — what you know about one subject that stays useful for months.
  Files under \`memory/topics/\`, organised like an encyclopedia.

Ask of each thing you would record: *true right now?* → \`# now\`.
*Something that happened?* → \`# History\`. *Still useful a month from now?* → a topic.

### Topics

**The index is generated.** The Topics list in your starting message is rebuilt
from the files every time. Never copy it into memory.md or keep a list of topics
anywhere. To change an entry, edit that file's \`description\`; to reorganise,
move or rename files.

**Finding.** Before starting work, check the index. Enter a category whose
description fits the task, and Read the topics whose description fits before you
act. The index does not show everything — for the rest, search the topics folder:
\`Grep "keyword"\` for content, \`Grep "^description:"\` for what each page is for.
Follow links between topics when they are relevant.

${TOPIC_FILE_FORMAT}

**Growing it well.**
- Search before you create. Extending a page beats opening a near-duplicate.
- One subject per page, readable in one go. When a page stops being that, split
  it into sub-topics inside a category.
- Link, don't copy: \`[IM routing](../im/routing.md)\`. One fact lives in one place.
- Rewrite in place to keep a page true; delete what turned out wrong.
- For facts that can go stale, note where and when they were verified.
- When the index gets long and flat, group related topics into categories.

**When.** You may create and edit topics whenever you learn something lasting. At
the end of a task, look at \`# now\`: anything that has settled into lasting
knowledge moves to a topic, leaving one pointer line
(\`- <subject>: <current state> → topic <path>\`). Tag the History entry
\`[topic: <path>]\`, before the \`[by: ...]\` tag.

**Not in topics:** progress on the current task,{{TEAM_BOARD}} credentials or
secrets, one-off facts no one will need again.

**Examples.** Before creating your first topic, call \`memory_status\` — it returns
worked examples of topic pages (FAQ, codebase, customer service).`.trim()

/** Worked examples, handed out by `memory_status` rather than sent every turn. */
const TOPIC_EXAMPLES = `
**Examples**

FAQ — \`visitor-faq/migration.md\`

    ---
    name: Moving a digital human
    description: a visitor asks how to move a digital human to another machine or edition
    ---
    ## Can memory come along?
    Export carries persona and schedule only. Copy the memory folder by hand,
    Halo closed first; the app id changes. (verified in code, 2026-09-24)
    ## Pitfalls
    - old absolute paths inside memory need cleaning — see [paths](../paths.md)

Codebase — \`code/memory-module.md\`

    ---
    name: Memory module
    description: changing or explaining how memory, topics or consolidation work
    ---
    ## Map        where each responsibility lives
    ## Decisions  what was chosen and why (the why is the valuable part)
    ## Pitfalls   what broke before and how it was fixed

Customer service — \`support/refunds.md\`

    ---
    name: Refunds
    description: a customer reports a billing error or asks for a refund
    ---
    ## Cases      situation → standard answer → when to escalate, to whom
    ## Tone       what this customer base responds well to`.trim()

/**
 * Everything about writing topics, for whoever is about to write one: the
 * `memory_status` tool and the consolidating agent.
 */
export const TOPIC_GUIDE = `${TOPIC_FILE_FORMAT}\n\n${TOPIC_EXAMPLES}`

const ARCHIVES = `
### Archive Files

Memory runs coarse to fine: \`memory.md\` → \`memory/topics/\` → \`memory/archive/\` and
\`memory/run/\`. Start with \`memory.md\` and the topic index; go deeper only if the
detail you need is not there.

- **\`memory/archive/\`** — \`memory.md\` as it stood before each consolidation
  (\`YYYY-MM-DD-HHmm.md\`). Older ones may sit directly in \`memory/\`.
- **\`memory/run/\`** — one record per automation run, named
  \`YYYY-MM-DD-HHmm-run-<app>.md\` (\`-error-\` when it failed). Rarely needed; filter
  rather than open in full: \`Grep "keyword"\` in that folder.

### Growth and Consolidation

Keep \`# now\` short — it opens every run and session, and past a size limit only its
first sections are shown. When a section of it keeps growing around one subject,
that subject has become a topic.

When memory grows — \`# now\` getting long, History getting long, or the file getting
large — the system consolidates it in the background: settled knowledge moves from
\`# now\` and old \`# History\` into topics, and older History entries are archived.
You do not need to manage its size, but tidy as you go.`.trim()
