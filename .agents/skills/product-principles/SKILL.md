---
name: product-principles
description: Halo's product design principles. Halo is a performance-sensitive Electron app — performance first, features restrained, never block startup or user interaction; the AI is a partner, not a tool; users never have to learn the tool; a working AI hears new messages at once. Read before adding, keeping or reshaping a user-visible feature, background work, or how the AI talks to people, and before recommending whether a feature should exist.
---

# Product design principles

Halo is a performance-sensitive Electron app. Startup speed and UI
responsiveness come first; features come second. Design starts from restraint
(the VS Code philosophy): a feature ships only if it is clearly necessary, or
its cost is low.

## 1. Price every feature before building or keeping it

Two costs, both counted:

- **Runtime cost** — main-thread time, disk I/O, memory, and how it scales. Judge
  it at the scale of heavy users (tens to hundreds of spaces, thousands of
  conversations, many installed apps), not a fresh install.
- **Upkeep cost** — state that must stay in sync and correct forever (a cached
  count, a mirror of files on disk, a derived index), plus the code paths that
  maintain it.

Decision rule: **low benefit + ongoing upkeep → remove it, don't optimize it.**
Optimizing a feature nobody needs is still paying for it.

## 2. Deferred is not free

Work moved to "later" (idle tasks, after first paint, when a menu opens) still
runs on the same main thread, and still freezes the UI while it runs.

- Skip work whose result has not changed (e.g. a setup check that only matters
  after a version change must not run on every launch).
- Work that must run is made cheap (read once, not once per item), not merely
  rescheduled.

## 3. Opening something must not trigger computation proportional to user data

Opening a menu, list or page reads what is already known. It does not scan
every space, parse every record or walk directories to decorate rows. If a
number is worth showing, it must be cheap to read at the moment of display —
otherwise don't show it.

## 4. Removal is complete

Removing a feature removes its computation, its IPC/HTTP surface and its
stored state. Hiding it in the UI while the backend keeps computing it is not a
removal.

## 5. The AI is a partner, not a tool

In every scene — a digital human, a digital human team, a space conversation —
the AI works with people the way a capable colleague does. People speak plainly;
the structure the work needs (which question a reply answers, where a result goes
back) is carried by the system out of sight, and what must never be guessed (who
may approve, whether it is still open) is checked by code. That hidden context
appears only when it matters; an ordinary turn pays nothing for it (see 1).

Example — a digital human asks its owner a decision over IM:

- Tool: 【日报】需要你决定（编号 3）……回复「/answer 3 你的答案」
- Partner: 「日报」的定时任务需要你决定：这周报华东还是华北？ The owner replies
  "华东吧". Halo tells the AI which question that answers; if the reply is
  unclear, the AI asks back.

## 6. Users never have to learn the tool

Halo is for everyone, not only experts. No one should need to learn commands,
syntax, IDs or modes: either the interaction is obvious without instruction, or
the person says what they want and the AI does it with them. Like the iPhone
touchscreen — no stylus, no manual, you touch what you want. A feature that needs
explaining is simplified or handed to the AI.

## 7. A working AI hears new messages at once

One AI turn can span hundreds of tool calls, or run for days. So nothing
addressed to an AI waits for its turn to end — not a person's message, a
teammate's report, another conversation's message, a reminder or an event. It
reaches the AI as soon as the current tool call returns: everything that arrived
meanwhile is merged and attached before the next step, the way a colleague reads
the messages that piled up while they finished one thing. "Queue it until the
turn is over" is a legacy pattern; any such path in Halo is a defect.

One exception, for safety: a message whose sender has different permissions
from the running turn (an IM guest during the owner's turn, a member on another
machine) does not join that turn. It is merged with others like it and runs as
its own turn right after.

## 8. When recommending to the owner

State the benefit to the user and both costs in plain product terms, then give
a recommendation. When benefit is low and cost is medium or higher, the default
recommendation is to remove. For anything a person interacts with, also say what
they must learn to use it — the answer should be nothing.
