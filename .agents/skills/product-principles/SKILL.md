---
name: product-principles
description: Halo's product design principles — performance first, features second. Must be read before adding, keeping or reshaping a user-visible feature, a UI surface that shows computed data (counts, badges, summaries, previews), or background work (startup/idle tasks, on-open refreshes, polling, scans); and before recommending whether a feature should exist.
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

## 5. When recommending to the owner

State the benefit to the user and both costs in plain product terms, then give
a recommendation. When benefit is low and cost is medium or higher, the default
recommendation is to remove.
