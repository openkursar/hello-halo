# Acceptance locally and in CI

Acceptance assets live with the source code and remain usable without a hosted
service. The catalog, generated handbook, test discovery and reports are separate
from the scheduler. See [the asset contract](../tests/acceptance/FORMAT.md).

A run reports **what changed in quality**, not a pass or fail verdict: which
scenarios newly fail, which were fixed, which keep failing, which verified
behavior is no longer verified, and how much is not covered yet. Scenarios that
have no runnable test, need a missing environment or a person are *not covered*;
they are future work, not failures. See [Triggering a run and reading its
result](#triggering-a-run-and-reading-its-result).

## Triggering a run and reading its result

Anyone with write access to the private controller repository can start a run
for any branch of the source repository. The machine that executes it is only a
build host; the triggering machine needs `git`, Node and an authenticated `gh`
for the controller account.

**From the GitHub page.** Open the controller's Actions tab, choose the
acceptance workflow, *Run workflow*, and fill what you need:

| Input | Meaning |
| --- | --- |
| `source_ref` | Branch of the source repository to test. Blank: the default branch |
| `modules`, `cases` | Comma-separated module or scenario ids. Blank: select by impact, or everything |
| `profile` | `fast` (a small core) or `regression` (everything applicable) |
| `full` | Ignore the baseline and select the whole profile |
| `sdk_ref` | SDK branch or commit. Blank: the controller's default SDK branch |

**From a terminal or an AI session.** The dispatch helper builds the same
request; it previews by default and sends only with `--execute`:

```bash
git config halo.acceptanceRepository owner/controller
git config halo.acceptanceAccount controller-login
node scripts/acceptance/ci-dispatch.mjs --source-ref my-branch --module chat --module teams
node scripts/acceptance/ci-dispatch.mjs --source-ref my-branch --module chat --module teams --execute
```

The branch must exist on the source repository before a run can test it, so push
it first under the repository's publishing rules. Module ids are the directory
names under `tests/acceptance/catalog/` (`npm run acceptance -- catalog` lists
them with their stories). An explicit module list runs exactly those modules:
add the modules that depend on them, or leave `--module` out and let the run
select by impact since the last baseline. Without a baseline for the branch, a
run with no module selection executes the whole profile, which takes much longer
than a module run. On a machine that reaches GitHub through a proxy, add
`git config halo.acceptanceProxy https://proxy.example:8443`.

**Reading the result.** Each run gives you, in order of effort:

1. The job summary on the run page opens with the quality findings: new failures
   first, then what was fixed, what keeps failing, what is no longer verified and
   how much is not covered, followed by the SDK commit that was tested.
2. A small artifact, `quality-<run-id>-<attempt>`, holding `quality.json` (the
   complete lists, with English and Chinese titles, for tools and notifications)
   and `summary.md`:

   ```bash
   gh run download <run-id> -R owner/controller -n quality-<run-id>-1
   ```

3. The full evidence, `acceptance-<run-id>-<attempt>`, with the HTML report at
   `ci/report/index.html`. It is large and private; it is also kept in the runner
   account's local archive.

If the run is **incomplete**, or any stage before execution failed, nothing about
the product can be concluded; the failing stage in the log says what to repair.
Otherwise: a *new failure* is a regression of the change under test unless its
reason points at the environment; *no longer verified* means a test binding or
required environment went away; *fixed* needs nothing; *still failing* is known
and is selected again every run; *not covered* is the backlog of scenarios that
still need a test, an environment or a person. A dispatch being accepted proves
nothing: wait for the run itself.

**The nightly run.** The schedule starts a run against the default branch every
day at 19:23 UTC with no input. Scheduled runs can be delayed or dropped, so look
for a missing run for a given day, not only for failures.

## Public checkout and private engine boundary

The root package references `@hello-halo/agent-sdk` through the local path
`src/sdk/halo-sdk`; that directory is not distributed in the public repository.
Do not create a stub SDK to make installation or E2E appear successful.

The helper installs with lifecycle scripts disabled, then explicitly runs the
existing `postinstall` and `prepare` steps for Electron/native dependencies and
host packaging binaries. `--ignore-scripts` means npm does not run these hooks
itself. Two situations exist:

- **No SDK checkout (public contributors).** Public dependencies install from the
  lock, the helper removes only the dependency-only SDK placeholder that install
  generates, and SDK execution stays unavailable.
- **A built, clean SDK checkout already at `src/sdk/halo-sdk` (maintainers, CI).**
  The install follows the release procedure: the lock is checked against the SDK,
  npm links the checkout, and nothing is removed. This is what CI does.

```bash
# public contributors
node scripts/acceptance/ci-prepare.mjs install
```

With an SDK, prepare it first (see below), then install:

```bash
node scripts/acceptance/ci-prepare.mjs install
npm run acceptance -- build
node scripts/acceptance/cli.mjs doctor --level e2e --json
```

This requires Node 22.14 or newer, network access to the locked dependencies and
build assets, native build prerequisites when a prebuild is unavailable, and a
GUI session for Electron. `install` deliberately refuses `.env.local` in a CI
checkout: explicit test configuration must not inherit personal credentials. It
also refuses a shared `node_modules` link and an SDK path that is not the clean,
built commit named by `HALO_SDK_REVISION`. Use a fresh checkout for dependency
preparation; never move an SDK that another checkout may be using just to pass
this check.

`package-lock.json` is the authoritative npm installation input. npm can still
rewrite an accompanying `yarn.lock` while saving its hidden dependency lock,
even during `npm ci`. The helper temporarily retains the original Yarn lock
outside npm's input, restores it byte-for-byte before running installation hooks,
and verifies all source manifests and locks after each stage. Unexpected lock
creation or modification blocks preparation and preserves the conflicting files
for inspection. No changed lock is silently reset or ignored for baseline checks.

The bundler externalizes the Halo SDK and runtime loading is lazy. Therefore
catalog validation and discovery do not need the private SDK, and UI/service
scenarios that do not execute that engine can use the public checkout. This is
an architectural boundary, not a claim that every public-clone test currently
passes. A clean-clone build and the chosen suite still have to pass on the target
OS. Scenarios that execute Halo SDK need that actual SDK. This branch also ships
the Claude Code SDK engine; application-wide engine selection takes effect after
restart. Tests for a different engine do not validate Halo SDK behavior. Missing
requirements must remain visible as blocked cases.

Authorized maintainers check out the SDK independently under
`src/sdk/halo-sdk`, with `HALO_SDK_REVISION` set to that exact 40-character
commit. Run these commands in order, before building the application:

```bash
node scripts/acceptance/ci-prepare.mjs sdk
node scripts/acceptance/ci-prepare.mjs install
node scripts/acceptance/ci-prepare.mjs bind-sdk
```

`sdk` requires its own clean Git checkout, installs its locked dependencies
without lifecycle scripts, and builds its distribution. It refuses shared
checkout, dependency or distribution links. `install` then verifies that the
SDK's declared dependencies agree with the entry the application lock holds for
it, and names every difference before npm starts: an SDK that moved without its
lock entry would also break a release build, so it is reported as an
integration fault rather than tolerated. `bind-sdk` verifies the selected
commit, clean source and compiled runtime entry points and that the link npm
created resolves to that checkout. Binding an already matching link is
idempotent; an existing SDK installation or a link to another location is never
replaced. The template follows the checkout → SDK build → install → bind order.

A prebuilt read-only local SDK can support local work. `bind-sdk` can validate an
already supplied source link without rebuilding it, but still requires the
explicit clean commit and all declared compiled entry points. Its identity must be
captured: source commit, dirty state and distribution content hash. Unknown or
dirty SDK source is reportable execution evidence but cannot advance a
reproducible nightly baseline. The report records no SDK checkout path or remote
URL. A package's existence alone does not prove its build corresponds to source;
the checkout-and-build route in the template is the reproducible one.

## Local execution

```bash
node scripts/acceptance/cli.mjs validate
node scripts/acceptance/cli.mjs discover --output tests/acceptance/output/manifest.json
node scripts/acceptance/cli.mjs plan --profile fast --manifest tests/acceptance/output/manifest.json --output tests/acceptance/output/plan.json
node scripts/acceptance/cli.mjs run --plan tests/acceptance/output/plan.json --output tests/acceptance/output/run
node scripts/acceptance/cli.mjs report --run tests/acceptance/output/run --output tests/acceptance/output/report
```

`plan` accepts repeated `--module` and `--case` arguments, `--platform`, and
`--base`/`--head` commit SHAs. No base means a full selection for that profile.
`run --timeout-ms` bounds execution; the CI helper uses 30 minutes. Live-model and
external execution require `--allow-live` and `--allow-external` respectively at planning time plus their declared prerequisites
and a separately agreed budget. The standard nightly template provides neither
live credentials nor an implicit live allowance.

A broad regression plan may be incomplete while cataloged cases are still
planned or manual. That is useful coverage information, not a reason to delete
the cases. Fast checks cover a narrower declared profile. Neither result asserts
that the whole product has passed.

## GitHub Actions controller

Copy [the workflow template](../tests/acceptance/ci/acceptance.yml) to
`.github/workflows/acceptance.yml` in an authorized **private controller
repository**. The template first runs a small GitHub-hosted job that checks the
controller's [repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository).
Public, internal or unverified visibility fails explicitly. The acceptance job
depends on that successful check before it can occupy a personal runner, receive
source/SDK environment values, check out source or install dependencies. This
check uses the controller identity, not a caller-selected source repository.
Contributors can use their own private controller and runner or adapt the
acceptance runner labels to a GitHub-hosted OS. The template never runs on
pull-request events.

Complete provenance and evidence stay in the private controller: SDK commits and
build identities are needed for traceability and are deliberately retained.
Screenshots, diagnostic artifacts and logs may reveal local paths or other
private context. Text redaction does not make a complete run directory safe for
public upload. Share publicly only a manually reviewed, sanitized summary; do
not publish raw run records, SDK identities or evidence artifacts. This template
does not replace or alter the public repository's existing workflows.

Configure these repository variables as needed:

| Variable | Meaning | Default |
| --- | --- | --- |
| `HALO_SOURCE_REPOSITORY` | Source `owner/repository` | Controller repository |
| `HALO_SOURCE_REF` | Default source branch: what the nightly run tests, and the branch other branches are compared with | `main` |
| `HALO_ALLOWED_SOURCE_BRANCHES` | Optional JSON array that narrows which branches of the source repository may run | Absent: any branch of the configured source repository |
| `HALO_ACCEPTANCE_PROFILE` | `fast` or `regression` | `regression` |
| `HALO_ACCEPTANCE_RUNNER` | JSON runner label array | `["self-hosted","acceptance","macOS"]` |
| `HALO_ACCEPTANCE_ARCHIVE_ROOT` | Dedicated absolute local evidence archive directory, outside checkout, workspace and runner temporary storage | `~/.halo-acceptance-archives` under the runner account |
| `HALO_SDK_REPOSITORY` | Optional separately authorized SDK repository | Absent |
| `HALO_SDK_REF` | SDK branch to follow; its head is resolved at run time and recorded in the result | Absent |
| `HALO_SDK_REVISION` | Exact 40-character SDK commit to pin instead; used only when no SDK branch is given | Absent |

`HALO_SOURCE_READ_TOKEN` is only needed when the controller's token cannot read
the source. For a private SDK, prefer `HALO_SDK_READ_SSH_KEY` containing a
repository-specific deploy key with write access disabled. The template selects
SSH when that key is present and ignores `HALO_SDK_READ_TOKEN`; without SSH it
falls back to that repository-scoped read token or the workflow token. Do not
persist an administrator PAT as a workflow secret for read-only SDK checkout.
Deploy keys are repository-specific and read-only by default; see
[GitHub deploy-key guidance](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).

Give source credentials read access to the relevant repository only. Runner
administration credentials are for initial registration, never workflow
secrets. Checkout does not persist credentials. The workflow token has only
`contents: read` and `actions: read`; artifact upload uses Actions' artifact
service. Do not attach unrestricted external PRs to a personal-machine runner.

Manual input can select a source branch, an SDK branch or commit, a profile,
modules, cases and a full selection. The controller rejects a different source
repository, an unsupported branch name, a branch that does not exist and, when
`HALO_ALLOWED_SOURCE_BRANCHES` is set, a branch outside it, all before checking
out any source code. Only branches of the configured repository are admitted;
pull-request refs and forks are not, so write access to that repository is the
trust boundary. With `HALO_SDK_REPOSITORY` set the SDK follows `HALO_SDK_REF`
(or the manual `sdk_ref`, which must be a branch name or a commit of that
repository, never a `refs/` path) and the commit actually checked out is what
the result records; without a branch the pinned `HALO_SDK_REVISION` is used, and
without either the run stops rather than guess. An `sdk_ref` on a controller
that has no SDK repository stops the run instead of being ignored. Whoever can
dispatch can run any branch's scripts on the build host, and a branch's own
scripts name the baseline it publishes, so dispatch permission is itself a
trust grant.
The checked-out source is resolved to a full SHA before preparation and that SHA
is used for planning and results. The source working tree is separate from a
developer's active checkout. A concurrency group serializes runs of the same
source/ref; an individual runner executes one job at a time, so runs started
for different branches wait for each other. GitHub keeps one waiting run per
group: a third dispatch for a branch that has a run executing and one waiting
replaces the waiting one, so do not queue several runs for one branch at once. Do not register
multiple runners in the same GUI session when their tests share OS resources.

The sample schedule is 19:23 UTC daily. Adjust it for the intended operating
window; do not assume the Mac is awakened by GitHub. Scheduled workflows must be
present on the controller's default branch and can be delayed or dropped. A run
on Sunday UTC requests a complete profile sweep regardless of the baseline;
manual `full` does the same. An operator should check for missing runs, not just
failed runs. See [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Baselines and honest outcomes

Each run ends in one of two ways. It is **complete** when everything it executed
produced a trustworthy result, whatever those results are: the workflow step
succeeds even though scenarios failed, because a failing scenario is a finding
about the product. It is **incomplete** when it lost results, failed its
evidence-integrity checks, never selected anything or broke the runner; that is
a fault of the pipeline and fails the step.

The **baseline** is a record kept for each repository, branch, profile, OS and
architecture. It carries the last complete run's source commit, catalog and
manifest hashes, originating run id and final evidence-freeze hash, and the last
known result of every scenario instance. It serves two purposes:

- *Change selection.* The next unscoped run selects the changes since the
  baseline commit, plus every scenario that failed last time whatever the change
  touched. It applies only when the baseline is a supported version, an ancestor
  of the target, from the same SDK identity and catalog scope; otherwise the
  full profile runs. A baseline is a cursor, not evidence that every behavior
  passed.
- *Comparison.* The run is compared with the baseline of its own branch, or with
  the default branch when the branch has none, regardless of SDK or catalog
  differences. Without any earlier result nothing is called new.

A run reports, against those earlier results: **new failures** (passed, was not
covered or did not exist before), **fixed** scenarios, failures that **continue**,
verified behavior that is **no longer verified** (it passed before and is now
blocked, manual or skipped), unstable scenarios and how much is **not covered**.
The full lists are in `quality.json`; the job summary shows the new failures and
keeps the rest collapsed.

Only an unscoped, complete run that executed at least one scenario, from a clean
source checkout, with evidence producers stopped and a verified final snapshot,
publishes a new baseline. Failed, blocked, manual and skipped scenarios do not
hold it back; a run that lost results does. A module or case selection compares
with the baseline but never replaces it, since it proves nothing about the rest.
Scenarios that did not run keep their last known result while they still exist
in the catalog. The restore lookup also checks the enclosing workflow's final
conclusion, so an artifact created before a later workflow failure is ignored.
Job summaries and report/evidence artifacts are attempted even after failure.
Dependency/build failures have a blocked summary rather than an empty passing
run. Artifact retention is 30 days for evidence and 90 for baselines; loss of an
old baseline safely increases the next selection and removes the comparison.

After planning, CI builds a package only when a selected, unblocked scenario
requires `packaged-app` and has a matching executable binding. It takes the
application path from that newly generated package record and passes it to the
normal runner, which still verifies the package before and after execution.
An inherited `HALO_E2E_PACKAGED_APP` is ignored. Packaging failure or an invalid
package record fails its recorded CI stage and cannot advance a baseline.

Controlled packaging reuses the checkout-installed Electron distribution through
the official [`electronDist` option](https://www.electron.build/v26/docs/api/app-builder-lib.interface.configuration/#electrondist).
The exact package declaration, lock entry, installed package and distribution
version must agree. A bounded Node-mode probe checks the actual Electron version,
platform and architecture; an inherited `ELECTRON_OVERRIDE_DIST_PATH` is refused.
An archive that would take priority over the unpacked distribution is rejected,
and external Node preload/module-path settings are cleared for the probe and builder.
The complete runtime tree is fingerprinted before and after packaging and remains
part of package verification. Version 2 package records require a fresh package;
older records do not establish this runtime provenance.

The helper copies that runtime into an owned temporary staging directory and
removes only the stock `default_app.asar` and `version` files that the normal
download/extraction path removes. It then runs the existing product configuration,
hooks and local signing flow with publishing disabled. The installed distribution
is kept intact, and staged bytes must still match their captured inputs before
the staging directory is removed. This avoids repeated Electron artifact downloads;
dependency installation and other platform packaging tools can still need network
access. Actual Windows and Linux packaging need their own execution evidence.

One plan can contain source, packaged and cluster tests. The runner groups
eligible tests by the requirements of their selected scenario variants. Only
the packaged group receives the verified package path; source test hosts and
cluster processes explicitly clear it. Every group shares the run's time budget
and contributes to the same report, including cases that remain blocked or
unimplemented. Grouping does not reduce the planned coverage.

The report records each batch's execution configuration and the build or package
supplied to it. These records describe the harness input. Tests must still
observe the actual application and engine to establish packaged behavior; a
package supplied to one batch says nothing about another batch's runtime.

Selected, unblocked scenarios with a matching binding and `chromium-browser`
requirement also trigger `ci-prepare.mjs browser`. It resolves Chromium, its
headless shell and supporting runtime files from the installed Playwright version
and checks that version against the lock. Matching files are reused; missing
files are prepared with that installed package's `install chromium` command.
No `npx` version lookup, operating-system package installation or browser launch
is performed by preparation.

CI uses Playwright's standard isolated `ms-playwright` cache, ignoring inherited
browser-path overrides. Browser-cache garbage collection is disabled so preparing
this revision does not prune other projects' runtimes. Preparation failure or
missing binaries stop execution and baseline publication. Runtime-file readiness
does not establish that the host's system dependencies or browser interactions
work; the selected scenarios still provide that evidence. Selections without
this requirement do not prepare or download Chromium.

## Cancellation and evidence completion

The execution step uses `exec node scripts/acceptance/ci-run.mjs` so CI signals
reach the asynchronous owner directly. Each stage is recorded as running before
its child starts. Registered subprocesses, source CLI commands and the Playwright
reporter retain producer identities outside the report payload. Registration and
owner closure share an exclusive admission gate: an in-progress registration
cannot be missed by a finishing owner. This tracks evidence-producing processes,
not every internal product process or agent session.

SIGINT or SIGTERM stops new stages and requests cleanup of only the owned process
tree. Cancellation remains cancellation even if a cooperative child exits zero.
The existing execution deadline is unchanged. No daemon or detached replacement
job continues the task after CI cancellation. An unknown cleanup result, missing
process identity or surviving process group prevents final evidence confirmation.

The separate `ci-finalize.mjs` step requires the recorded owner to have finished
and exited and every registered producer to have closed and exited. It collects
declared diagnostics, writes the quality findings and the summary, then publishes a write-once
`producer-completion.json` and `evidence-freeze.json` containing the complete payload
hashes and controller run/attempt identity. Verification rejects changed files,
wrong source revisions and late summary writes. A failed or cancelled execution
can have a final, verified failure snapshot; that never makes its cases pass.

If the owner is killed, a registration gate is abandoned or a producer's exit
cannot be established, finalization fails closed without a freeze. Failures before
the execution owner starts also retain only diagnostic, non-final snapshots.
A quiet period or fixed sleep cannot establish completion. Baseline creation is
separate from the frozen payload and occurs only after finalization verifies the
exact complete run and source context. The workflow then additionally requires
a final archive and successful enclosing steps before publishing that baseline.

## Local evidence retention

After attempting evidence finalization, the template always attempts a local archive when
the initial source context was captured. This step uses only Node built-ins, so
dependency installation or application-build failure can still leave a useful
archive. It runs before the independent `upload-artifact` step. An archive error
fails its CI stage; upload still runs under `always()` when the archiver provides
a verified safe snapshot path. Neither a local archive nor
an attempted upload confirms that GitHub received an artifact.

The runner account owns a dedicated `~/.halo-acceptance-archives` directory.
`HALO_ACCEPTANCE_ARCHIVE_ROOT` can select another absolute location with an
existing real parent directory. The helper refuses symlinks, any overlap with
checkout/workspace/runner temporary storage, and an existing root without its
management marker. Use a new dedicated directory; do not point this at a folder
containing unrelated files. Archives are private evidence with the same disclosure
limits as the original run, even when their reports are readable by the local
account's group.

Each controller run and attempt gets an exclusive entry containing:

```text
run-<run-id>-attempt-<attempt>-<controller-hash>/
  archive.json       # management identity
  manifest.json      # copied paths, hashes, observed metadata and source finality
  COMPLETE.json      # version 2: matching frozen input and verified copy
  ci/                # exact regular files from tests/acceptance/output/ci
```

Before copying, the helper checks the matching run's producer-completion and
`evidence-freeze.json` contract. It checks the source again immediately before
publishing completion and verifies the frozen payload inside the copy. The
archiver never stops processes or treats a quiet interval as proof that writers
have finished.

Missing, mismatched or unsettled freeze evidence cannot produce a final archive.
Where a safe copy is possible, it is retained with `INCOMPLETE.json` and the
archive stage fails explicitly. An interrupted or changing copy remains pending
without either completion marker. These diagnostic snapshots do not trigger
retention cleanup or authorize a baseline, and the helper never later fills in a
completion marker for the same run/attempt entry.

The upload step reads the retained snapshot entry, not the possibly still-active
checkout evidence directory. Successful archives expose `source-final=true`;
a failed archive exposes `source-final=false` and a snapshot path only after
rechecking that invocation's original root and entry identities, ownership,
permissions and complete regular-file payload. Unsafe or unconfirmed paths are
withheld from upload. A downloaded bundle therefore contains reports beneath
`ci/report/`, alongside its archive management records. A safe diagnostic upload
does not turn the failed archival stage into success or permit baseline publication.

The helper copies actual files under `ci/`; it does not follow links or collect
paths mentioned inside JSON. It records source commit, catalog identity and test
status when those records are available, and preserves uninterpretable records as
original bytes. Original files, modes and evidence-integrity fields are never
changed. New directories use mode `0750`. Files preserve owner read/write and
group read permissions already present, removing other permissions: `0644`
becomes `0640`, while `0600` remains `0600`. This implementation requires POSIX
ownership and no-follow file opens. Windows reports an unsupported **archive
stage**, not a product-test failure. Without a verified safe snapshot path the
template withholds remote upload; it does not fall back to a possibly live directory.

Version 2 `COMPLETE.json` means the listed local copy and its final source freeze
were verified. It does not mean tests passed, integrity passed, upload succeeded
or a baseline advanced. The
manifest records the observed test status separately from
`remoteUpload.status: not-observed`. Later verification reads and hashes the copy
without altering it:

```bash
node scripts/acceptance/ci-archive.mjs verify /absolute/archive-entry
```

Historical version 1 completion records remain readable as verified copies with
`sourceFinality.state: legacy-unverified`. Their original manifests, completion
markers and payloads are never rewritten or backfilled with newer evidence.

The helper never overwrites a run/attempt entry, including an interrupted pending
copy. A root-wide exclusive lock serializes copying and retention across
controllers. A lock surviving interruption is retained: inspect its PID and
confirm that archival has stopped before resolving it; do not remove a live lock
to start a competing archive.

**This dedicated root is automatically cleaned.** Only after the new archive has
been published and fully verified does retention keep the newest fourteen
verified version 2 final archives for the current controller repository. Runs, refs and
profiles of that controller share this quota. Verified archives belonging to
other controllers are separately logged, counted and preserved. The new archive
is always retained. Older eligible candidates and the current source freeze are
verified again before removal; a late source change stops further retention cleanup.
Legacy copies without final-source proof, non-final snapshots, unknown, pending,
tampered or unmarked entries are logged and preserved;
they can exceed the fourteen-archive limit and require operator review. Failure to
copy or verify the new archive never starts cleanup. The files are write-once through
this helper, not an operating-system immutable backup: verification detects later
local alteration, and local retention is independent of GitHub's artifact expiry.

The helpers can be exercised without GitHub or Electron:

```bash
node --test tests/acceptance/ci/*.test.mjs
```

## Dedicated runner setup

Download and verify the official runner distribution using GitHub's runner setup
page. Extract it into a new directory owned by the dedicated operating-system
account. Existing runners are not reused, reconfigured, stopped or replaced by
these helpers.

Preview registration, then execute it only after authorization:

```bash
node scripts/acceptance/ci-runner.mjs --directory /path/to/new-runner --repository owner/controller --name acceptance-mac
node scripts/acceptance/ci-runner.mjs --directory /path/to/new-runner --repository owner/controller --name acceptance-mac --execute
```

The helper requires repository runner-management permission through `gh`, or a
short-lived registration token supplied as `ACTIONS_RUNNER_INPUT_TOKEN` in the
current process environment. It passes that token through the runner's supported
environment input, not command-line arguments or a source file. It registers
only; it does not install a system daemon or modify login/power settings.

On macOS, first log into the dedicated account graphically. No Apple ID or
separate full GitHub login is required merely to run Electron tests. The bundled
runner service template can set `SessionCreate=true`, which creates a separate
security session. A GUI runner must reuse the existing login session. The shipped
[GUI service template](../tests/acceptance/ci/macos-gui-runner.plist.template)
sets `SessionCreate=false` and limits loading to `Aqua`, while retaining the
official `svc.sh` placeholders. From the new runner directory, install its user
service once with a readable template path:

```bash
GITHUB_ACTIONS_RUNNER_SERVICE_TEMPLATE="/path/to/checkout/tests/acceptance/ci/macos-gui-runner.plist.template" ./svc.sh install
./svc.sh start
```

Use the dedicated user's graphical session and no `sudo`. Do not install over an
existing runner or modify another runner's service. For an authorized update to
the dedicated service, inspect its generated plist and stop it cleanly; confirm
the old service has fully exited before loading the replacement. A transient
bootstrap error during teardown is a reason to inspect state, not to retry
indefinitely. Service reinstalls or updates can regenerate the plist, so inspect
and revalidate it afterward.

A runner showing online does not establish GUI readiness: verify Electron reaches
ready, creates a window and completes a real UI action from that service. Changing
`SessionCreate` alone is not passing product evidence. A system daemon does not
establish a GUI login. Validate locked-screen, switched-user and wake-from-sleep behavior
on the actual machine before depending on those states. Restart with FileVault
can still require manual login. See [GitHub service setup](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application?platform=mac),
[Apple user sessions](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPMultipleUsers/Concepts/FastUserSwitching.html)
and [scheduled wake](https://support.apple.com/en-au/guide/mac-help/-mchl40376151/mac).

The template runs a separate GUI readiness check immediately after public
dependency installation, before the optional SDK checkout or application build.
`ci-run.mjs` repeats it immediately before product execution, after any browser
or package preparation. Public dependency installation itself remains usable
without a graphical session. To check a runner independently:

```bash
node scripts/acceptance/cli.mjs doctor --level gui --json
```

This probe uses the installed Electron and Playwright runtimes to open an owned,
isolated window, reach app readiness, perform a real button click and verify
cleanup. It needs no SDK, product build, model credentials or runtime download.
Its default execution budget is 15 seconds, followed by bounded cleanup. Each
invocation writes to a new evidence directory; `--output` may select a new
directory under `tests/acceptance/output`. It never overwrites previous evidence.

The workflow retains early-check evidence under
`tests/acceptance/output/ci/host-readiness-install/`; the second check uses
`host-readiness-execution/` beside it. Each includes `readiness.json`, `probe.log`
and a screenshot when available. A failure records the stage and cleanup result;
an unconfirmed cleanup also retains the isolated profile for diagnosis. Exit code
2 means the host was not ready. CI stops before product tests and baseline
publication, preserving the host failure in its summary and artifacts. A ready
probe is environment evidence, contributes no passing acceptance cases and does
not establish that every OS permission or native interaction works.

Playwright's Electron protocol operations do not justify blanket permissions.
Grant screen recording, accessibility or filesystem permissions only when a
specific real test needs them, to the actual executable performing that action.
Native dialogs, OS notifications and external QR login remain separate evidence
boundaries. Windows packaging, Python/PATH and shell regressions require Windows
execution, including a clean environment without developer tools; a macOS pass
does not cover them. See [Playwright's Electron boundary](https://playwright.dev/docs/api/class-electron).

## Dispatch from an AI workflow

Preview the request before dispatching an authorized workflow:

```bash
node scripts/acceptance/ci-dispatch.mjs --repository owner/controller --source-ref main --profile fast
node scripts/acceptance/ci-dispatch.mjs --repository owner/controller --source-ref main --profile fast --execute
node scripts/acceptance/ci-dispatch.mjs --repository owner/controller --module teams --profile regression --execute
```

`--ref` chooses the controller workflow ref; `--source-ref` chooses the source
branch under test and `--sdk-ref` the SDK branch or commit. `--full` requests a
complete profile sweep. Dispatch requires the
repository's GitHub publishing rules and appropriate authorization. The helper
does not create repositories, enable schedules, alter runner permissions, publish
issues or claim a run passed before its evidence exists.

Omitting `--source-ref` preserves the controller's configured source branch; the
workflow falls back to `main`. `--module` and `--case` may be repeated. These
explicit scopes cannot become a full-profile baseline. Local contributors may
store the controller and an already authenticated CLI account in untracked Git
configuration:

```bash
git config halo.acceptanceRepository owner/controller
git config halo.acceptanceAccount github-login
```

The helper uses that account only for the request and does not switch the CLI's
global active account. A direct user request to run a specific CI scope supplies
authorization; preview the concrete request and execute without asking the same
question again. Observe the actual workflow run and report its result, not merely
the successful dispatch.

Each dispatch has a unique `request_id`, saved under the ignored
`tests/acceptance/output/dispatches/` directory and included in the workflow's
display title. Match that identifier when looking up the workflow run; never
assume the most recent run belongs to the request. An uncertain response is a
reason to inspect that receipt and run history, not to submit duplicate work.

Query a saved receipt without changing it, or explicitly save the latest
observation alongside the original dispatch result:

```bash
node scripts/acceptance/ci-dispatch.mjs --receipt tests/acceptance/output/dispatches/request-id.json
node scripts/acceptance/ci-dispatch.mjs --receipt tests/acceptance/output/dispatches/request-id.json --reconcile
```

Both commands only issue GET requests. They never resend or cancel a dispatch,
and reconciliation preserves its original request, identity and transport result.
The JSON result distinguishes no match yet, one match, multiple matches and an
incomplete lookup. No match is not proof of rejection: a queued run may not yet
be visible. A unique match is established only after completing the bounded
search; a failed page or exhausted limit leaves the observation incomplete.
Lookup uses the workflow filename, dispatch event and fixed creation-time range,
deduplicates run IDs, and stops after 10 pages or 60 seconds. Individual requests
are limited to 15 seconds and the remaining total budget. See the official
[workflow run listing parameters](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).
The run's revision belongs to the controller; the tested source revision must
come from the acceptance artifacts.

For a local network that needs an explicit proxy, configure
`git config --local halo.acceptanceProxy https://proxy.example:8443` or set
`HALO_ACCEPTANCE_CI_PROXY` in the calling process. The environment override takes
precedence; an explicitly empty value clears inherited proxy settings for the
helper's `gh` children. Only complete HTTP(S) proxy endpoints are accepted. The
helper changes no system proxy, global Git configuration or account selection.
Keep proxy credentials in the process environment rather than local Git config.
Receipts record only the configuration source and safe transport classification,
exit code, error code and HTTP status, never a proxy URL, token or raw stderr.
EOF, TLS, timeout and HTTP 5xx responses leave dispatch status `unknown`; inspect
the receipt before deciding whether another dispatch is appropriate. Exit code
2 means an incomplete lookup; a complete lookup returns 0 even when it finds
zero or multiple matches.

The self-hosted template executes only its configured source repository. Any
branch of that repository may run unless `HALO_ALLOWED_SOURCE_BRANCHES` (a JSON
array) narrows the choice. It resolves the branch through the API before checkout
and then checks out the fixed SHA. Pull request refs and arbitrary forks are not
admitted to a personal runner; keep write access to the source repository limited
to people whose code may run there.
