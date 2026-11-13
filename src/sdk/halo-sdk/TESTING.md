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
npm run build
SDK_TEST_API_KEY= SDK_TEST_API_URL= SDK_TEST_MODEL= npm test
```

`npm run build` and npm's `prepack` rebuild `dist/`; coordinate shared outputs with
other work. Test against a fixed source revision or recorded dirty snapshot.
Do not reuse an old build after changing its inputs.
Source tests that enter the native facade require a current `dist/native` build.
The source loader compares the native source fingerprint with that build's
manifest and refuses a stale library; rebuild after changing native inputs.
Default-runtime behavioral tests should import the package's public entry. Tests
that import the TypeScript loop or session modules directly do not exercise the Rust
runtime, so a full source-suite pass does not by itself establish its coverage.
Checkpoint write failures and cancellation ordering are checked against the Rust
journal. These tests run a real session with a per-journal checkpoint gate and
filesystem failure; they cover failed writes, cancellation during a committed
write, and cancellation before checkpoint submission:

```sh
cargo +1.90.0 test --manifest-path native/Cargo.toml -p halo-core core::engine::persistence_tests
```

Bounded transcript reading and strict resume are checked in `history::tests` with
real JSONL files and session initialization, covering checkpoint limits, tail
recovery, pagination, damaged records and strict refusal:

```sh
cargo +1.90.0 test --manifest-path native/Cargo.toml -p halo-core history::tests:: -- --test-threads=1
```

The package build and resource validator use `scripts/build.mjs`, including the
generated Harness text, Worker bundle and native library. `dev` remains the
TypeScript watch command; build the native inputs explicitly after Rust changes.

History compatibility with the previous TypeScript-based SDK uses two independently
built SDKs. Point `SDK_REFERENCE_TEST_ROOT` at that SDK's `dist` directory and run
`validation/compatibility/history.test.mjs` with Node's test runner and
`SDK_BEHAVIOR_TEST_ROOT` set to the candidate's `dist`. It creates isolated
ordinary and discovery histories in the previous SDK, continues each in the
candidate, then reopens each in the previous SDK. Every turn checks the retained
calls and results and an actual append-only file effect, so replay or lost
discovery access fails the check.
This checks orderly shutdown and resume, not crash recovery or every older
transcript version.

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

Changes to native process retirement or standalone collaborator disposal also
require the compiled process fixture after a fresh build:

```sh
SDK_BEHAVIOR_TEST_ROOT="$PWD/dist" node --test validation/native-collaboration-retirement.test.mjs
```

It uses isolated MCP processes that ignore SIGTERM, checks that the existing
grace period survives logical disposal without a JavaScript keepalive, and checks
that terminating their Node environment reclaims already-retired processes.
These are POSIX signal/process-group scenarios; Windows skips are not evidence
for Windows process-tree cleanup. The Worker runtime's process tests remain
required separately. Differential reports must distinguish the preserved grace
behavior from environment-exit guarantees absent in an older implementation.

## Harness, cache and performance

Use scripted providers or a local protocol-valid model endpoint with the real
loop, tools, history and callbacks. Assert requests, tool effects, checkpoints,
latest-input delivery and terminal state, not a canned final answer. Existing
examples include `core/query-loop-compaction.test.ts`,
`core/query-loop-provider-streaming.test.ts`, `core/session.test.ts` and
`collaboration/runtime.test.ts`; extend the affected fixture.

Source collaboration continuations require both Rust-owner and compiled-SDK
checks. `collaboration/sdk/tool-context.test.ts` covers the three member discovery
and result-budget cases. Source-loop release and retained history are checked in
[`native/crates/halo-core/src/core/engine/collaboration_tests.rs`](native/crates/halo-core/src/core/engine/collaboration_tests.rs),
where a per-session test observer releases the child only after the actual source
loop has concluded. The public counterpart is
[`validation/native-collaboration-continuation.test.mjs`](validation/native-collaboration-continuation.test.mjs).
Both exercise ordinary sessions and one-shot queries.

For changes to these continuation paths, the following commands are mandatory
after a fresh SDK build; `npm test` alone does not run this coverage. Use the
toolchain pinned in `native/rust-toolchain.toml`:

```sh
cargo +1.90.0 test --manifest-path native/Cargo.toml -p halo-core core::engine::collaboration_tests
SDK_BEHAVIOR_TEST_ROOT="$PWD/dist" node --test validation/native-collaboration-continuation.test.mjs
```

| Preserved expectation | Rust owner check | Compiled public check |
|---|---|---|
| Discovered definitions and `CallTool` remain usable; one final result accounts for all five source turns | `source_continuation_preserves_discovered_definitions_and_directory_prefix` | Deferred service cases |
| The original service directory and message prefix remain in order | Same Rust check | Deferred service cases |
| An empty baseline stays attached to the original user message, without an extra empty message | `source_continuation_preserves_an_empty_baseline_on_the_original_user_message` | Eager service cases |
| Removing another service appends the updated directory without revoking unchanged discoveries | `source_continuation_keeps_directory_changes_without_revoking_discoveries` | Directory-change cases |

The public fixture observes tool calls, complete definitions, ordered requests
and final turn accounting. Its Stop hook is not evidence that a source loop has
exited; that boundary and the private baseline metadata are asserted by the
Rust-owner checks.

Durable clearing also spans two boundaries. `core/tool-context-clear.test.ts`
uses an actual failing transcript path to check refusal and subsequent recovery.
The pending-write invariant is exercised with the Rust journal's per-instance,
test-only checkpoint gate: neither the live definitions nor the stored history
may change before its checkpoint completes. Run this check when changing clear
or checkpoint installation; a JavaScript writer spy cannot intercept Rust I/O:

```sh
cargo +1.90.0 test --manifest-path native/Cargo.toml -p halo-core clear_installs_neither_live_nor_durable_state_until_checkpoint_finishes
```

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

The full build removes executable output outside the declared runtime dependency
closure and writes `dist/runtime-manifest.json` with retained entries, declarations,
assets and removed file hashes. `node scripts/prune-runtime.mjs --check` audits the
closure without changing it; a completed build must have no removable runtime
files. Unknown dynamic imports or requirements fail before files are deleted.
Source tests import source modules, never the pruned `dist` JavaScript.

Report source/build identity, commands, selected scenarios, real assertions,
failures and unverified coverage. Distinguish deterministic simulation, local
performance and real-model/cost evidence. A smoke subset is not the full journey;
a retry-only pass remains flaky. Preserve failures instead of weakening checks.
