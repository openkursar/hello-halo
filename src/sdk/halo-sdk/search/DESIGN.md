# Optional code search

The SDK keeps its exact Grep tool. CodeSearch adds ranked source candidates for
questions whose location or spelling is unknown. It is enabled only by an
explicit host configuration and does not alter the default tool set.

## Boundary

`search/index.ts` exports a dedicated service and its configuration/result types.
`tools/code-search` translates model requests into calls to that surface. The
host provides a Node 22 executable and the installed public entry point of
`@zvec/zvec-grep` (validated against 0.2.2). No zg dependency is imported by the
SDK process, so the SDK's ordinary Node 20 operation is unchanged.

A lightweight supervisor forwards IPC to a separate backend child that imports
zg's public `createZvecGrep` API. The supervisor never loads native search or model
code, so a blocked backend cannot prevent parent-death cleanup. It uses the local
Potion code model on CPU, never remote embeddings. Only essential operating
system environment variables reach the child. Electron hosts can explicitly
request `ELECTRON_RUN_AS_NODE`; provider credentials are not forwarded.

## Scope and storage

Before starting a child, resolve the workspace and read-deny roots to real paths.
A deny root that covers the workspace or lies inside it makes this backend
unavailable: the adapter cannot promise equivalent index-time enforcement of
arbitrary deny rules. Unrelated deny roots do not prevent search. Callers can
still use Grep. The source scanner explicitly disables symlink following.
Returned source paths are checked again for workspace containment and denials
before any snippets are returned. The host cancels in-flight requests when it
changes their permissions; a new restricted request never consults the old index.

The host supplies a cache directory that does not overlap the source workspace
in either direction. A dedicated
index directory is derived from the canonical source root and model identity;
it uses zg's `rootPaths` facility, not a pre-existing user-managed index. Model
files are shared under the host cache. Persistent indexes survive `dispose()`;
the host owns this directory and removes it when the optional backend is
uninstalled or the corresponding workspace is permanently discarded. The SDK
does not scan the cache catalog at startup. Creating the service does no filesystem
work and starts no process. The first search builds or incrementally updates the
index. `refresh: true` updates it again; other searches reuse it and report
`possibly_stale`. There is no watcher or unsolicited background scan.

## Ownership and bounds

Services in one SDK process share a worker for the same configuration and root.
There is at most one workspace worker and at most 32 outstanding requests per
worker. Admission reserves a queue slot before yielding, so concurrent workspace
changes cannot evict newly admitted work. Cancelled queued jobs are removed
immediately. Each backend serializes requests to avoid competing index writers.
Workers idle for 30 seconds expire; disposing the final owning service closes
the worker. The host must call `dispose()` when its owning session/runtime closes.

The supervisor starts its backend in the same process group (or Windows process
tree). Cancellation, timeout, or parent IPC disconnection terminates that group,
even when the backend is synchronously blocked. Graceful close has a bounded
grace period. Failed initialization/query processes are restarted before another
request, avoiding cached failed imports or damaged native runtime state. Diagnostics expose worker-group and request counts, not queries or source content. Lifecycle transitions and periodic state are logged; successful
queries are not logged.

Limits are enforced before dispatch and on output: queries are at most 2,000
characters, at most 20 candidates, and at most 2,000 snippet characters each.
Candidates are not an exhaustive answer. Inspect current files with Read and
verify exact occurrences with Grep before editing or claiming absence.

## Validation

Unit tests use an isolated fake implementation of the public zg surface to check
permission boundaries, lazy startup, sharing, lifecycle, cancellation, failure,
and result validation. An optional real-backend smoke run uses only temporary
source fixtures and the separately installed official package; it never indexes
this repository or user workspaces. Real-package observations are recorded in
`VALIDATION.md`.

The integration is experimental and opt-in. The current official dependency set
is large, and real fixture measurements show substantial worker memory and weak
Chinese-to-English retrieval with the default model. See VALIDATION.md before
choosing distribution or activation defaults.
