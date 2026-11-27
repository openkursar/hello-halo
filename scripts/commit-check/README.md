# Commit disclosure check

A local `commit-msg` hook that pauses a commit, by a person or an AI, when the staged lines or the message look like something a public repository should not carry, so the committer looks before going on. It assists the committer's own review; a local hook is not enforcement.

Any match pauses the commit and lists the file, line and what matched: a name or phrase from [disclosure-rules.json](disclosure-rules.json), or a possible credential, private network address, personal or shared path or service connection string, whose value is never printed. Review each place. If it is fine as is, such as a name the feature needs, test data or a public example, rerun the same commit as `git -c disclosure.reviewed=true commit ...`. Otherwise edit it and commit again.

Only added lines, new file names and the message are scanned: not unchanged lines, unstaged edits, binary content or earlier commits. A merge commit is checked for its message only.

## Install

`npm install` installs the hook for this checkout. To install or verify it without reinstalling, run `node scripts/commit-check/install.mjs`. An existing `commit-msg` hook or a custom `core.hooksPath` is left alone; call `node scripts/commit-check/check.mjs "$1"` from your own `commit-msg` hook and keep its exit status.

To check the staged change before committing, run `node scripts/commit-check/check.mjs`.

## Rules

`disclosure-rules.json` holds `names` (one array per organization or product, with its spellings), context `phrases`, and format `patterns`. Add generic patterns and synthetic test cases, never real examples. Run `node --test tests/check/disclosure.test.mjs`.
