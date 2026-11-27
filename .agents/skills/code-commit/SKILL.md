---
name: code-commit
description: Must be invoked when the user asks to commit code, submit code, or any similar request.
---

# Code Commit Skill

## Commit Workflow

### 1. Review Changes

Run `git status` and `git diff` in the owning Git repository to understand all current changes. For SDK work, read `src/sdk/halo-sdk/AGENTS.md` and `src/sdk/halo-sdk/TESTING.md`.

### 2. Pre-commit Checks

Start with the checks for the actual scope (2.1), then review all changed files by hand (2.2-2.4).
**If any issues are found, report them to the user and wait for confirmation before committing.**

#### 2.1 Automated Gate (blocking)

- **SDK-only:** run the required checks in `src/sdk/halo-sdk/TESTING.md` from the SDK directory; the host gate is not a substitute.
- **Halo-only:** run the root gate below.
- **Both:** run both scopes and the affected integration checks.

All scopes use this commit workflow in the owning repository. The root gate does not yet invoke SDK suites; documentation does not add that coverage.

Halo root gate:

```bash
npm run precommit:gate
```

Exit 0 to proceed. **A non-zero exit blocks the commit** — report the output and
stop; do not commit and fix afterwards.

It selects its checks from `git status`, so it costs seconds on a small change and
never runs anything irrelevant: typecheck scoped to the changed files, the unit
tests named after the changed sources, and — only when the viewers, `tests/perf/`
or `scripts/perf-gate/` were touched — the performance gate's self-test, the
fixture manifest check, and the markdown chunking guards. It launches no Electron
and measures no runtime performance; that is the release scripts' job.

Two rules when it fails, both load-bearing:

- **Fix the code or fix the criterion. Never fix the check list.** Adding a path
  to a skip list, a scenario to an exemption, or a filename to a whitelist is not
  an acceptable way to turn this green. Every list inside those scripts records
  something true about the repository, not something convenient for one change.
- **Do not bypass it.** This is a script rather than a git hook precisely because
  `--no-verify` exists. If it genuinely should not apply, say so to the user and
  let them decide.

#### 2.2 Temporary Code Detection

Use your judgment to identify code that looks temporary or was clearly left in by accident -- things like `debugger` statements, placeholder values (`test123`, `asdf`, `foo`), commented-out code blocks, or anything that reads like a quick hack not meant for production. Don't be overly rigid; focus on what obviously doesn't belong.

#### 2.3 Temporary File Detection

Check whether any files that should not be committed are included in the changes:

- OS files: `.DS_Store`, `Thumbs.db`, etc.
- Temp files: `*.log`, `*.tmp`, `*.bak`, `*.swp`, etc.
- IDE configs: non-shared files under `.idea/`, `.vscode/`, etc.
- Build artifacts: `node_modules/`, `dist/`, `build/`, etc.
- Sensitive files: `.env`, `credentials.json`, private keys, etc.
- Internal working documents (briefs, handoffs, plans, notes on closed code, or anything else not meant for the public): open every new file, including untracked ones that `git diff` hides. If it is internal, do not stage it.

#### 2.4 Internationalization & Open-source Readiness

Ensure the code is suitable for an internationalized, open-source project:

- **No hardcoded Chinese strings** in user-facing text (UI labels, prompts, error messages). These should go through the project's i18n mechanism.
- **Comments in English** to align with open-source conventions.
- **No pinyin naming** for variables, functions, or identifiers. Use meaningful English names.
- **No internal/private information** such as internal IP addresses, intranet domains, personal emails, phone numbers, API keys, or secrets.
- **No company or product names** in code, comments, or commit messages unless the feature needs them, such as the engine, model provider or IM channel the code integrates with. Otherwise use generic terms (e.g., "cloud provider", "search engine", "platform").
- **No internal story** in code, comments, test names or commit messages. Say what the code does and the technical reason it needs to; leave out internal documents and notes, why or by whom a decision was made, the customer or incident behind a change, release plans and development history. If a sentence only makes sense to someone who was in the discussion, cut it.

### 3. Generate Commit Message

Format:

```
<type>: #AI commit# <concise description>. collaboration and commit by halo
```

**Supported types:**

| type     | usage                                      |
|----------|--------------------------------------------|
| feat     | New feature                                |
| fix      | Bug fix                                    |
| docs     | Documentation changes                      |
| style    | Code formatting (no logic changes)         |
| refactor | Refactoring (no new features or bug fixes) |
| perf     | Performance improvement                    |
| test     | Test-related changes                       |
| chore    | Build, tooling, dependency updates, etc.   |

**Examples:**

```bash
git commit -m "feat: #AI commit# add user authentication module. collaboration and commit by halo"
git commit -m "fix: #AI commit# resolve memory leak in event listener. collaboration and commit by halo"
```

### 4. Execute Commit

```bash
git add <relevant files>
git commit -m "<generated commit message>"
```

- Only stage files that pass the checks. Stage by explicit file path; never `git add .`, `-A`, or a directory, which sweeps in stray files.
- Run `git status` after committing to verify.

#### Disclosure Reminders

The repository's `commit-msg` hook scans the lines this commit adds and its message. Any match pauses the commit and lists the file, line and what matched; credential-like values are not printed. It assists your review and does not replace it. Do not skip it with `--no-verify`.

Open each place. If it is fine as is (a name the feature needs per 2.4, test data, a public example), rerun the same commit as `git -c disclosure.reviewed=true commit ...`. Otherwise fix it, restage and commit again; for a real secret, tell the user the file and line without repeating the value.

## Notes

- If there are no changes, inform the user that there is nothing to commit.
- Do not run `git push` unless the user explicitly asks. When pushing, follow the `gh-publish` skill first.
- When issues are found during checks, list all of them and ask the user how to proceed. Do not skip issues on your own.
