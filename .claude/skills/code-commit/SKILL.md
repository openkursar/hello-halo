---
name: code-commit
description: Must be invoked when the user asks to commit code, submit code, or any similar request.
---

# Code Commit Skill

## Commit Workflow

### 1. Review Changes

Run `git status` and `git diff` in the repository to understand all current changes.

### 2. Pre-commit Checks

Start with the automated gate (2.1), then review all changed files by hand (2.2-2.4).
**If any issues are found, report them to the user and wait for confirmation before committing.**

#### 2.1 Automated Gate (blocking)

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

#### 2.4 Internationalization & Open-source Readiness

Ensure the code is suitable for an internationalized, open-source project:

- **No hardcoded Chinese strings** in user-facing text (UI labels, prompts, error messages). These should go through the project's i18n mechanism.
- **Comments in English** to align with open-source conventions.
- **No pinyin naming** for variables, functions, or identifiers. Use meaningful English names.
- **No internal/private information** such as internal IP addresses, intranet domains, personal emails, phone numbers, API keys, or secrets.
- **No specific company or brand names** in code, comments, or commit messages — this includes but is not limited to Microsoft, Google, Tencent, Alibaba, Apple, Meta, Amazon, Baidu, ByteDance, etc. Use generic terms instead (e.g., "cloud provider", "search engine", "platform").

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

- Only stage files that pass the checks. Do not blindly `git add .`.
- Run `git status` after committing to verify.

## Notes

- If there are no changes, inform the user that there is nothing to commit.
- Do not run `git push` unless the user explicitly asks.
- When issues are found during checks, list all of them and ask the user how to proceed. Do not skip issues on your own.
