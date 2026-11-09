# Optional code search validation

Measured on 2026-10-26 with Node 22.23.3, macOS ARM64,
`@zvec/zvec-grep` 0.2.2 and `@zvec/zvec` 0.7.1. The official package was installed
only in a temporary directory. No user workspace was indexed and no remote
embedding service was configured.

## Real backend fixture

The adapter used the package's public `createZvecGrep` API through its dedicated
child process. Six TypeScript files (1,190 bytes total) covered authorization,
network retries, cart totals, themes, revenue reports, and colors. There were
seven indexed entities. An additional symlink pointing to a file outside the
fixture was not indexed: the backend reported six scanned/stored/indexed files,
zero failures, and `follow: false` in its source configuration.

The local Potion model artifacts were already cached before the measured run.
The first query therefore includes process startup, module/model loading,
initial index creation, and retrieval, but excludes model download time.

| Operation | Observed elapsed time |
| --- | ---: |
| First English authorization query | 3,183 ms |
| Subsequent Chinese authorization query | 79 ms |
| Subsequent English retry query | 77 ms |
| Subsequent Chinese retry query | 76 ms |
| Explicit refresh with no source changes, then query | 257 ms |

Post-request worker RSS samples ranged from approximately 694 to 794 MiB, using
`ps -o rss` after each request. These are resident-memory snapshots, not peak
measurements or proof of a memory leak. The process and its native/model threads
were gone after `dispose()`, and the service reported zero workers, pending
requests, and running operations.

The supervised backend was measured against both the existing index and a new
temporary index, reusing only the cached model artifacts:

| Supervised backend | Existing index | New index |
| --- | ---: | ---: |
| First query including process startup | 621 ms | 5,124 ms |
| Subsequent query samples | 86–88 ms | 98–131 ms |
| Explicit unchanged refresh plus query | 272 ms | 579 ms |
| Supervisor RSS snapshots | 34–40 MiB | 33–34 MiB |
| Backend RSS snapshots | 447–477 MiB | 465–558 MiB |

These are individual observations, not paired statistical benchmarks. The earlier
694–794 MiB backend samples remain relevant; the smaller later snapshots do not
establish a memory optimization or a lower upper bound. The supervisor's RSS is
additional. Both runs returned the same relevant/irrelevant query ordering
shown below, and disposal again left no running worker group.

Allocated disk space measured with `du -sk`:

| Component | Observed KiB |
| --- | ---: |
| Official npm dependency tree | 548,112 |
| Local model cache | 32,744 |
| Adapter-managed workspace index | 4,768 |

The dependency tree includes roughly 208 MiB of `onnxruntime-node`, 91 MiB of
`onnxruntime-web`, 48 MiB under `@huggingface`, 34 MiB of `node-llama-cpp`, and
33 MiB under `@zvec`. The ONNX packages are mandatory transitive dependencies of
`@huggingface/transformers` in this release, even though the default Model2Vec
path uses `@huggingface/tokenizers`. Omitting optional packages also removes the
platform Zvec binding unless it is supplied separately; it is not a complete
lightweight deployment recipe. No third-party packages were patched or pruned.

## Retrieval observations

| Query | First candidate | Relevant source within first three? |
| --- | --- | --- |
| where are invalid access tokens rejected | authorization function | yes |
| 哪里会拒绝不合法的访问令牌 | cart total function | yes, second |
| where are failed network requests retried | retry function | yes |
| 网络请求失败后的重试机制在哪里 | revenue report function | no |

This fixture checks that the actual integration runs; it is far too small to
estimate retrieval quality for real projects. In particular, these observations
do not support advertising the default model as reliable Chinese-to-English
code retrieval. The adapter returns candidates, preserves freshness limitations,
and leaves exact verification to Read/Grep.

## Supported controls and decision

The public `CreateZvecGrepOptions` and `CreateEmbeddingModelOptions` in 0.2.2 do
not expose a memory limit, cache size, or Model2Vec worker-pool size. The Node
Zvec 0.7.1 public initialization options expose thread counts and query tuning,
but no memory budget, and zg does not forward those initialization settings.
The adapter uses the supported CPU device and indexing concurrency of one.

Given the measured cost, keep this backend experimental, explicitly enabled,
and installed separately on demand. Do not include its dependencies in the base
SDK or launch/index it for ordinary sessions. The adapter permits one native
worker at a time and releases an idle worker after 30 seconds by default.
Windows packaging and representative production repositories still need their
own validation before wider activation.

## Automated boundary checks

Focused tests exercise lazy startup, deny-root intersection and aliases,
unrelated restrictions, shared workers/indexes, explicit refresh, serialization,
active and queued cancellation, timeout termination, candidate path containment,
credential isolation, idle/disposal cleanup, malformed results, native exits,
worker capacity, and the model-facing tool result contract. Regression tests also
cover concurrent idle-workspace replacement, immediate removal of 31 cancelled
queued jobs, retry after repairing an import at the same module path, and sharing
identical configuration supplied in different property orders.

A dedicated process test blocks the backend event loop with `Atomics.wait`, kills
the owning host with SIGKILL, and verifies that both supervisor and backend stop.
Cancellation with the host still alive is tested against the same blocking
fixture. The four lifecycle regressions also passed in a separate run from freshly
built sources. In that host-death observation both processes had disappeared
within 23 ms. This is a measured observation on macOS,
not a guaranteed cross-platform shutdown deadline.

Official references:

- [Public programmatic exports](https://github.com/zvec-ai/zvec-grep/blob/main/src/index.ts)
- [Service options and result types](https://github.com/zvec-ai/zvec-grep/blob/main/src/engine/service/types.ts)
- [Model catalog](https://github.com/zvec-ai/zvec-grep/blob/main/src/engine/models/catalog.ts)
- [Zvec Node public types](https://github.com/zvec-ai/zvec-node/blob/main/src/index.d.ts)
