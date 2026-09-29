# services/memory-consolidation

Reorganises a memory that is due, using an agent, and keeps it at the job until
the result is accepted. The file side — cadence assessment, workspace,
validation, conflict report and rebase, swap, snapshots, fallback, cooldown — is
`platform/memory` (see its DESIGN §7); this module decides when to run, runs the
agent, and feeds back what the system found.

## Entry points

| Caller | When | How |
|---|---|---|
| `apps/runtime` (`turn/memory-lifecycle.ts`) | after an automation run and after a chat/IM/team turn | `requestConsolidation` |
| `apps/runtime` (`memory-control.ts`) | the owner's "consolidate now" / status for a digital human | `consolidateNow`, `getMemoryStatus` |
| `space-trigger.ts` | after any space-chat turn (`agent:complete` on `onAgentEvent`) | `requestConsolidation`, if the space has memory on |
| `space-trigger.ts` | the owner's "consolidate now" / status for a space (IPC, HTTP) | `consolidateSpaceMemoryNow`, `getSpaceMemoryStatus` |

`services/agent` never imports this module: space turns are observed through the
public turn-end event, the same way `conversation-interop` does.

## Scheduling (`service.ts`)

- One consolidation per memory at a time, claimed before the first await.
- Automatic: only when due by the owner's cadence (the `# now` threshold capped
  at the owner's injection limit), not cooling down, and not within the
  cadence's minimum interval. While
  another execution uses the memory, deferred — at most 5 times, then run
  anyway (a long-lived chat would otherwise defer it forever).
- Auto-consolidation off: only a History over its entry limit (or a file over
  its total size) is trimmed — a large `# now` alone archives nothing. This is
  no attempt: it is recorded apart (platform/memory `recordArchive`), so it
  neither counts as a failure nor delays consolidation once turned back on.
- "Consolidate now": ignores thresholds, cooldown and busy; returns once started
  (`already-running` / `empty` otherwise). Settings poll the status.

## The harness

```
agent.start()                         the task
loop (up to 3 feedback rounds):
  merging a conflict and ran out of turns → agent.followUp(continue + the conflict)
  validate  → fails     → agent.followUp(the conflict, if any + reason)
  a merge target left exactly as handed over → agent.followUp(not merged + the conflict)
  commit    → merges what it can decide alone (History, untouched topics)
            → conflict  → rebase; agent.followUp(what is left, live content in .incoming/)
            → committed → record; done
out of rounds / agent failed → History trimmed only if over its limit; cool down
```

Each round is a fresh query whose message is complete on its own — the task
again, "the directory holds your work so far", and everything still to do.
Once a conflict is handed over the workspace is rebased onto the live memory,
so the next commit takes the agent's copy as the merge. Three things hold
that to account: the conflict's instructions travel with every round until a
result is accepted; a round that ran out of turns meanwhile is never
committed; and a file the conflict asked to merge into (memory.md outside
History, or a topic changed on both sides) that is still exactly as it was
when handed over blocks the commit (platform/memory `mergeTargets` /
`fingerprintMergeTargets`). A newer conflict can only arise from a commit
attempt, so by the time it replaces the instructions every earlier target has
been worked on; its `.incoming/` files are written over, never cleared. How
complete a merge the agent made inside a file it did touch is still its word —
content lost that way is restorable from the snapshot taken at the commit only
while it is among the 3 rotating ones, that is, until 3 more consolidations
have committed (memory.md alone also stays in `archive/`). Nothing depends
on resuming an engine session: the Halo engine's one-shot query keeps no
transcript, and the files carry the state anyway.

Automatic triggers only *check* before claiming a memory; "consolidate now"
is not blocked by a trigger that is still checking, and the trigger yields to it.

## The agent (`runner.ts`, `prompt.ts`)

A query per round built on `buildInternalTaskSdkOptions` (same credentials, env and
engine as the owner's sessions, but not the owner's tool restrictions, turn cap or
prompt style — see `services/agent/DESIGN.md` §11), rooted in the workspace:

- tools: Read, Write, Edit, Glob, Grep, and `memory_move`; no shell, no user
  skills or settings;
- a PreToolUse hook (one matcher entry per tool) refuses any file tool aimed
  outside the workspace — path arguments read as the engines read them
  (`~` included) and compared with `foundation/path-containment`, Glob patterns
  by the folder they reach; engines without hooks: by
  instruction only, logged;
- 60 turns / 10 minutes per round; running out of turns still goes to validation.

Credentials are resolved only when a consolidation actually starts: the digital
human's model override, the triggering conversation's model for a space, or the
global model for a space's "consolidate now".
