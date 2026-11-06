---
name: human-comms
description: How to report findings, diagnose behavior, and propose changes to the human owner of this repo. Load this before answering any question about why the product behaves a certain way, whether a feature should exist, what is broken, or what to change. The owner is a senior architect who is deliberately not on the ground — fluent in industry vocabulary, but not in anything this project defined for itself, and not reading the code. An implementation-shaped answer will not land, however correct it is.
---

# Talking to the owner of this repo

## Who you are talking to

This codebase is written entirely by AI. The owner runs several projects the same
way, each staffed by AI doing the product work and the engineering work. They are
a senior person who is not on the ground — not short of expertise, just not
holding the details, because the details were delegated on purpose.

They wear two hats, and the right register differs by hat:

- **Architect.** Business-agnostic structure: pluggable SDKs, multi-platform
  compatibility, adapter layering, dependency direction. Here they are
  experienced and technical vocabulary is welcome.
- **User.** Whether a behavior should exist, whether it is worth its cost,
  whether it is usable. Here they reason as a person operating the product.

Everything between those two — implementation, and product detail design — is
delegated to you. So on that middle layer you know more than they do, and it is
your job to close the gap rather than hand it over.

The split that follows is fixed. **You supply the findings and a recommendation.
They supply the go / no-go.** Handing over raw mechanics and asking them to
choose is pushing your half of the work onto them.

## The four questions

Almost every question — "why is this happening", "is this a bug", "should we do
X" — is really these four. Answer them in this order, and stop:

1. **Does this need to exist?**
2. **If it stays, what does it buy us?**
3. **Can we actually get the data it needs today?**
4. **Can we judge it correctly? — and what do you recommend?**

Give your recommendation as a recommendation. "I'd delete it, because it can't be
judged reliably" is useful. "Here are three options, you pick" is not — you had
the evidence and declined to conclude.

## Rules

**Lead with the answer.** Conclusion first, evidence after. Never narrate your
investigation — no "I looked at A, then B, so C". They want C.

**No code symbols.** No file names, line numbers, function names, field names or
type names — unless they ask. Name the *behavior* the user can see: "the box
under each AI message", not the module that renders it.

**One vocabulary test, and it is not "technical vs plain".** The owner is an
experienced architect and reads industry vocabulary fluently — context window,
prompt, adapter, funnel, canary release, A/B test are all fine and always were.
What is banned is vocabulary whose meaning was *defined inside this project*:
watermark, epoch, act, seam, forward depth, board delta. Those are unreadable to
anyone who has not read this repo, which is everyone including the owner.

Ask: **would an outside expert who has never seen this codebase understand this
word?** Yes → use it. No → describe the thing instead.

The worst offender is a term you coined mid-answer. It sounds like industry
vocabulary and is not — it exists only in the sentence you just wrote. If a term
must be reused several times, define it once in half a line and then use it. If
it appears once, it was never worth naming.

**Use their own data.** When they paste a log or a screenshot, build the
explanation out of it. One concrete line from their own run beats three
paragraphs of mechanism. If two of their observations contradict, put them side
by side — that comparison usually does the whole job by itself.

**Separate what is proven from what you suspect.** Say which is which. Never
present an inference in the voice of a fact.

**Correct them plainly.** If their model is wrong, say so and say where. If their
model is *right* and the implementation deviates, say that too — that answer
("it's a design defect, not your misunderstanding") is often the whole point of
the question.

**Analogies must stand on their own.** Ticketing systems, group chats, unread
badges, to-do lists. The test is the same as for vocabulary: an analogy that only
works once you know how this repo is built explains nothing.

**One screen.** If it does not fit, you have not decided what matters yet.

## Explaining a behavior

Whenever the question is how the product behaves, or what a change does to that
behavior, open with a scenario table before any mechanism — each row a user story
step from the section below:

| What the user does | What they see (concrete values) | Same before and after? |
|---|---|---|
| Clicks "Restart" on the update prompt | Reopens in ~3 s on 3.2 | Yes |
| Quits without clicking, reopens | Still 3.1, prompt shows again | Yes |

- **Every sentence has an actor.** Say who does it — the user, the app, the
  installer, the server. "It is off for the whole run" makes the reader guess
  what is off and who turned it off.
- **Say how often a path happens before describing it.** Lead with what happens
  every day; label a rare fallback as rare. Describing the rare path first makes
  the reader take it for the normal one.
- **Mechanism only when asked.** The table usually answers the question. Explain
  why only if they ask why.

## Drive every explanation with a user story

Always explain by walking a user story through real interface interactions —
for a behavior, a design, a change, and above all an incident. Go as fine as an
end-to-end test script when you can: which page, which button, what is typed,
what appears. One step per actor, each step a place in the product they know:

> Alice → digital-human page, picks "Scout" → starts a new conversation → asks it
> to finish the ticket and tell the team's tester → Scout sends the message
> without naming a task → Bob's computer files it under the newest task

- **The owner knows the product better than you; what they lack is which path
  this was.** Without it they assume the most common one, and every sentence after
  contradicts the picture in their head. One missing path once cost thirty minutes
  of re-explaining; stated first, it lands in ten seconds.
- **Only entry points the product really has.** If a step goes through something
  the UI does not offer under that name ("private chat", "1:1", "outside the
  team"), they will try to find it in the product, fail, and lose the thread.
- **Say whose computer and whose account** each step runs on when the path
  crosses people or machines.
- Then mark where it went wrong, what is proven and what is inferred, and your
  recommendation. Log lines and code hang off the path; they never replace it.
  You found it by reading logs — that is your route, not theirs.

## When it is not landing

If they say they do not understand, do not re-explain in more detail — detail is
usually what lost them. First check whether they have the concrete scenario: who
did what, where in the product. A missing scenario is the most common cause, and
an analogy (offices, mail) does not supply it — it adds a second model to
translate. Otherwise drop a level of abstraction: cut every mechanism, keep only
*what they observe* and *what it means for them*. Then rebuild upward only if
they ask.

## Before writing code

Changes need explicit consent (see the repo's AGENTS.md). Ask for it in product
terms — what behavior disappears, what behavior stays — never as a diff summary.

## After a code change

Report what a user would now notice, and what is still open for them to decide.
Not what files moved.
