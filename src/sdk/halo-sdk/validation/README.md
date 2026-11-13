# Resource and lifecycle validation

This suite exercises the compiled public SDK in a separate Node process, using
real files, shell processes, persistence and HTTP streams. The supervisor records
resource measurements and enforces an external deadline, even if the SDK stops
responding. It copies the current SDK into a temporary build directory first;
it does not clean or rebuild another developer's `dist/`. Actors also run from
the copied harness. Installed dependencies are reused read-only; CI starts from
`npm ci` and the lockfile.

The isolated build uses the same `scripts/build.mjs` entry as `npm run build`:
Harness generation, TypeScript declarations, the Worker bundle and notices, and
the current platform Rust library. It requires the Rust toolchain and reuses the
source checkout's ignored Cargo target cache, or `CARGO_TARGET_DIR` when supplied.
The build has its own ten-minute deadline; scenario deadlines and resource gates
start after it finishes. An interrupted build stops its owned compiler process
group. Build failure never starts a validation actor.

## Run

From the SDK repository, after `npm ci`:

```sh
npm run test:resources
npm run test:resources:live
npm run test:resources:soak
```

The first command uses a local HTTP/SSE peer with scripted tool decisions. It
tests the wire protocol, actual SDK loop, tools and lifecycle deterministically;
it is **not evidence of live-model behavior**. It also injects a stalled stream
and a truncated stream, checking cancellation and refusal of incomplete answers.

The live commands require `SDK_TEST_API_KEY` in the launching environment;
`DEEPSEEK_API_KEY` is also accepted for the default DeepSeek endpoint only.
Missing credentials fail the command. Nothing loads credentials
from a repository file. For an interactive terminal, `--key-stdin` accepts one
line from stdin; disable terminal echo before entering a credential. Keys are
passed to the actor through IPC, stripped from child-process environments and
redacted from saved errors. Never put a key in an argument or a committed file.

The default live provider is DeepSeek's Anthropic-compatible endpoint with
`deepseek-flash`, native tool calls and thinking disabled. The model name can be
overridden with `--model`. Use `--provider-type openai-compat` with an explicit
`--base-url` and `--model` for a Chat Completions endpoint. `--thinking adaptive`
allows reasoning responses, while `--thinking disabled` requires their absence.
Live runs fail immediately if thinking content appears
after an explicit disabled setting. Provider failures, skipped work, missing terminal
results and wrong file contents fail the run.

```sh
# Thirty minutes, at least 30 rounds, four concurrent conversations.
npm run test:resources:soak

# A longer manually launched run; this incurs real model usage.
npm run test:resources:soak -- --duration-seconds 14400 --rounds 100 --concurrency 8

# Require actual model compaction under a deliberately small context budget.
npm run test:resources:live -- --rounds 6 --context-window 8000 --require-compaction

# GLM Coding endpoint with reasoning enabled and a larger output budget.
npm run test:resources:live -- --provider-type openai-compat \
  --base-url https://open.bigmodel.cn/api/coding/paas/v4 \
  --model glm-5.3-flash --thinking adaptive --effort low --max-output-tokens 8192

# Eight-hour residence and burst validation; separate from continuous saturation.
npm run test:resources:soak -- --background --duration-seconds 28800 --round-interval-seconds 30 --keep-sandbox

# Preserve the temporary build and fixture directory when investigating a failure.
npm run test:resources -- --keep-sandbox
```

`--rounds` and `--duration-seconds` are both minimums. Every round completes before
the runner stops. CLI ranges cap the requested duration at twenty-four hours, concurrency at sixteen,
minimum rounds at one thousand and cancellation cycles at fifty. `--round-interval-seconds` optionally sets a minimum start-to-start batch interval.
A paced soak must be reported as a paced workload, not continuous saturation. Each SDK turn is limited
to twelve model steps and, by default, 2,048 output tokens per step.
`--max-output-tokens` sets a recorded budget between 256 and 32,768 tokens for
models that share the budget between reasoning and their visible response.
`--effort` explicitly enables the compatible provider's
reasoning-effort parameter for both ordinary calls and summaries; use it only with
an endpoint that supports that parameter. The external scenario
deadline is the requested duration plus ten minutes; an impossible minimum-round
target fails at that deadline. Run the
suite in a disposable development or CI environment: temporary directories keep
test data separate, but Bash is an execution capability, not a security sandbox.

Use `--background` for long local runs on macOS/Linux. The launcher exits after
starting a separate process group, with output redirected to `console.log`.
On macOS, that group also owns a `caffeinate` process for the duration of the test.
Credentials travel through a one-time stdin pipe and are removed from the child's
environment. They are not placed in arguments or job metadata.

`background.json` records the process-group owner and its start identity;
`run-state.json` records the supervisor, current actor and latest state.
Verify the recorded identity before stopping that process group. Launch success
is not test success: require an exited state with code zero and a passing final
report. Background launch refuses an output directory that already has a console
log, so an existing run is not overwritten or duplicated.

## Assertions

Each concurrent conversation reads a fresh random seed from disk every round and
writes independently checked output. That workload exposes only Read and Write,
so a shell command cannot bypass the file tools under test. Every fifth round closes and reopens the conversation, then
recalls its seed without tools. A wrong seed detects cross-conversation mixing. Successful per-round output
fixtures are deleted after verification so the sampler does not scan a growing
fixture directory; SDK transcripts and captures remain measured.
The harness observes a real command's readiness file and verifies its process
ancestry before interruption or
session close, requires its PID to disappear, and verifies a subsequent turn.

An interrupt must yield a terminal result and matching results for interrupted
tool calls; an explicit session close may end the stream without a terminal result.

Additional end-to-end cases delegate a file write to a real collaborator, reject a
1 GiB sparse file through Read, and run a 32 MiB background output producer
through Bash and TaskOutput. Output files must remain at most 8 MiB and contain
the truncation notice. A separate actor is killed with SIGKILL after flushing a
completed turn; another actor must restore that turn from the same disk state.
The crash case does not kill a process while it owns a detached shell child.
`--require-compaction` makes the workload fail unless at least one real summary
boundary occurs, and rejects any summary that exhausted its output budget.
The small-window profile deliberately increases compaction pressure; its latency
is not a production throughput benchmark. Cached and uncached input both count
against the context window.

Focused regressions cover 64 MiB foreground/background producers, replacement
amplification, ENOSPC, a throwing completion callback, global output retention,
bounded transcript recovery/pagination, twenty retained previews of an 8 MiB file,
collaborator transcript continuity, a paused
consumer and propagation of compaction into the next user turn.

## Evidence and gates

`validation/results/<UTC timestamp>/report.md` is the human-readable result;
`report.json` records settings, actual Node/OS,
the Git base and dirty paths, a hash of the copied source, completed checks, token
usage, tool calls, errors, resource samples and exit status. SDK-reported usage
is not a provider invoice: separate summary calls and interrupted attempts may
not be included in the SDK result counters. The current round and measurements are also checkpointed to `progress.json`.
Logs are bounded to 1 MiB per scenario. Reports and fixtures contain synthetic task data. Results are
ignored by Git; retain the report as a CI artifact or copy it into release evidence.
The report also retains the native build manifest and each actor's observed build
identity. Actors verify that public session creation returns the native session
for that build; merely loading a native library does not establish execution.

Raw actor and OS samples, source identity and lifecycle events are also appended
to `events.jsonl` while the run executes. The journal has a 64 MiB ceiling; exceeding
it fails the run. Scenario logs are written incrementally, with credentials
redacted across chunk boundaries. These records survive a supervisor termination,
but partial evidence never substitutes for a final passing report. An actor that
loses its supervisor closes its sessions and exits, preventing an orphaned test
from continuing to call a provider.

The actor samples RSS, heap, external/ArrayBuffer memory and event-loop delay.
The supervisor independently samples the process tree, descriptors and output
disk size. Overlapping periodic samples are coalesced; labeled samples still wait for a fresh
measurement. Both periodic samples (two seconds) and synchronized round boundaries
are collected. Baseline/final/round labels include explicit GC so retained heap
can be compared separately from RSS. Deliberately oversized input fixtures are
excluded from the output-disk budget. This is instrumented validation; explicit
GC affects performance and is not a production recommendation.
JavaScript heap and preview-retention measurements describe JavaScript objects;
they do not measure the Rust allocator. Actor/process-tree RSS and independent
descriptor/process observations cover the native execution as well. These
measurements retain their existing gates and are reported separately.

| Gate | Initial acceptance limit |
|---|---:|
| Sampled actor/process-tree RSS peak | 768 MiB |
| Final retained heap minus warm baseline | 48 MiB |
| Final descriptors minus warm baseline | 12 |
| Observed event-loop delay maximum | 2 seconds |
| Output sandbox size | 512 MiB |
| Surviving observed/registered child PIDs after exit | 0 |

These are regression gates for this fixture workload, not advertised capacity
limits for arbitrary applications. A sampled peak can miss a short spike. A
successful 30-minute run does not prove an eight-hour plateau or all workloads.
Read the raw curves before making a capacity claim, and change a threshold only
with a documented workload or platform reason.

Descriptor/process-tree sampling supports macOS and Linux. A soak run with missing
descriptor measurements fails. Windows resource acceptance needs an OS-specific
sampler; a functional test on Windows cannot substitute for that measurement.

The GitHub workflow runs deterministic regressions on Linux/macOS and Node 20/22.
Live validation runs only through manual workflow dispatch with `live=true`,
the matching `glm` or `deepseek` provider selection and a repository
`SDK_TEST_API_KEY` secret. No secret is supplied to pull-request
jobs. The workflow being present does not mean its matrix has already passed.

## Resource contract

| Resource | Behavior |
|---|---|
| Text Read/Edit/Write | 8 MiB input/output ceiling; oversize fails before whole-file allocation or mutation. Edit checks replacement amplification. Larger data needs streaming application commands. |
| Images | Existing 5 MiB decoded-data ceiling, enforced by a bounded read including growth during the operation. |
| Foreground Bash capture | 64 Ki characters per stream, retaining head and tail and an explicit omission notice; the process continues draining. |
| Background Bash capture | 8 MiB per file including its truncation notice; bounded pipe buffers and backpressure prevent an in-memory write queue. |
| Retained Bash output | New persistent outputs share `<configDir>/bash-output`. Completed files keep at most 256 MiB, 128 files and seven days, trimmed when commands start/finish. Active files are excluded; budget convergence is after a sweep, not a cross-process instantaneous reservation. |
| Active tasks | At most 32 background commands per session identity. Local collaboration defaults to 10 simultaneous member turns and 128 new members per source request, shared across nested delegation. Hosts configure these limits and bound the number of source sessions. |
| Thinking control | Explicit modes take precedence over effort and are sent to the provider. When no mode is supplied, effort may select it. Summaries inherit the session mode; models that require thinking need a compatible mode such as adaptive. |
| Context compaction | Cache-read and cache-creation tokens count toward the window. Summary requests honor cancellation and the session output budget; compaction replaces retained parent history. |
| Collaborator history | Ordinary session transcripts and backpressured tool execution; detailed messages stay out of source model history. Reports and turn-end notices carry results. Idle execution objects are bounded independently of retained identity and working state. |
| Resumed history | Reads at most the last 64 MiB by default, retains at most 4,096 messages and a conservative 64 MiB text budget; omitted history is disclosed to the model. Explicit `resumeSessionAt` scans from the start with the same memory limits. |
| History inspection | Streaming `limit`/`offset`; at most 4,096 records, 64 MiB per page and 32 MiB per record. Requests that exceed a page budget fail explicitly; request a smaller page. |
| History fork | Copies bounded records incrementally; an incomplete fork is removed on failure. |

The history record limit accommodates the existing provider budget for multiple
images in one message; it is larger than the file-tool limit.

Conversation and collaborator transcripts are durable user data and grow on disk.
The embedding application owns their archival, deletion and total disk quota.
The output retention policy applies to new SDK-managed capture, not arbitrary
files written by a command or historical output locations. Separate config roots
have separate budgets. Reused live PIDs can delay orphan-output reclamation.

A complete host process killed by SIGKILL cannot run JavaScript cleanup. A service
deployment that requires guaranteed descendant cleanup after host death needs an
OS process supervisor/container/job object. Worker-thread failure supervision is
tested by the worker suite; it is a different boundary from killing the host.

## Release use

Require the focused/full regressions and a deterministic wire run first. Then
retain a live smoke and a soak report for the exact release source, together with
the workload/OS/Node version used. Run longer profiles and the OS matrix before
increasing the supported deployment envelope. A missing, aborted, skipped or
unsupported measurement is unfinished evidence, never a production pass.
