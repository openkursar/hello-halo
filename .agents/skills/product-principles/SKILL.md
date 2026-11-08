---
name: product-principles
description: Halo's product design principles. Halo is a performance-sensitive Electron app — performance first, features restrained, never block startup or user interaction; the AI is a partner, not a tool; users never have to learn the tool; a working AI hears new messages at once. Read before adding, keeping or reshaping a user-visible feature, background work, or how the AI talks to people, and before recommending whether a feature should exist.
---

# Product design principles

Halo is a performance-sensitive Electron app. Protect startup and interaction
responsiveness through restrained scope and simple, on-demand, bounded work.
Performance trade-offs are explicit human decisions, not a license for premature
optimization.

## 1. Review performance before building or approving

Every change, however small, must weigh user benefit against runtime costs
(CPU, memory, disk/network I/O) and upkeep. Check cold/warm startup **to usable**,
interaction/high-frequency work, background/resident costs and growth with heavy
user data across affected desktop, remote web and mobile scenarios — including
when the feature is unused. Stay within the requested scope.

**Human approval:** Before implementing or approving added startup work, ongoing
overhead, data-size-dependent computation or a plausible responsiveness regression,
state the benefit, affected scenarios, cost, evidence/uncertainty, cheaper alternative
and recommendation; obtain explicit human approval. Do not decide that the cost
is acceptable for the owner.

Local, bounded work outside these cases needs no extra performance approval.
Reuse explicit prior approval unless its scope is exceeded. Match measurement to
impact; code inspection alone is not runtime evidence.

**Low benefit + recurring cost → recommend simplifying, omitting or removing,
not optimizing by default.** Humans decide; never use performance to justify
unapproved feature removal or bypassing architecture, correctness or safety.

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

Apply §1's benefit/cost decision rule in plain product terms. For anything a
person interacts with, also say what they must learn to use it — the answer
should be nothing.
