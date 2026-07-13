---
name: comment-review
description: Must be invoked when the user asks to review, audit, or improve code comments — e.g. "check the comment quality", "审一下注释", "注释评审", "optimize the comments". Reviews comments in the current changes against this project's comment policy and fixes the issues found.
---

# Comment Review & Improvement Skill

Reviews the comments in the current changes against this project's comment policy
(`CLAUDE.md`), reports violations, and — after confirmation — fixes them.

The governing principle (from `CLAUDE.md`): **comments transfer context the reader
cannot get from the code itself. Default to none. Keep each comment as short as the
context allows. If removing the comment loses no context, it shouldn't exist.**

## Workflow

### 1. Collect the changed comments

- Run `git status` and `git diff` to see uncommitted changes (or the range the user
  names, e.g. a branch/commit).
- Focus only on comment lines that were **added or modified**. Ignore pure logic
  diffs and generated files (locale JSON, lockfiles, snapshots).
- For large diffs, save the diff to a file and extract added comment lines, then read
  the surrounding code so each comment is judged in context — never judge a comment by
  its text alone.

### 2. Evaluate each comment

Read the code the comment sits on, then decide: **keep / trim / delete / rewrite.**

**Keep** (only if the code alone cannot convey it):
- *Why* a non-obvious decision was made.
- An invariant that must hold, or a trap not visible locally.
- A security/trust boundary, a race-condition hazard, a non-destructive contract.
- A link to an issue/RFC.

**Flag for fix** — these are violations of the policy:

| # | Violation | Example | Action |
|---|-----------|---------|--------|
| 1 | Ceremonial / subjective wording | "The proud part of the design…", "elegant", "cleanly" | delete the editorializing |
| 2 | Planning labels / session IDs | `E1`, `F2`, `Phase X`, `Full-chain:`, `Helper:` | delete |
| 3 | Cross-function line references | "see api.apiKey above", "(see line 120)" | delete the pointer; state the rule once |
| 4 | Narrating removed/changed code | "new — replaces…", "legacy; was…", "the previous branch is gone" | state the present rule only |
| 5 | Paraphrasing adjacent code | `// user re-entered — keep it` above `if (val) return` | delete |
| 6 | Restating a condition | `// oldest first` is borderline; long restatements are not | trim or delete |
| 7 | Defensive notes aimed at reviewers | "Note: this is safe because…" addressed to a PR reader | delete or reframe as an invariant |
| 8 | Numbered cross-refs to a scheme defined elsewhere | "(invariant ②)" | name the property inline instead |
| 9 | Over-long blocks | multi-paragraph essays / worked examples where 2–3 lines suffice | halve it; keep the one-line *why* |

Also check the basics from the commit policy:
- Comments in **English** (open-source convention).
- No internal/private info, no company/brand names.

### 3. Report before changing anything

Produce a concise report:
- A density signal for the worst files (comment-lines / total-lines) to show over-documentation.
- A prioritized list: clear violations (#1–#5) first, then long-block trims.
- For each item: `file:line`, the rule it breaks, and the proposed shorter version.
- Explicitly list what you will **keep** so valuable rationale is not stripped.

**Do not delete-all.** Stripping a security/why comment is worse than an over-long one.

### 4. Fix on confirmation

- Per `CLAUDE.md`, code/comment edits require human consent. Wait for the user to
  approve (or to pick a subset) before editing.
- Make **comment-only** edits — never alter logic. Prefer `Edit` on the exact block.
- After editing, do a quick pass to confirm no `{@link}`/name references now dangle and
  no logic line was touched.

## Notes

- If there are no comment changes, say so — nothing to review.
- Do not run `git commit` or `git push`; this skill only reviews and edits comments.
- Read `CLAUDE.md` (and `halo-dev`) first if not already in context — it is the source
  of truth for the rules above.
- When unsure whether a comment carries real non-local context, keep it and flag it as
  "keep (verify)" rather than deleting.
