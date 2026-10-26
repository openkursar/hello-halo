# Behavioral acceptance

This is Halo's versioned product-behavior catalog and its connection to executable
verification. A person reads the generated handbook; contributors edit the same
Git-backed stories and tests. There is no independently editable test-management
copy and no manually maintained binding registry.

Start with [FORMAT.md](FORMAT.md) for record schemas and
[COVERAGE-AUDIT.md](COVERAGE-AUDIT.md) for the initial inventory, evidence boundaries
and tests deliberately left unbound. The catalog is a baseline of known product
behavior, not a claim that every possible behavior or environment is already tested.

## What is authoritative

| Asset | Responsibility |
|---|---|
| `catalog/<module>/module.yaml` | A user capability, applicable scope, dependency relationships and conservative changed-path mapping |
| `catalog/<module>/<story>.yaml` | User goal, promises, concrete scenarios, source references and genuine open decisions |
| `contracts/*.yaml` | Shared promises and scenarios, imported explicitly by stories |
| `schemas/` | Strict catalog, human-decision and executable-binding formats |
| Existing test source annotations | Which exact scenario and variant an executable test proves, at which boundary |
| `approvals/*.json` | Explicit human decisions against exact semantic versions |
| `output/` | Generated catalog, discovery manifest, execution plans, handbook and immutable run evidence; ignored by Git |

Human-readable fields contain English and Chinese together (`en`, `zh`); IDs,
paths and execution metadata remain language-independent. One story is one file.
The source contains natural-language preconditions, actions and expected outcomes,
not selectors, executable commands or copied test bodies.

`documented` identifies an established written contract; `observed` identifies
behavior reconstructed from current code and tests; `proposed` identifies a desired
behavior whose product choice is not established. The first two can be used as
regression baselines immediately. **The owner does not need to approve the whole
historical catalog one story at a time.** Discovery never fabricates a human
approval. Human attention is reserved for future semantic changes, conflicting
contracts and genuine open product decisions. Technical fixture choices, missing
machines and routine automation work are not product questions.

A test failure can reveal either an implementation defect or an incorrect baseline.
Record and explain that distinction. Do not make a test green by silently weakening
an expected outcome, narrowing its audience or removing a required scenario.

## Read and validate without running the app

From the repository root:

```bash
npm run acceptance -- validate
npm run acceptance -- doctor --level catalog
npm run acceptance -- catalog
npm run acceptance -- report --locale zh
```

The generated handbook defaults to `output/site/`. English output uses
`--locale en`. The handbook is a view of the catalog, not another source of truth.
Reports without a supplied run show catalog state and coverage gaps; they are not
execution reports and contain no implied passing results.

Discovery reads test-runner registrations, including parameterized tests. It does
not launch the test fixtures or call a model:

```bash
npm run acceptance -- discover
```

Unknown case IDs, mismatched evidence modes, unsupported variants and duplicate
binding identities must be resolved before execution. A scenario can remain
`planned` without a binding; it stays in the coverage denominator. `automated`
means an executable has been attached, not that it passed on this machine.

## Select and execute

Build and provision the application before executing desktop tests. Use a dedicated
profile and machine/account session; all fixtures must isolate application data.
Do not run Electron, cluster and performance suites concurrently on one host.
The controlled build removes only its generated application and resource outputs
before invoking the real build. It holds an exclusive build lock and records
version 2 provenance; older stamps must be rebuilt. Source files, installed
dependencies and previous run evidence are not cleared.

```bash
npm run acceptance -- build
npm run acceptance -- doctor --level e2e
npm run acceptance -- plan --profile fast
npm run acceptance -- plan --profile regression --module chat --module teams
npm run acceptance -- plan --case chat.messages.persist
npm run acceptance -- run --plan tests/acceptance/output/plan.json --timeout-ms 1800000
```

To plan from changes, pass a known baseline commit and resolved target commit with
`--base <commit> --head <commit>`. The plan records those inputs and the actual
source identity. Unknown changed paths and shared infrastructure changes broaden
selection conservatively. This mapping is selection guidance, not proof that other
modules cannot regress. Scheduled rotation and complete applicable regressions
remain necessary.

A saved plan is rejected if its catalog, test manifest, source identity or execution
platform changed. Regenerate it after changes. Each run has its own directory and
records actual attempts; rerunning does not replace the previous evidence.

```bash
npm run acceptance -- report --run <run-directory> --locale zh
```

`live` and `external` profiles are separate from ordinary deterministic regression.
Live models require explicit opt-in and a budget-enforcing broker. Keep the
configuration outside Git and reference a dedicated credential environment variable:

```json
{
  "upstream": "https://api.example.test/v1",
  "protocol": "openai",
  "model": "configured-test-model",
  "apiKeyEnv": "HALO_ACCEPTANCE_MODEL_KEY",
  "maxRequests": 8,
  "maxOutputTokens": 1024,
  "maxInputBytes": 131072,
  "timeoutMs": 120000
}
```

Use `--profile live --allow-live --live-config <private-config.json>` when planning,
and supply the same configuration when running the plan. The real credential is
kept in the parent broker; workers receive only its temporary loopback credential.
All live groups share the request allowance. Output tokens, input bytes and request
timeout are per-request ceilings, not a currency estimate. Failed requests and
retries consume the allowance. Supported model operations are Chat Completions and
Messages; unsupported routes are refused. A live-model pass requires an isolated
application profile and an actual broker response in its execution window.

`--timeout-ms` bounds test execution groups together. Discovery, build verification
and the outer CI job have separate limits. Test-only source edits require fresh
discovery/planning but do not require a product rebuild. Product inputs or output
changes invalidate the controlled build.

For directory-package checks, run `npm run acceptance -- package` after the
controlled build and set `HALO_E2E_PACKAGED_APP` to its returned executable. This
builds a normal platform target without publishing so the directory includes its
updater configuration. The accompanying archive or installer is not tested by
these directory-package checks. The
harness verifies that package before and after execution; an unrelated old binary
is refused. Package provenance compares the compiled application and SDK runtime
with the controlled build and fingerprints the complete actual application bundle.
Other dependencies may be legitimately pruned or replaced by packaging hooks;
their installed inputs are captured, but package provenance does not certify
every dependency's runtime behavior. Starting the packaged app and executing its
bound tests provide that behavioral evidence. Installation dialogs and release
signing/notarization require separate checks.

External accounts, native dialogs, signed packages and multiple
machines require their configured prerequisites; an opt-in flag does not supply
those resources. Missing prerequisites are `blocked`, not `passed` or permanent
`manual` classification.
The `file-symlinks` prerequisite probes actual file-link support using temporary
data; a host that denies link creation cannot establish file-link escape coverage.

Unconfirmed `proposed` stories remain in the handbook but are outside ordinary
regression. A current human decision admits them; `--include-proposed` is an
explicit exploratory/TDD selection and is not implicit product approval.

The CI implementation and deployment template live in [ci/](ci/). A template in
Git does not mean a runner, logged-in desktop session or schedule is installed.
Keep operational provisioning separate from the catalog's product promises.

## Interpret coverage honestly

The coverage denominator is the declared product scope and its required scenario
variants, not the number of tests that happened to execute. Read these separately:

- Known stories and promises, with unresolved proposals clearly identified.
- Scenarios with executable bindings versus planned or genuinely manual steps.
- Applicable variants selected for this host and profile.
- Actual passed, failed, flaky, skipped, blocked and not-run evidence.

Execution also records an explicit evidence-integrity check. Source or build
changes during execution, unexpected tests and runner-level errors invalidate
passing case results. Raw attempts remain available for diagnosis. The handbook
does not count records with a failed or missing integrity check as verification,
even if their recorded test attempts passed; rerun against a stable build instead
of editing the historical record.

`platforms` describes the **Halo host OS** (`darwin`, `win32`, `linux`). A separate
`variants.client` distinguishes native Android and iOS clients. Browser viewport
variants are not native-device coverage. A macOS host run never certifies Windows
execution; a desktop test at 375px never certifies an Android or iOS app.

The optional interactive terminal is currently supported on macOS and Windows,
with an explicit refusal on Linux; ordinary command tools have a different support
boundary. Product edition and runtime availability also matter. Do not infer an
unsupported capability from a fixture that happened to provide it.

| Evidence | What it can establish |
|---|---|
| `ui` | Rendering and interaction at the declared fixture boundary; mocked IPC does not prove application behavior |
| `app-e2e` | The actual application path and observable result; a local scripted model may replace only model output |
| `integration` | Real cooperating modules, tools or cluster nodes; entry may be an API or a dedicated Electron fixture |
| `live-model` | A real model exercised the declared path; result quality and deterministic correctness remain separate |
| `external` | The identified external platform, device or installation path actually participated |
| `manual` | A specifically identified human-only action, with its reason and surrounding automation separated |

The same story may need multiple evidence boundaries. A browser module's screenshot
test does not certify the conversation that asks the model to use that browser.
An OS-notification log line is not evidence that a person received or opened a
notification. A required skipped test never contributes successful verification.

## Maintain the system with a feature change

1. Find the affected user stories, applicable shared contracts and cross-feature
   journeys. Update the user-visible behavior only when the intended contract
   actually changes; preserve stable IDs for the same meaning.
2. Distinguish existing documented/observed behavior from a proposal. Present only
   meaningful semantic differences or unresolved product choices to the owner.
   Approval of implementation work does not invent approval of new product rules.
3. Add or adjust concrete scenarios, including relevant failure and recovery
   behavior. Declare supported dimensions deliberately rather than expanding every
   theoretical role/platform/engine combination.
4. Keep implementation in its current test tier. Add an `acceptance` annotation
   with the exact case ID, evidence boundary, model mode and parameter variant.
   A test must independently assert every outcome it claims.
5. Validate and rediscover, then run the selected plan. Inspect missing and flaky
   results alongside failures. Preserve complete scope when reporting a partial run.
6. Generate the handbook and run report from the same source version. An approved
   contract's semantic change requires a new explicit decision; ordinary binding
   or evidence updates are not a request to reapprove the historical product.

Manual verification is reserved for an actual human action, such as approving a
third-party login on the account holder's trusted device. A missing test account,
a Windows machine that has not been provisioned, or a long soak that has not been
run is an automation or environment gap instead.

## Independent exploration

The catalog is intentionally extensible. Periodic exploratory work should compare
real UI entry points, role boundaries, lifecycle transitions and failures against
the catalog, then add concrete missing stories or scenarios. Exploration findings
are observations or proposals until reconciled; they must not silently change a
confirmed requirement. A green selected regression is evidence about that declared
selection, never proof that exploration is finished forever.
