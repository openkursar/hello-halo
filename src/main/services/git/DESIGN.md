# services/git — git for a space's repositories

> Read this before touching anything under `src/main/services/git/`.
> Consumers: the changes view (through `ipc/git.ts` and `http/routes/git.routes.ts`)
> and `services/code-review` (in-process, through `index.ts`).

## 1) What it is, and what it is not

The main-process side of the canvas changes view: which repositories a space has,
their working-tree status, change lists for five compare scopes (the fifth: a
commit against its first parent), both sides of a
changed file, snapshots of the working tree for reviews, the commit graph (one
page of history in topo order, read-only browsing — no checkout, no reset), and
the few writes the view offers (stage, unstage, discard, commit / amend / push,
sync).

It is **only git**. It does not depend on the agent or conversation services, and
it knows nothing about reviews beyond producing and comparing snapshots. Branch
switching, stash, blame, rebase, hunk staging and conflict editing are out of
scope on purpose — a user does those in a terminal or asks the AI.

Everything runs the git CLI. Nothing runs at startup, nothing polls: every call
is a user action (open, refresh, click).

## 2) Files

| File | Role |
|---|---|
| `index.ts` | Public surface. Other modules import only from here. |
| `cli.ts` | The one place git is spawned: argv, environment, deadline, output cap. |
| `locate.ts` | Which git binary, decided on first use and cached (§4). |
| `context.ts` | `RepoContext` (a validated repository) and `run/read/exec` helpers. |
| `repositories.ts` | Discovery, the request gate (`requireRepository`), branch summaries. |
| `paths.ts` | Repository-relative path validation, symlink-safe worktree resolution, argv batching. |
| `parse.ts` | Pure parsers for git's `-z` formats. |
| `files.ts` | What git does not print: untracked line counts, binary sniffing, `linguist-generated`. |
| `status.ts` | Working-tree status for the file panel. |
| `changes.ts` | Change lists per compare scope. |
| `repo-config.ts` | Filter drivers a repository's own config sets, kept out of reads (§3.1). |
| `contents.ts` | Both sides of one file, behind a concurrency gate (§7). |
| `gate.ts` | Bounded concurrency with a bounded, cancellable line (`GIT_BUSY` beyond it). |
| `snapshot.ts` | Snapshot trees and "changed since". |
| `revisions.ts` | Choices for "compare with a branch / commit". |
| `graph.ts` | The commit graph: one page of history in topo order, with parents and refs. |
| `operations.ts` | Writes. |
| `errors.ts` | `GitError` + stable codes, failure classification. |

## 3) Running git (`cli.ts`)

- `spawn(executable, [...args])` — never a shell string. Every path argument follows `--`.
- Global flags: `-c core.quotepath=off -c color.ui=false -c core.fsmonitor=`; machine-read output
  always uses `-z`. See §3.1 for the last one.
- Environment, on top of the inherited one:
  - `LC_ALL=C` — messages are classified by text (§9).
  - `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` — no credential prompt can wait for input.
  - `GIT_LITERAL_PATHSPECS=1` — a file named `*.ts` or `:(top)x` is just a name.
  - `GIT_OPTIONAL_LOCKS=0` on every read-only command (`read()` in `context.ts`), so a refresh
    never takes `index.lock` from an AI running git in the same repository (measured, §11).
  - `GIT_PAGER=cat`, `GIT_EDITOR=:`.
  - Repository-location variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …) inherited
    from the parent are removed: `cwd` alone decides the repository. So is `GIT_EXTERNAL_DIFF`.
- Every command has a deadline and a stdout cap. Reads default to 30 s / 32 MiB; a read that
  may be large (status, diff, ls-files) is cut at the cap and reported `truncated` instead of
  failing. Snapshots 120 s, local writes 60 s, commit 5 min (hooks), push/pull 3 min.
- Network commands and commit run **detached** (own session, no controlling terminal) on POSIX:
  an ssh passphrase, host-key or gpg prompt fails at once instead of hanging a hidden process.
  A timeout kills the whole process group.

### 3.1) Programs a repository's config can name

**Principle: git that Halo runs on its own never runs a program the repository's config names; an
operation the user clicks runs as git itself would.**

Threat: opening the view runs git without the user typing a command, and a repository that came from
an archive or from someone else brings its own `.git/config` (and `.gitattributes`). The user's own
config — system, global, `-c` — is trusted; repository-scoped config (local, worktree, and the files
they include) is not. Reads (`read()` in `context.ts`: status, change lists, contents, snapshots,
"changed since", revisions, summaries) are the automatic side. Writes (`run()`: stage, unstage,
discard, commit, push, pull) follow a click.

| Config | Run by | Here |
|---|---|---|
| `filter.<driver>.clean / smudge / process` (picked by `.gitattributes`) | every re-hash of a file: status and diff for each file whose stat data changed — every file of a freshly extracted copy — and the snapshot's `add -A` | `repo-config.ts`: once per request, `git config --show-scope --includes -z --get-regexp '^filter\.'` (one short git process, 5–10 ms, before the request's first read; memoized per `RepoContext`, i.e. per request); every `filter.*.{clean,smudge,process,required}` key with a local/worktree value is passed to that request's reads as `-c key=<the user's value>`, or `''` (`false` for `required`) when the user's config has none. A globally installed git-lfs keeps working. |
| the same, inside submodules | status / diff recursing into a submodule, under its own config | `--ignore-submodules=dirty` on status and the diff commands: a submodule counts as changed when its commit moved; changes inside it are not looked at (the view cannot show them anyway). |
| `core.fsmonitor` (a hook path) | status, diff, add | `-c core.fsmonitor=` on every command. Empty, not `false`: before git 2.36 the value is a program path, so `false` would run `false`. |
| `diff.external`, `GIT_EXTERNAL_DIFF`, `diff.<driver>.command` | diff with patch output | `--no-ext-diff` on every diff-family command (we only read `--raw`/`--numstat`/`--name-only`, which never call them; the flag keeps it so), and the variable is removed. |
| `diff.<driver>.textconv` | porcelain `diff` | `--no-textconv` on every diff-family command. File contents come from `cat-file blob` and the working-tree file, never through textconv or filters. |
| `core.pager`, `pager.<cmd>` | a command writing to a terminal | No terminal, and `GIT_PAGER=cat` overrides both. |
| `core.editor` | commit without a message | `GIT_EDITOR=:`; commit always takes `--file=-` or `--no-edit`. |
| `log.showSignature` → `gpg.program` | log | `--no-show-signature`. |

Run as git runs them, because a click asked for it: stage, unstage and discard (the repository's
filters — without them staging would put git-crypt plaintext or a raw LFS file into the index, and
discard would write ciphertext or a pointer into the working tree), commit (hooks; `gpg.program` when
signing is configured), pull and push (hooks, `core.sshCommand`, credential helpers, remote helpers).

Known degradations, only where a repository configures filters in its own config (`git lfs install
--local`, git-crypt): Halo hashes such files raw. A file changed since checkout can show as modified
when only its filtered form is unchanged, and a review snapshot stores the raw content — for git-crypt
the plaintext — as blobs no ref points to, which `git gc` prunes. Git 2.23–2.25 has no `--show-scope`:
there every filter driver is switched off for reads, so LFS files whose stat data changed show as
modified even with git-lfs installed globally (the minimum stays 2.23: Ubuntu 20.04 ships 2.25).

## 4) Locating git (`locate.ts`)

Resolved on first use, never at startup, and cached keyed by `PATH` and `CLAUDE_CODE_GIT_BASH_PATH`
(the GUI process only gets the login-shell `PATH` after the window loads — fix-path — so an early
lookup must not pin a worse answer; installing Git Bash from Halo sets the second variable, so the
new git is picked up at once). A failure is otherwise re-checked after 60 s rather than cached for good.

- macOS / Linux: the first executable `git` on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`,
  `/usr/bin`. On macOS without the command line tools `/usr/bin/git` is a stub that fails
  `git --version` → `not-runnable` (its message as `detail`); running it is also what offers the
  tools' installer.
- Windows, in order: `git.exe` on `PATH`; the portable Git Halo installs for the CLI
  (`services/git-bash` → `userData/git-bash/{cmd,bin,mingw64/bin}/git.exe`); next to a Git Bash the
  user pointed Halo at (`CLAUDE_CODE_GIT_BASH_PATH`, its `cmd\` / `bin\`; the mock bash is skipped);
  the standard installs (`%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%\Programs`
  `\Git\cmd\git.exe`). Only `.exe` files are run directly — a `.cmd` shim would need a shell.
- `git --version` must succeed and be ≥ 2.23 (`git restore`); otherwise `not-runnable` with the
  reason. `not-installed` means no candidate exists.
- The repository list never fails for a missing git: it returns `{ git: availability, repositories: [] }`
  so the view can show its "Git not detected" state. Every other call fails with `GIT_UNAVAILABLE`.

## 5) Repositories and the request gate (`repositories.ts`, `paths.ts`)

- A space's folder is `getSpaceDir(spaceId)` (`services/space.service`, a memory read).
- Its repositories: the folder itself and its **direct** sub-folders holding a `.git` (directory, or
  file for worktrees and submodules). Dot-folders and symlinked folders are skipped; at most 1,000
  sub-folders are examined. Order: the folder itself, then by name.
- Every request names `spaceId` + `repoRoot`. `requireRepository` re-derives the answer in O(1):
  `repoRoot` must be the space folder or a direct non-dot, non-symlink child of it, with a `.git`.
  Nothing else is ever run.
- Summaries (`readRepositorySummary`) come from refs only — `symbolic-ref`, `for-each-ref` with
  `%(upstream:track)` — so listing repositories costs the same in a huge repository as a small one.
  Ahead/behind are as last fetched; nothing here touches the network.
- Client paths are repository-relative, forward-slash, normalized: no absolute path, no `.`/`..`/empty
  segment, no NUL, nothing under `.git` (its config can hold credentials). Before the working tree is
  read or an item is trashed, the parent directory's real path must lie inside the repository's real
  path; the entry itself is not followed (git stores a symlink as its target text).

## 6) Status and change lists (`status.ts`, `changes.ts`)

Status = `git status --porcelain=v2 -z --branch --untracked-files=all` plus `git diff --numstat`
(unstaged) and `git diff --cached --numstat` (staged), in parallel. X column → staged group, Y → unstaged,
`u` records → conflicted only, `?` → unstaged as `untracked`. The repository summary comes from the
`--branch` header; the in-progress operation from `MERGE_HEAD` / `rebase-*` / `CHERRY_PICK_HEAD` /
`REVERT_HEAD` in the git directory.

Change lists, one tree-ish against the working tree or the index, read with
`--raw --numstat -M` in a single run (`beforeRevision` is what the before side resolved to):

| scope | command | before | untracked |
|---|---|---|---|
| `uncommitted` | `git diff <HEAD>` | HEAD (empty tree before the first commit → `null`) | `ls-files --others --exclude-standard` |
| `staged` | `git diff --cached <HEAD>` | HEAD | — |
| `revision` | `git diff <commit or merge-base>` | `rev-parse <rev>^{commit}`, `merge-base HEAD <commit>` | yes |
| `since-review` | `git diff-tree -r <snapshot> <now>` | the snapshot tree | inside both trees (`added`) |

- Unmerged paths (`ls-files --unmerged`) are reported `conflicted` in every scope.
- Untracked files are line-counted from disk: files ≤ 1 MiB, at most 16 MiB read per listing; the rest
  keep a null count. Binary = a NUL in the first 8,000 bytes (git's rule).
- Untracked entries ending in `/` are nested repositories git does not look into. They are dropped:
  the space lists them as repositories of their own, and offering "discard" on one would trash a project.
- `generated: true` from one `git check-attr -z --stdin linguist-generated` over the listed paths.
- Every list is capped at `GIT_LIMITS.maxListedFiles` with `truncated: true`. Cost follows the size of
  the change, not of the repository (beyond git's own index refresh).
- Revisions from a client are refused if they start with `-` or contain whitespace/control characters;
  the before side is always used as a resolved object id afterwards.

## 7) File contents (`contents.ts`)

- Before: the blob at `beforeRevision:(oldPath ?? path)` via `ls-tree -l` (gives type and size) then
  `cat-file blob`. The client passes the list's `beforeRevision` back, so every file of one list shares
  a before side and no merge-base is recomputed per file. Only a full object id is accepted.
- After: index stage 0 for `staged` (`ls-files -s`), the working-tree file otherwise; symlinks read as
  their target, a submodule as `Subproject commit <oid>`.
- A side over `GIT_LIMITS.maxFileBytes` → `tooLarge`, a NUL byte → `binary`; either way both texts are
  omitted and the sizes kept. `beforeBytes` / `afterBytes` are present exactly when the side exists.
- A pruned snapshot surfaces as `GIT_SNAPSHOT_MISSING`, a vanished revision as `GIT_REVISION_NOT_FOUND`.
- **Gate.** Content reads come in bursts — a diff view scrolled fast, a remote client calling the route
  directly — and each runs up to two git processes at once (the two sides). At most 3 reads run at once
  (≤ 6 git processes); up to 32 more wait in arrival order; the 33rd is refused at once. A waiting read
  leaves the line after 15 s, or when its caller goes away (the HTTP route aborts on a closed
  connection; an IPC call cannot be cancelled). Every refusal is `GIT_BUSY` — nothing ran, retrying is
  safe. Validation and the repository check happen before the line, so a bad request never waits.
  At ~30 ms per read (§11) a full line drains in about a third of a second. Status, change lists and
  writes are one request per user action and are not gated.

## 8) Snapshots (`snapshot.ts`)

A snapshot is the whole working tree as a tree object: the real index is copied to a temporary file,
`git add -A --ignore-errors` runs against the copy (`GIT_INDEX_FILE`), `git write-tree` names the result,
the copy is deleted. Only files changed since the last real index refresh — plus untracked ones — are
hashed. The real index, the working tree and refs are never touched (a unit test compares the index
bytes and mtime).

- Ignored files are excluded; untracked ones included. Unreadable files are left out (logged once).
- The tree gets no ref, so it never shows in history; its blobs are unreachable loose objects that
  `git gc` prunes after its grace period (two weeks by default). Then "since last review" and the
  staleness count fail with `GIT_SNAPSHOT_MISSING` and the view asks for a new review.
- `countChangedSince` = a fresh snapshot + `diff-tree -r -M --name-only`; a rename counts once.
- Taken only for reviews: once when a review starts; for the staleness count, which the view asks for
  when it first shows a finished review, when it shows it again after files changed meanwhile, and on a
  manual refresh or a discard; and on every change-list load in the "since last review" scope (`now`
  side of `diff-tree`). The other scopes take none.
- Cost to know: untracked files are re-hashed on every snapshot (they have no stat cache in the copied
  index), and new content is written to the object store once. A huge untracked, non-ignored file is
  the expensive case (read + SHA-1 each time). Filter drivers follow §3: the user's own (e.g. a globally
  installed git-lfs) run as in `git add`; the repository's own are switched off.

## 9) Writes (`operations.ts`)

- Writes to one repository run one at a time (an in-process queue per root, released when idle).
  `index.lock` held by someone else → retried after 200 / 400 / 800 ms, then `GIT_LOCKED`.
- Stage: `git add -A -- <paths>` (deletions too). Paths already gone and not in the index are skipped,
  because one unmatched pathspec makes git refuse the whole batch.
- Unstage: `git reset -q -- <paths>` — the same as `git restore --staged`, but it also works before the
  first commit and tolerates paths that are no longer staged. A staged rename needs both of its paths.
- Discard: tracked paths → `git restore --worktree` (the staged part survives); untracked → the OS trash
  via `shell.trashItem`, never deleted outright; ignored files and directories are left alone;
  any unmerged path → `GIT_CONFLICTED` before anything changes.
- Commit: `git commit --file=-` (message on stdin, hooks run). Amend with an empty message keeps the
  previous one (`--amend --no-edit`); a plain commit with an empty message is `GIT_EMPTY_MESSAGE`. A hook
  that refuses (exit 1, a `pre-commit` / `prepare-commit-msg` / `commit-msg` hook installed) is
  `GIT_HOOK_FAILED` with the hook's output.
- Push (after commit, on request): plain `git push` when there is an upstream (the user's push config
  decides, as in a terminal); otherwise `git push -u <origin | the only remote> HEAD`. A failed push
  does not fail the commit: the result carries `pushError` / `pushErrorCode`.
- Sync: `git pull --ff-only --no-rebase`, then `git push` if ahead; a branch without upstream is
  published. Returns the refreshed summary and the commit counts pulled / pushed.
- Argument lists are split into ≤ 24,000-character batches (Windows command-line limit).

## 10) Errors (`errors.ts`)

Every failure is a `GitError` with a `GitErrorCode` (`shared/types/git.ts`) and git's own text.
Classification is by message (stable under `LC_ALL=C`), first match wins, credentials checked before
network because ssh reports a refused key as "Could not read from remote repository" too. Unknown →
`GIT_FAILED`, shown verbatim. The controller turns them into `{ success:false, error, code }`;
codes are `GIT_`-prefixed so they never collide with transport codes (the auth middleware's `LOCKED`).
`GIT_BUSY` is not from git: the content-read gate refused or dropped the request (§7).

## 11) Measurements (2026-10-03, macOS, git 2.39.5, APFS SSD)

Median of 7 runs through the service (spawn + parse included). This repository: 2,592 tracked files,
140 changed while the team was working in it.

| Operation | This repo | Synthetic 30k files (300 modified, 50 untracked) |
|---|---|---|
| list repositories (space with 11 repos) | 61 ms | 26 ms (1 repo) |
| status | 54 ms | 122 ms |
| change list, uncommitted | 63 ms | 112 ms |
| change list, staged | 31 ms | — |
| change list, revision (1,627 files) | 231 ms | — |
| file contents, one file | 29 ms | — |
| revision options | 48 ms | — |
| snapshot | 50 ms | 233 ms (first: 370 ms) |
| changed since snapshot | 67 ms | 157 ms |
| change list, since-review | 79 ms | — |

Lock contention: a loop committing 60 times (`git add` + `git commit`) in a 3,000-file repository
while the service ran status + change list + snapshot back to back: **0 of 60** commits hit
`index.lock`. The same loop against plain `git status` (which takes the optional lock): **28 of 60**
failed. That is what `GIT_OPTIONAL_LOCKS=0` buys.

## 12) Transport

`shared/rpc/contracts/git.contract.ts` (passthrough channels `git:*`) → `controllers/git.controller.ts`
(envelope + code; one warn line per failure) → `ipc/git.ts` (registered in `bootstrap/extended.ts`) and
`http/routes/git.routes.ts` (`POST /api/git/*`, same envelopes) → preload `bindRpc(gitRpc)` →
`renderer/api/git.api.ts`. Every route is `internal` in the API reference: an agent runs git itself,
in the same working tree, so these routes would add no capability.

## 13) Logging

One warn line per failed request (operation, code, first line), the git binary chosen (once per
change), skipped repositories, unreadable files. Nothing on successful reads — they are per click.

## 14) Tests

`tests/unit/services/git/` — parsers with real `-z` samples; path rules incl. symlink escape; real
temporary repositories (system temp dir, git isolated from user config by `_repo.ts`) for discovery,
status, every scope, contents, snapshots (index untouched), lock-free reads under a held
`index.lock`, all writes against a local bare remote, revision options, and git location with fake
binaries. `hardening.test.ts` arms repositories with an fsmonitor hook, external diffs, a textconv
driver and filter drivers (on a copied repository, so every file is stat-dirty), proves plain git runs
each, and asserts no service read does; a filter from the user's global config still applies (also
where the repository redefines it), and stage/discard apply the repository's filters as git does (§3.1).
`gate.test.ts` — the gate's order, bounds, wait limit and cancellation, and a 60-read burst against a
real repository (35 answered, 25 `GIT_BUSY`). `tests/unit/ipc/git.test.ts` — every channel
registered; IPC and HTTP answer identically.
