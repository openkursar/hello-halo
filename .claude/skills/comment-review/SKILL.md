---
name: comment-review
description: Must be invoked when the user asks to review, optimize, or clean up comments, or wants comments checked before a commit. Detects AND fixes low-quality comments in changed code so they meet open-source benchmark quality.
---

# Comment Review

Detect and fix low-quality comments in code that changed locally. This is not a
linter pass — you read each comment, decide if it earns its place, and rewrite or
delete it.

## Core posture: default-deny

A comment is guilty until proven necessary. Do not ask "is this comment helpful?"
— you will always rationalize a yes. Ask instead: **"What specific question does
this answer that the code itself cannot?"** If you cannot name that question in
one sentence, delete the comment.

The burden of proof is on the comment to justify existing, not on you to justify
removing it.

## Scope

Only review comments on lines that are **new or modified** in the working tree.
Never touch comments in unrelated code.

1. Run `git status` and `git diff` (plus `git diff --cached` for staged work).
2. For each added/changed `//`, `/* */`, JSDoc block, and file header, apply the
   checks below.
3. Leave pre-existing house-style conventions alone (e.g. an existing file's
   banner style) — match the file, don't reformat untouched code.

## Delete on sight (anti-patterns)

Match these patterns and remove/rewrite without deliberation:

- **Code paraphrase.** The comment restates what the next line(s) plainly do.
  `// loop over members` above a `for` loop. Delete.
- **Type/field restatement.** JSDoc that repeats the identifier or type.
  `/** The team id. */ teamId: string`. Delete.
- **Process narration.** Anything describing the edit, not the code: "we changed",
  "removed X", "now also does Y", "added for the new feature". Delete.
- **Internal references.** Section/doc pointers (`§5.2`, `技术 §...`, `PRD §...`),
  task/iteration labels (`RC1`, `Task 4`, `Phase 2`, `E1`/`F2`), chat-session IDs,
  ceremonial prefixes. If a comment only makes sense to someone who saw the design
  conversation, it is wrong. Delete the reference; keep any real explanation.
- **Reviewer-directed defense.** Notes aimed at a reviewer ("note: this is safe
  because…", "as requested", "intentionally"). Fold the real reason in or delete.
- **Boilerplate file headers.** Headers that list exported functions, narrate the
  full architecture, explain what *other* modules do, or restate the module name.
  Cut to 1–3 lines: the module's responsibility plus any constraint not visible in
  the code (e.g. an import-cycle rule, a "must stay renderer-safe" invariant).
- **Step-by-step flow.** Numbered "1. do X 2. do Y" lists that mirror the function
  body line for line. Delete; keep only a non-obvious ordering constraint if one
  exists.

## Keep (the rare valid comment)

A comment survives only if it carries one of these — context unobtainable from the
code itself:

- **Why**, not what: the reason a non-obvious decision was made.
- **Invariant**: a property that must hold and isn't locally enforced.
- **Trap**: a non-obvious consequence, race, or ordering dependency a maintainer
  would otherwise break.
- **Cross-module contract**: a coordination fact the local code cannot show
  (e.g. "caller already enforced X", "the other side suppresses Y").
- **Public API contract**: caller-facing preconditions/return semantics on an
  exported interface.

Even when kept, make it as short as the context allows. A one-line why beats a
five-line essay.

## Fix, don't just flag

When you find a violation, fix it in place:
- Delete pure noise.
- Rewrite verbose-but-valid comments to their shortest faithful form.
- Strip internal references while preserving the genuine explanation around them.

## Report

After fixing, give the user a tight summary: how many comments removed, how many
trimmed, grouped by file. Show the before/after diff so they can confirm. Per the
project rule, code changes need human consent — present the diff and let the user
accept.

## Litmus tests (apply when unsure)

- **Deletion test**: remove the comment. If no context is lost, it shouldn't exist.
- **One-sentence test**: state the question it answers in one sentence. If you
  can't, delete it.
- **Stranger test**: would this make sense to an external open-source reader with
  no access to your internal docs or this conversation? If not, fix it.
