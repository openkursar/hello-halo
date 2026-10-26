---
name: acceptance-testing
description: Maintain Halo's user-outcome acceptance catalog, choose and run its modular regression suites, and investigate missing or failed end-to-end evidence. Use for acceptance coverage and regression work, including nightly CI; not for ordinary isolated unit tests.
---

# Halo acceptance testing

Read [the catalog contract](../../../tests/acceptance/FORMAT.md) before changing
acceptance assets. For runner setup, nightly execution, or public-clone limits,
read [the CI guide](../../../docs/acceptance-ci.md).

The catalog describes what a person can rely on. Code and exploration reveal
observed behavior; neither grants human approval or proves that behavior is
desirable. Keep unresolved decisions in `questions`, mark proposals honestly,
and never create an approval record on the user's behalf.

## Working on a feature

Find the module and the stories whose promises the change affects. Reuse shared
contracts for cross-cutting permissions, cancellation, recovery and persistence.
Describe roles, entry points, state transitions, error feedback and platform
constraints in user terms. Update expectations when the authorized behavior
changes; do not rewrite them merely to make a failed test pass.

Bind executable tests with the acceptance annotation described in the contract.
Discovery produces the manifest; do not maintain a second test-binding list.
Preserve the evidence boundary: replacing application handlers is a UI check,
while replacing only the model endpoint can retain real application E2E behavior.
A screenshot alone does not prove persistence, permissions or absence of side
effects. Verify those outcomes through the actual application flow too.

Use the narrowest useful profile and record its limits:

```bash
node scripts/acceptance/cli.mjs validate
node scripts/acceptance/cli.mjs build
node scripts/acceptance/cli.mjs discover --output tests/acceptance/output/manifest.json
node scripts/acceptance/cli.mjs plan --profile fast --module teams --manifest tests/acceptance/output/manifest.json --output tests/acceptance/output/plan.json
node scripts/acceptance/cli.mjs run --plan tests/acceptance/output/plan.json --output tests/acceptance/output/run
node scripts/acceptance/cli.mjs report --run tests/acceptance/output/run --output tests/acceptance/output/report
```

Choose module ids from the current catalog. For a change range, use full commit
SHAs with `plan --base <sha> --head <sha>`. Unknown mappings and shared changes
expand selection. AI reasoning may add cases; it must not silently remove the
mandatory selection or claim an unexecuted case passed.

## Execution and interpretation

Run `doctor --level catalog --json` for catalog-only work, or
`doctor --level e2e --json` before Electron execution. Isolate all application
profiles and test files. Never borrow a person's production chats, credentials,
IM recipients or working folders as fixtures.

Use `build` to produce a verified application before running a plan. The harness
checks the source inputs, compiled outputs and engine distribution; an old build
under `out` is not proof about the current source. Test-only edits do not require
rebuilding product code, but they do require fresh discovery and planning.
Build provenance without the current clean-output guarantee must be rebuilt.
If a build lock survives an interruption, confirm its recorded process and child
build processes have stopped before removing that stale lock; never clear a lock
to start a competing build.

Scripted models are the default for deterministic orchestration. Live model or
external-service work requires an explicit authorized scope and budget, plus
`plan --allow-live` or `plan --allow-external` respectively; model wording should be assessed by intended outcome rather
than an exact sentence. Missing credentials, unavailable GUI sessions, missing
engines and human-only steps remain blocked/manual evidence, never passing skips.

Report the fixed source revision, selected modules and variants, actual evidence,
failed/incomplete/flaky cases, and unresolved product questions. Treat a test that
passes only after retry as flaky. Fix the cause or retain the uncertainty; do not
increase retries to erase it. Build failures and an empty test result are failures
of validation, not proof that no regression exists.
Check `evidenceIntegrity` as well as case outcomes. Missing or failed integrity
means raw attempts are diagnostic only, even when they say `passed`. Preserve
that run and produce a new one after resolving source/build changes or runner
errors; never backfill an integrity flag into old evidence.

For packaged behavior, create a controlled `package` and run the applicable tests
with its executable. Package provenance binds the output and SDK bytes and records
the emitted bundle; it does not replace actual packaged-app execution or prove
that every dependency, installer flow or signing step works.

For a failed user journey, preserve its trace and application logs, determine
whether the failure is product behavior, the test, or the environment, and add a
deterministic regression where feasible. Existing authorization controls whether
to change product behavior. Preserve the original evidence when rerunning.

## Automation boundary

Use the shipped CI template and helpers instead of inventing a separate nightly
runner. GitHub mutations require the repository's `gh-publish` skill and existing
human authorization. Runner registration and dispatch helpers preview by default;
`--execute` is an external action. Never replace a pre-existing runner, store
tokens in source files, or claim that a successful dispatch is a passed run.
