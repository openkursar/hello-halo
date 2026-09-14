---
name: code-merge
description: Must be invoked when the user asks to resolve merge conflicts, merge a branch, handle an MR/PR conflict, or any similar request.
---

# Code Merge Skill

Principles for resolving merge conflicts in a Merge Request (MR).

## Core Rule

**Functional conflicts require human decision. Non-functional conflicts may be resolved autonomously.**

A conflict is *functional* when the two sides represent different intended behavior, logic, or feature outcomes — resolving it wrong changes what the product does. A conflict is *non-functional* when both sides are semantically equivalent and only differ in form (formatting, import ordering, whitespace, comment wording, mechanical renames, auto-generated files, changelog/lockfile ordering).

## Merge Workflow

### 1. Survey the Conflict

Run `git status` and inspect each conflicted file (`git diff`, conflict markers `<<<<<<<`, `=======`, `>>>>>>>`). For each conflict, identify:

- Which files and hunks conflict.
- What each side (ours / theirs) is trying to do.
- Whether the conflict is functional or non-functional (per Core Rule).

### 2. Classify Every Conflict

For each conflict hunk, decide one of:

| Class            | Meaning                                             | Action                          |
|------------------|-----------------------------------------------------|---------------------------------|
| Non-functional   | Both sides equivalent, differ only in form          | Resolve autonomously (§3)       |
| Functional       | Sides differ in behavior / logic / feature outcome  | Escalate to human (§4)          |

Do not guess. If you cannot confidently tell whether a conflict changes behavior, treat it as **functional** and escalate.

### 3. Autonomous Resolution (Non-functional Only)

When resolving on your own, this often involves **code refactoring and file merging**, not just picking one side. Follow the intent analysis below.

#### 3.1 Analyze Intent: Keep or Discard

For each piece of conflicting code, determine whether its intent is to be **kept** or **discarded**:

- **Kept** — the code is still needed after the merge.
  - Resolve as: **latest version + all still-needed functionality**.
  - Take the newer/updated implementation, but make sure no required capability from either side is lost. Merge both sides' contributions rather than blindly overwriting.
  - After merging, verify the result compiles, references resolve, and no dead/duplicate declarations remain.

- **Discarded** — the code appears intended for removal (deleted on one side, superseded, obsolete).
  - **Do NOT discard autonomously. Confirm with the human first**, even if it looks non-functional. Report which code you believe should be dropped and why, and wait for confirmation.

#### 3.2 Refactor / File Merge Hygiene

When merging produces combined code:

- Preserve the newer API/signature; adapt older call sites to it.
- Deduplicate imports, helpers, and declarations introduced by both sides.
- Keep formatting consistent with the surrounding file, not with the conflict markers.
- Remove all conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).

### 4. Escalate (Functional Conflicts)

For every functional conflict:

- Do **not** pick a side on your own.
- Report to the human: the file/location, what each side does, and the trade-off.
- Wait for an explicit decision before resolving.

List **all** functional conflicts together so the human can decide in one pass. Do not resolve some silently and escalate others.

### 5. Verify Before Completing

After all conflicts are resolved:

- Ensure no conflict markers remain (`git grep -n '<<<<<<<\|=======\|>>>>>>>'` or equivalent).
- Confirm the code builds / type-checks where applicable.
- Run `git status` to confirm all conflicts are marked resolved (`git add` the resolved files).
- Summarize what was resolved autonomously vs. what the human decided.

## Notes

- Never `git add .` blindly — stage only files you have actually reviewed and resolved.
- Do not run `git commit`, `git merge --continue`, or `git push` unless the user explicitly asks.
- When in doubt about functional vs. non-functional, or keep vs. discard, **default to asking the human.**
