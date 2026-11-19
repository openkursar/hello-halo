# External runtime management

## Boundary and public contracts

`index.ts` is the application service surface. Every operation takes the closed
`RuntimeId` first; launch descriptors include optional child-only `pathDirs`.
`provider.ts` declares the internal vendor adapter contract. `compatibility.ts`
is the explicitly limited surface used by the legacy `cc-runtime` direct-module
facades. Those facades contain no independent state machine.

The service never imports agent code. Controllers own global engine activation;
providers own vendor paths, version policy, protocol messages, release metadata and
materialization. The shared implementation owns catalog persistence, discovery
budgets, process lifecycle, scheduling, transfer, installation and selection races.

## Lifecycle and performance

The registry lazily creates one instance per runtime. Merely importing it starts
no scan, subprocess, request, watcher or timer. Status reads bounded catalogs and
already known checks; it neither hashes files nor probes executables. Each runtime
has separate catalog, release/probe caches, progress, cancellation and path intent.
All instances share one process probe scheduler: three active checks and 24 queued.
A check reserves one slot across version and protocol stages. Each process has a
20-second deadline, 1-MiB output limit, isolated temporary directories, and bounded
termination followed by directory cleanup. Explicit discovery has a 12-second
overall deadline and returns only completed checks when cancelled.

Managed launch resolution checks only the selected installation. A cold or changed
candidate stamp triggers streaming integrity verification and protocol checking;
unchanged stamps reuse a bounded 24-entry integrity cache. The whole launch check
has an eight-second deadline that aborts actual process and hash work. Managed
component stamps must cover all files necessary for the launch. A status label is
not evidence that current files remain healthy.

## Persistence and installation

Claude Code retains `agent.ccRuntime` and `runtimes/claude-code`; Codex uses
`agent.codexRuntime` and `runtimes/codex`. Catalogs remain version 1, bounded to
64 entries and 128 KiB, with atomic writes and bounded readback verification.
Legacy CC checksum/prefix entries are understood without moving user files.
Codex records retain artifact SRI separately from installed component SHA256/size
manifests. Reuse validates every recorded component, containment and executable
membership before checking its protocol. Same-source exact versions can be reused
without network metadata. Source changes and tags resolve bounded metadata first.

Downloads stream into exclusive private staging and verify SHA256 (legacy CC) or
strong SRI before provider materialization. Providers do not install via shell or
npm scripts. Successful materialization is probed before immutable atomic
publication. Catalog persistence precedes selection; failed/cancelled installation
preserves the existing selection. Existing version directories are never replaced
or deleted, including when repair publishes a fresh content-addressed copy.

The service captures each select/install path revision synchronously before its
first asynchronous preparation. A newer same-runtime operation prevents an older
completion from replacing its path, while the successful installation can remain
in the catalog. The controller separately captures global engine intent before
calling the service, so different runtimes cannot race to activate by finish order.
Preferences carried on an install request are saved inside that captured intent.
Closing a UI panel does not cancel a main-owned installation.

Shutdown cancels installations, pending metadata and active/queued probes. Errors
and terminal outcomes are logged without source URLs, credentials or raw process
output. No steady-state polling or heartbeat is introduced by this service.
