---
name: halo-logging
description: Must be invoked when adding or changing a failure path (drop/skip/ignore/timeout/catch), a long-lived stateful link (connection, session, subscription, federation/sync link, IM channel), or a diagnostics/export surface — and before any commit review. Detects AND fixes production-logging gaps in changed code per halo-dev quick.md rule 12.
---

# Halo Production Logging

Detect and fix production-logging gaps in code that changed locally. This is not
a formatting pass — the job is to make failures loud and system state legible to
someone reading logs after the fact, often on an offline/内网 machine with no
chance to reproduce.

## Core posture: silence is guilty until proven safe

Do not ask "should this log?" — ask **"if this path is hit in production, will
anyone ever know?"** A `return`/`continue`/`break`/`catch`/timeout branch that
drops, skips, ignores, or gives up on a unit of work is a defect if it does not
produce exactly one log line saying what was dropped and why.

## Scope

Only review control flow that is **new or modified** in the working tree.

1. Run `git status` and `git diff` (plus `git diff --cached` for staged work).
2. For each added/changed failure branch, long-lived resource, or diagnostics
   touchpoint, apply the checklist below.
3. Leave pre-existing logging in untouched code alone unless it directly
   conflicts with a change you're making.

## Checklist

### 1. Silent failure must log

- Every drop/skip/ignore/timeout/early-return in a handler, sync/replication
  loop, channel provider, or IPC/HTTP handler needs one log line: **what was
  dropped and why**, with identifying context (peer/team/session/seq id) —
  not just "failed" or "error occurred".
- One log line per decision point, not one per layer — if the caller already
  logs the drop, the callee re-logging the same event is noise.
- Errors that already carry a stack trace still need stage + entity context;
  a bare stack trace without "what was being done" is not enough to localize.

### 2. State over event for long-lived resources

- Anything that persists across multiple messages/ticks — a federation link,
  team channel, session feed, subscription, IM channel connection — must
  periodically self-report a **state line with numbers** (cursor, acked-seq,
  lag, member list), not just a stream of individual event logs.
- Adding a new long-lived resource? Check whether a periodic self-report
  already exists at that tier; if not, add one. Interval should be minutes,
  not seconds — this is a heartbeat, not a trace.
- Downgrade or delete per-event logs that carry zero diagnostic signal (e.g.
  streaming token-level deltas, high-frequency identical-shape events).
  High-volume, low-information logging is worse than no logging — it buries
  the state lines that actually matter.

### 3. One-command diagnostics export

- Modules with multi-node/distributed/multi-link state (federation,
  sync-engine, im-channels) should expose — or extend an existing — single
  diagnostics/export path that dumps current link state, cursors, queues,
  member tables, and recent drops in one artifact, instead of requiring
  someone to grep live logs across multiple machines.
- Adding a new piece of distributed state? Register it into the existing
  diagnostics export rather than creating a parallel one-off dump.

## Fix, don't just flag

When you find a gap, fix it in place:
- Add the missing drop/skip log at the exact decision point.
- Add or extend a periodic state self-report for a long-lived resource.
- Wire new state into the existing diagnostics export.

## Report

After fixing, give the user a tight summary grouped by file: how many silent-
failure gaps were closed, how many state snapshots were added, whether the
diagnostics export was extended. Per the project rule, code changes need human
consent — present the diff and let the user accept.
