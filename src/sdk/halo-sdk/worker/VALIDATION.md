# Worker runtime validation

## Host-owned thread budget

The current runtime imposes no worker-count ceiling when `maxWorkers` is omitted
or `Infinity`. A host-supplied positive integer remains a hard bound. Prewarming
still defaults to one worker; removing the ceiling does not eagerly start more
threads.

Verified on 2026-10-24:

- SDK TypeScript and bundled worker build passed.
- Mac worker regressions: 3 files, 49 tests passed, including expansion beyond four
  workers, explicit budgets, warm-worker retention and shutdown.
- Halo adapter: 4 tests passed; changed-file host typecheck passed.
- Real single-core Windows VM, Node 22.16.0 x64: default and explicit `Infinity`
  policies each ran six sessions on six workers with placement target one. An
  explicit budget of two ran the same six sessions on two workers. Each case
  prewarmed only one worker, reclaimed excess empty workers and closed fully.

These checks validate policy ownership and lifecycle, not unlimited machine
capacity or hundreds of active agents. The earlier full-suite, packaging and
performance evidence below used the previous finite default; its timing and
memory samples do not validate the current uncapped default.

## Isolation baseline before the thread-budget policy change

Validated locally on 2026-10-24, macOS arm64 (Apple M4 Pro, Node v22.23.3)
and Windows 11 Pro (build 26200.8875, Node v22.16.0 x64). Windows ran in
Parallels with one logical CPU and 7.99 GiB RAM, using x64 emulation on ARM64.
Real Electron 43.7.7 and asar fixtures were exercised on both platforms.

## Checks completed

| Check | Result |
|---|---|
| SDK TypeScript + bundled worker build | Passed |
| SDK offline suite, Mac | 89 files, 1876 tests passed; 26 live-provider tests skipped |
| Worker lifecycle, Mac and Windows | 42 tests passed on each platform |
| Windows worker, MCP, Bash and file regressions | 17 files, 250 passed; 1 POSIX signal test skipped |
| Halo Agent, architecture and health suites | 1107 passed, 21 environment-gated tests skipped |
| Final Halo adapter, package and space cleanup regression | 4 files, 12 passed |
| Changed-file Halo typecheck | Passed |
| Halo application build | Passed |
| Real Electron, asar package, Mac and Windows | Passed: worker startup, host identity module, model request, graceful close, deadlock detection, main-loop responsiveness |
| npm package contents | Worker API, declarations, bundled execution entry and callback bridge present |
| Windows binary dependency preflight | Passed; this does not execute Windows code |

SDK regressions use real workers, independent build directories and local fixture
providers. They cover shared startup, grouping and thread bounds, idle expiry,
input acknowledgement/consumption/withdrawal, additions during and after a turn,
account and context separation, host permissions/hooks/MCP, per-session interrupt,
collaborators in the parent worker, configuration changes during retirement,
persistence and resume, file coordination, stream bounds/backpressure, child
process cleanup, fatal exits, deadlocks and the restart circuit. No paid or live
provider API is required.

Windows was tested from an isolated source snapshot, with isolated npm settings
and a local Portable Git installation. No installed Halo profile was used. The
Windows source snapshot SHA-256 was
`efdbc8e2424cf9a95b106f78a97624120c55f4ec5967ae68033399f2fdde50f7`.
The test command used one Vitest worker to match the VM's one logical CPU:

```sh
npm test -- worker tools/mcp tools/bash tools/file-access.test.ts utils/windows-process-tree.test.ts --maxWorkers=1 --minWorkers=1
```

Native Windows checks cover handle/path device-ID differences in file snapshots,
Git Bash directory restoration and MSYS children whose native parent chain
changes during exec. The run produced no process ancestry fallback or
incomplete-termination warnings. Generated reports belong in the ignored
`validation/results/` directory. These local results do not establish that the
CI matrix or the host application's complete dependency checks have passed.

## Synthetic timing samples

Command, from the SDK repository after building:

```sh
node scripts/benchmark-workers.mjs --sessions=10
```

Ten sessions, three turns each, 131072 synthetic input characters per turn, local
mock model. Each execution mode runs in a fresh process. This is one measured
sample per platform, not a release acceptance threshold or a model-latency claim.
Cold readiness includes importing the SDK entry and initializing its runtime.

### macOS arm64

| Measurement | Direct execution | Grouped workers |
|---|---:|---:|
| Cold readiness | 59.4 ms | 35.9 ms |
| Concurrent session creation, median | 66.5 ms | 50.5 ms |
| Resume | 28.1 ms | 24.1 ms |
| First request arrival, median | 39.1 ms | 28.8 ms |
| Main event-loop p99 | 36.0 ms | 12.2 ms |
| Sampled process peak RSS | 138.4 MiB | 176.5 MiB |
| Total process CPU | 272.3 ms | 384.4 ms |
| Worker count | 0 | 2 |

### Windows VM, Node x64 on ARM64, one logical CPU

| Measurement | Direct execution | Grouped workers |
|---|---:|---:|
| Cold readiness | 272.5 ms | 169.2 ms |
| Concurrent session creation, median | 151.7 ms | 188.7 ms |
| Resume | 143.3 ms | 135.7 ms |
| First request arrival, median | 208.4 ms | 195.4 ms |
| Main event-loop p99 | 302.8 ms | 34.1 ms |
| Sampled process peak RSS | 124.2 MiB | 148.6 MiB |
| Total process CPU | 922.0 ms | 921.0 ms |
| Worker count | 0 | 1 |

The sample shows the responsiveness/resource tradeoff between the SDK's in-process
and worker execution. Pool size and capacity remain configurable; these numbers do not validate
the defaults on low-end Windows hardware.

## Remaining platform acceptance

Repeat the benchmark on native x64 ordinary and low-end Windows hardware. The
constrained VM validates Windows execution but does not establish native hardware
latency, antivirus effects or long-running resource behavior. Signed installers,
the complete desktop application UI and live external model/MCP services were not
certified by these isolated offline checks. The asar test exercises the actual
SDK bundle and host identity module inside Electron, not a full installer.

Thread isolation covers SDK JavaScript execution and recoverable thread failure.
Host callbacks still execute in the host. Native crashes and process-wide memory
exhaustion are outside this boundary. In an observed abrupt POSIX thread exit,
the supervised MCP process and descendants were terminated, but Node retained
one dead child's zombie wait status until host exit; normal disposal awaits child
closure. See DESIGN.md for this platform limitation.
