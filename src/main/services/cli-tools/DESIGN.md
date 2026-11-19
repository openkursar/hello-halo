# CLI tools

## Purpose and boundary

This service keeps command-line tools that agent executions can call, and gives
each execution a fixed set of them. A tool is a pure-JavaScript Node program
delivered as a `.hcli` package. It runs on the runtime that ships with the app
(Electron as Node), so users install no Node.js and tools never use the user's
global Node, npm or PATH.

There is one store for every source. A tool may be bundled with the build
(`preset`), delivered by an administrator catalog (`catalog`) or imported by
the user (`user-import`). The host records the source from the import path and
never trusts a source declared inside a package.

The module is pure Node. The caller passes in the store root, runtime
executable, runtime Node version and platform. The module imports no Electron,
agent or app code, and it starts no work at startup.

Not part of this module yet:

- adding launcher directories to an engine's environment;
- binding pins to sessions, to the DSH engine or to the AI terminal;
- delivering guides as skills;
- download, catalog sync and UI.

Those callers depend only on `index.ts`.

## Package contract (`halo.cli/1`)

A package is a zip archive with this layout:

```
manifest.json
payload/       the tool with its dependencies already resolved (node_modules included)
guide/         optional usage guide for the AI
LICENSES/      third-party notices
```

No other top-level entry is accepted. The manifest is strict: unknown keys are
rejected, and new fields require a new schema id.

Required manifest fields:

- `id`: reverse-DNS.
- `version`: semver. One id and version always maps to one content.
- `commands[]`: each item has a `name` and an `entry`. `entry` is a `.js`,
  `.mjs` or `.cjs` file under `payload/`, or an extensionless script as npm
  `bin` entries often are. Command names cannot begin with
  `halo-`, because that prefix is reserved for conflict aliases.
- `runtime.kind`: a reserved enum. This version accepts only `halo-node`.
  `binary` returns `RUNTIME_KIND_UNSUPPORTED`. A later per-platform binary
  package can therefore be added without changing existing packages.
- `platforms`: `any` or `os-arch` values.
- `integrity`: see "Integrity".

Optional manifest fields:

- `runtime.minNode`
- `auth.method`: `none`, `env-ref` or `external-login`. It declares a method
  only and never holds a credential.
- `nonInteractive`
- `outputFormats`
- `sideEffects`: `read-only` or `writes`. A caller uses it to avoid replaying
  a write whose outcome is unknown.
- `guide`

### Integrity

`integrity` is the sha256 of the canonical payload listing, written in
subresource-integrity form (`sha256-<base64>`). The listing has one line per
file, `path\0<sha256 hex>\n`, sorted by path. Packaging tools compute it
with `computePayloadIntegrity`. A caller may also pass an expected
archive sha256, for example from a catalog. A mismatch in either check returns
`DIGEST_MISMATCH`.

### Pure-JS rule

A payload is rejected with `NATIVE_NOT_ALLOWED` when it contains any of the
following:

- `.node` addons or `binding.gyp`;
- ELF, Mach-O or PE images;
- a `package.json` with install scripts or `gypfile`;
- an OS/CPU-pinned package;
- per-platform optional dependencies.

These checks are static heuristics, and nothing in the package is executed
during import. Native code is out of scope: it would have to be built for
Electron's ABI or shipped with its own runtime.

## Import transaction

An import runs in this order:

1. Extract into `staging/<txid>` with limits: a 128 MiB archive, 512 MiB
   expanded and 50,000 entries.
2. Check entry paths. Absolute paths, drive letters, backslashes and `..` are
   rejected, as are case-insensitive collisions.
3. Validate the manifest and host support.
4. Hash the payload, then check integrity and the pure-JS rule.
5. Make the tree read-only.
6. Rename it into place.
7. Write `state.json` atomically.

If anything fails, staging and any directory published by this transaction are
removed. The previous state, current version and installed versions stay as
they were.

An id and version cannot be re-imported with different content
(`VERSION_CONFLICT`). Importing identical content again is a no-op that may make
the version current. Installed versions live in `store/<id>/<version>-<digest12>`
and are never modified. Only one mutation runs at a time in this process, and
Halo runs as a single instance.

`state.json` holds each tool's versions, its current version and a revocation
flag. A corrupt file returns `STATE_CORRUPT` and is never silently reset,
because a reset would orphan installed tools.

## Executions: pin, launch, release

`pinExecution` takes the current non-revoked version of every tool. It writes
`locks/<executionId>.json` and returns a launcher directory. The caller
appends that directory to the end of the execution's PATH, as the office
runtime does, so a launcher never shadows a system command.

Calling `pinExecution` again with the same execution id returns the original
pin. A running task therefore keeps the versions it started with, and the next
execution uses whatever is current at that time. Activating or rolling back a
version never changes an existing pin.

Launcher directories (`views/<viewKey>/bin`) are content-addressed and
immutable, so executions with the same tool set share one. A view is built in a
temporary directory and renamed into place.

Each launcher only sets `ELECTRON_RUN_AS_NODE`, then runs the fixed runtime on
the fixed entry and passes arguments through. The sh launcher uses `exec`, so
cwd, stdio, exit status and signals belong to the tool. On Windows, a `.cmd`
launcher and an extensionless sh twin for Git Bash are both written.

When `basePath` is given and a command name already resolves there, the command
is exposed as `halo-<name>`. The user's own tool keeps its name. The lock
records which name was used.

`releaseExecution` deletes the lock. `removeVersion` returns `IN_USE` while a
version is current or pinned by any lock. `pruneViews` deletes views that no
lock references. Deciding when executions end, and clearing locks left by a
crashed process, is the caller's job.

Revocation excludes a tool from new pins. It is not credential revocation: a
tool's authorization is checked when the tool uses its identity, which a
version pin never freezes.

## Relation to external-runtime

`external-runtime` manages the engine runtimes (Claude Code, Codex): a closed
`RuntimeId`, one selected installation per runtime, discovery and probing of
executables the user installed, and global engine activation. A CLI tool needs
none of that and needs what it lacks: any number of tools from one package
contract, several installed versions, and per-execution pins. Registering each
tool as a runtime provider would add per-tool code to a shared module, so this
service does not depend on it.

It follows the same conventions instead: private staging, verification before
an atomic publish into immutable content-addressed directories, failure keeping
the current selection, no install scripts, SRI-form integrity, and no startup
work. The bounded HTTPS transfer in `external-runtime` is internal to that
service. Catalog download is a later step, and that step will propose how to
share it rather than copy it.

## Cost

Nothing runs at startup or in the background, and there is no watcher or scan.

- **Import:** an explicit action. Hashing is proportional to the package (tens
  of MB for the tested tools), and extraction is synchronous inside fflate,
  bounded by the limits above.
- **Pinning:** reads `state.json` and one lock file, checks bounded PATH
  entries (at most 256) for each command, and writes launchers only when a new
  tool set appears.
- **Verification:** `verifyVersion` re-hashes a version on request only.

## Known limits

- Launchers pass `ELECTRON_RUN_AS_NODE` to the tool's own children. Those
  children need it when they run `process.execPath` as Node, but any Electron
  app the tool starts would also run as Node.
- On Ctrl+C, cmd.exe may ask "Terminate batch job".
- Paths containing `"` or line breaks are refused for launchers.
- Windows behavior has unit-test coverage only, until it is verified on a real
  machine.
