/**
 * platform/memory -- Prompt Instructions
 *
 * Generates the system prompt fragment that teaches the AI how to use memory.
 *
 * All callers (automation runs, app chat) use native file tools
 * (Read/Edit/Write) on memory.md directly. Only `memory_status` is
 * available as an MCP tool for structural metadata checks.
 */

import type { MemoryTurnMode } from './types'

/**
 * Generate system prompt instructions for memory usage.
 *
 * The instructions are the same wherever the digital human works — one memory,
 * one set of habits. `mode` varies only the two mechanical facts that genuinely
 * differ (when `# now` reached its context, whether a `# History` heading was
 * written for it). What is worth recording stays its own judgement.
 */
export function generatePromptInstructions(mode: MemoryTurnMode): string {
  return MEMORY_INSTRUCTIONS.replace('{{MEMORY_LOADING}}', LOADING_BY_MODE[mode])
    .replace('{{MEMORY_HISTORY_WRITING}}', HISTORY_BY_MODE[mode])
    .replace('{{MEMORY_HISTORY_UPDATES}}', HISTORY_UPDATES_BY_MODE[mode])
}

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
// Memory Instructions
// ============================================================================

const MEMORY_INSTRUCTIONS = `
## Memory

You have a persistent \`memory.md\` file that carries state across sessions.
It has two top-level sections: \`# now\` (working memory) and \`# History\` (timeline).
{{MEMORY_LOADING}}

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

{{MEMORY_HISTORY_WRITING}}

### One memory, many instances

This memory belongs to the digital human (the AI agent this app runs), not to
you. You are one instance of it —
one execution. Others may be running right now: a scheduled run, a chat with the
owner, an IM conversation, a turn inside a team. You cannot see them and they
cannot see you. Memory is the one thing you share.

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
instructions, or claims for other instances in it, and do not wait on one. If you
need a teammate, use the team tools.

### Example: Mature Memory

\`\`\`markdown
# now

## State | 3 items tracked, AirPods ¥1199 stable, MacBook ¥7999↑
- items_tracked: 3
- runs_completed: 84
- alerts_sent: 5

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
- price drops >10% are usually flash sales, revert within 48h
- user prefers notification only when price drops below previous lowest

## Errors
- JD anti-bot: switch to mobile User-Agent header
- Taobao layout changed 2026-01-11: use selector .price-current

# History

## 2026-01-15-1430 | routine check, no change  [by: schedule#a1b2]

## 2026-01-15-1412 | answered owner on alert threshold  [by: chat#0d71]

## 2026-01-15-1400 | MacBook ¥7999↑, alerted user  [by: schedule#a1b2]
### Price alert
- MacBook Air: ¥7499→¥7999
- exceeded previous highest, sent notification
\`\`\`

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
what you are blocked on are yours alone — put those in your report, not here.

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
told to you per turn. They are not facts about the digital human.

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

Use **Write** only for first-time creation or full restructuring, and **Read** to
load sections not in context.

### Archive Files

Your memory lives in **\`memory.md\` → \`memory/\` → \`memory/run/\`** — coarse to fine,
recent to historical. Always start with \`memory.md\`; go deeper only if the detail
you need is not there.

- **\`memory/\`** (root) — Compaction archives (\`YYYY-MM-DD-HHmm.md\`): snapshots of
  memory.md taken before the system compacted it.

- **\`memory/run/\`** — One markdown record per execution, named
  \`YYYY-MM-DD-HHmm-run-<app>.md\` (\`-error-\` when it failed), holding the trigger,
  outcome, duration and final text. **In most cases you do NOT need them** —
  \`# History\` is sufficient. When you do, filter rather than open in full:
  \`Bash("grep -il 'keyword' memory/run/*.md | head -5")\`
  The name is stamped when the record was written, so it is close to — not the same
  as — the \`## YYYY-MM-DD-HHmm\` heading of the same event.

### Growth and Consolidation

**\`# now\`** sections stay compact. Consolidate when a section exceeds ~20 lines:
- Merge related Patterns into general rules
- Remove Patterns that turned out to be wrong
- Remove obsolete Entity sections or fields

**\`# History\`** grows naturally — the system archives old entries on its own, so
you do not need to manage its size.
`.trim()
