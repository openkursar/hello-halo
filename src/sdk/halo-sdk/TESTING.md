# SDK verification

Run commands from `src/sdk/halo-sdk/`, not the Halo repository root. Reuse the
existing runners below; extend them for missing behavior rather than creating a
parallel validation system. Tests must use isolated files, state and processes.

## Required checks

- **Documentation only:** verify links, commands, scope and `git diff --check`.
  Do not rebuild the runtime just to validate prose.
- **SDK code:** typecheck, affected tests, full offline Vitest suite and build.
  Add deterministic regressions for changed behavior, including failure/recovery.
- **Harness, sessions or lifecycle:** also run the applicable compiled-SDK
  behavioral, resource and Worker checks below. A fixture that still targets a
  removed interface must be migrated, not skipped to obtain a pass.
- **Cache, performance or package changes:** add the corresponding checks below.
  Before release, verify the actual package and standalone imports.
- **Host integration:** also follow repository
  `.agents/skills/acceptance-testing/SKILL.md` and the affected catalog stories.
  SDK tests do not establish the desktop journey, and UI checks do not establish
  SDK correctness.

The root `precommit:gate` does not currently invoke these SDK suites. Run them
explicitly; its success cannot fill that gap. Failed required checks block commit;
missing prerequisites remain unverified and need an explicit disposition.

## Existing runners

Live Vitest cases activate when provider settings are present. For offline runs,
clear `SDK_TEST_API_KEY`, `SDK_TEST_API_URL` and `SDK_TEST_MODEL` in the command's
environment, for example:

```sh
npm run typecheck
SDK_TEST_API_KEY= SDK_TEST_API_URL= SDK_TEST_MODEL= npm test
npm run build
```

`npm run build` and npm's `prepack` rebuild `dist/`; coordinate shared outputs with
other work. Test against a fixed source revision or recorded dirty snapshot.
Do not reuse an old build after changing its inputs.

| Evidence | Existing entry |
|---|---|
| Focused source regressions | `npm test -- <test-path>` with the offline environment above |
| Validation-runner tests | `npm run test:resource-harness`; compiled behavior cases require `SDK_BEHAVIOR_TEST_ROOT` |
| Compiled fixed-task simulation | After build: `SDK_BEHAVIOR_TEST_ROOT="$PWD/dist" node --test validation/behavior.test.mjs`; [scenario contract](validation/BEHAVIOR.md) |
| Isolated lifecycle, resource and recovery | `npm run test:resources`; builds a temporary source snapshot, not checkout `dist/`; [runner](validation/README.md) |
| Worker and bundled dependencies | `npm test -- worker scripts/build-worker.test.ts` with offline environment; [Worker evidence and limits](worker/VALIDATION.md) |
| Local execution overhead | After build: `npm run benchmark:workers -- --sessions=10`; cold/warm, CPU, RSS and event-loop measurements, not a task score |
| Streaming and tool overlap | After build: `node validation/streaming.mjs`; [assertions and timing limits](validation/STREAMING.md) |

Runner existence and historical reports are not current passing evidence.

## Harness, cache and performance

Use scripted providers or a local protocol-valid model endpoint with the real
loop, tools, history and callbacks. Assert requests, tool effects, checkpoints,
latest-input delivery and terminal state, not a canned final answer. Existing
examples include `core/query-loop-compaction.test.ts`,
`core/query-loop-provider-streaming.test.ts`, `core/session.test.ts` and
`collaboration/runtime.test.ts`; extend the affected fixture.

For cache or usage changes, inspect requests and accounting with
`llm/anthropic.test.ts`, `llm/openai-compat.test.ts`,
`llm/provider-retry.test.ts`, `core/token-budget.test.ts` and `core/cost.test.ts`.
Check stable instructions/tools, cache markers, intended invalidation, and usage
from every returned work/summary/retry response exactly once. Synthetic usage
verifies arithmetic, not actual cache hits, charges or model quality.

Measure performance with a fixed workload and baseline/candidate builds under
comparable load. Report correctness alongside cold/warm latency, CPU, memory,
concurrency and cleanup; include repeated samples and environment. Timing samples
are not release thresholds. [Published benchmark methodology](docs/benchmarks/runtime.md)
is a separate experiment with its own prerequisites, not a universal test gate.

## Real-model evaluation

Most SDK engineering behavior is reproducible offline. Prompt, context or
Harness changes that can alter model decisions also need a targeted real-model
baseline/candidate comparison before release. Keep the model, tasks, budgets and
settings comparable; assess actual artifacts and completion, not exact wording.
Use [validation/BEHAVIOR.md](validation/BEHAVIOR.md) for the existing fixed tasks.
Its CLI calls the configured endpoint; it is not an offline-only command.

Real provider cache hits and fee claims require provider usage and applicable
pricing or billing evidence; request stability alone cannot prove savings.
Live calls need explicit authorization, scope and spending limits. The scripts
`test:resources:live` and `test:resources:soak` both use real services. Never infer
authorization from available credentials or report a skipped live run as passed.

## Package and report

After a fresh build, inspect `npm pack --dry-run --ignore-scripts --json`. Verify
an actual tarball in an isolated installation: public imports and declarations,
Worker startup/execution/close, complete third-party notices, and no host-source
dependency, private notes, credentials, tests or retired modules in the package.
These checks are not yet one dedicated SDK package gate. Packing never authorizes
publishing. SDK schema/type compatibility alone does not prove standalone use.

Report source/build identity, commands, selected scenarios, real assertions,
failures and unverified coverage. Distinguish deterministic simulation, local
performance and real-model/cost evidence. A smoke subset is not the full journey;
a retry-only pass remains flaky. Preserve failures instead of weakening checks.
