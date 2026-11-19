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

The module is pure Node. `store.ts` takes the store root, runtime executable,
runtime Node version and platform from its caller. `host.ts` is the one place
the app wires it: bootstrap passes the paths in, and session and terminal code
call `applyCliToolsEnv`. The module imports no Electron, agent or app code.

Not part of this module yet: catalog download and sync, user import, and UI.
Callers depend only on `index.ts`.

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

### Frozen rules and shared vectors

`halo.cli/1` is frozen. A registry that validates uploads must reach the same
verdict and error code as the client for every package. The vectors in
`tests/unit/services/cli-tools/vectors/` are the reference: each `.hcli` file
breaks at most one rule, and `expected.json` gives its sha256 and either the
expected `{id, version, integrity}` or the error code. Changing a rule means
regenerating the vectors with `generate.mjs` and copying the directory to every
consumer, so a server and the client cannot drift apart.

Package checks run in this order, and the first failure decides the code:

1. Archive larger than 128 MiB: `PACKAGE_INVALID`.
2. For each zip entry, after stripping one trailing `/`:
   - The path must be 1 to 512 characters, with no `\`, no NUL, no leading `/`,
     no drive letter, and no empty, `.` or `..` segment. Otherwise
     `PATH_UNSAFE`.
   - The path must be exactly `manifest.json` or start with `payload`, `guide`
     or `LICENSES`. Otherwise `PACKAGE_INVALID`.
   - Two entries that are equal after lowercasing: `PATH_UNSAFE`.
   - More than 50,000 entries, more than 512 MiB declared or expanded, or an
     unreadable archive: `PACKAGE_INVALID`.
3. No `manifest.json`: `MANIFEST_INVALID`.
4. Archive sha256 differs from an expected value: `DIGEST_MISMATCH`.
5. Manifest is not JSON or fails the strict schema: `MANIFEST_INVALID`.
6. `runtime.kind` is `binary`: `RUNTIME_KIND_UNSUPPORTED`.
7. Host checks, client only: `RUNTIME_VERSION_UNSUPPORTED`, then
   `PLATFORM_UNSUPPORTED`. A registry does not apply them, because the
   uploading machine is not the installing machine.
8. No `payload/` entry: `PACKAGE_INVALID`.
9. Pure-JS rule: `NATIVE_NOT_ALLOWED`. Then integrity: `DIGEST_MISMATCH`.
10. A command entry that is not a file under `payload/`: `MANIFEST_INVALID`.
11. A `guide` that is not a file: `MANIFEST_INVALID`.

Details another implementation must match:

- Integrity sorts paths by UTF-16 code units, which is JavaScript's default
  string order, not UTF-8 byte order. Paths are not Unicode-normalized.
- Zip symlink modes are ignored. Every entry is extracted as a regular file or
  directory, and a directory entry is one whose name ends in `/`.
- The collision check lowercases with JavaScript `toLowerCase`. Another
  language's lowercasing may differ for a few non-ASCII characters; the
  vectors cover only ASCII collisions.
- The pure-JS rule looks at each file's name and first four bytes, and at every
  file named `package.json` that parses as a JSON object. An unparsable
  `package.json` is ignored. The magic numbers are ELF `7f454c46` and
  `feedface`, `feedfacf`, `cefaedfe`, `cffaedfe`, `cafebabe`. An `MZ` header
  counts only in a file named `.exe` or `.dll`.
- A per-platform optional dependency is a key matching
  `(^|[-/@])(darwin|linux|win32|windows|android|freebsd|sunos|aix)([-_]|$)`,
  case-insensitive.

A registry may be stricter than the client where the client accepts a package
by accident of its runtime or fails without a typed code. The client must
never accept less than a registry, so these cases only ever move a package
from accepted to rejected:

- A CRC mismatch, an entry used both as a file and as a directory, `payload`
  as a file, or a UTF-8-flagged entry name that is not valid UTF-8:
  `PACKAGE_INVALID`.
- Command entries and the guide are matched exactly. The client checks them on
  disk, which is case-insensitive on macOS and Windows.
- Lowercasing and the case-insensitive platform regex may fold a few
  non-ASCII characters differently (for example `ſ` or the Kelvin sign).

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

`pinCurrent` is the form the host uses. It pins the current tool set for a
`holder` (one per app process) under the id `<holder>-<viewKey>`, so every
environment built with the same tool set shares one lock and a changed set
gets a new one. It returns `null` and writes nothing when no tool is usable.
`releaseOtherHolders` deletes every lock whose holder is not the given one,
including locks without a holder.

Every view also holds `TOOLS.md`: a table of each command with its tool,
version, side effects, sign-in method and the absolute path of its guide, plus
the meaning of a `halo-` name and the rule not to replay a write whose outcome
is unknown. The built-in `halo-cli-tools` skill tells the AI to read it from
`$HALO_CLI_TOOLS_BIN/../TOOLS.md`, so the guide matches the pinned set.

Revocation excludes a tool from new pins. It is not credential revocation: a
tool's authorization is checked when the tool uses its identity, which a
version pin never freezes.

## Host wiring (`host.ts`)

- **Init.** Bootstrap calls `initCliTools` after the SDK runtime is set up, with
  root `<userData>/cli`, the headless Electron runtime and the bundled preset
  directory (`<resources>/cli-preset`, or `resources/cli-preset` in
  development). It only stores the paths.
- **Prepare, once per process.** The first of the idle task
  `prepare-cli-tools` or the first environment request runs it: release the
  locks of earlier processes, prune views, then import bundled packages.
- **Bundled tools.** Every `*.hcli` in the preset directory is imported with
  source `preset`. It becomes current only when the tool has no current version
  or the current one is itself a preset, so a version the user or a catalog
  chose is kept. `preset-stamp.json` records the file names, sizes and mtimes;
  an unchanged directory is skipped. Any failure leaves the stamp unwritten so
  the next launch retries.
- **Environments.** `applyCliToolsEnv(env, { entry, engine })` removes any
  inherited `HALO_CLI_TOOLS_BIN`, pins the current set, appends the launcher
  directory to the end of the env's PATH (`Path` on Windows, matched
  case-insensitively) and sets `HALO_CLI_TOOLS_BIN`. Any failure is logged and
  the env is left without tools; a session never fails because of a tool.
- **Callers.** `buildUserSessionSdkOptions` applies it for every user session,
  whatever the engine; internal tasks get no tools. The DSH launch spec copies
  the directory into its own child env. The AI terminal applies it when a
  terminal opens.
- **Version timing.** A session or terminal keeps the directory it was built
  with. A new tool set changes the directory, which changes the credentials
  fingerprint, so the next request rebuilds the session with the new set while
  a running turn finishes on the old one. Old sets stay pinned until the
  process exits and are released at the next start.

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

Nothing runs on the startup path. Bootstrap only stores paths; the work runs
once in an idle task or on the first session that asks. There is no watcher or
scan. fflate is loaded only when an archive is extracted.

- **Prepare:** reads the lock directory, the views and the preset directory
  listing. Bundled packages are imported only when the directory changed.
- **Import:** hashing is proportional to the package (tens
  of MB for the tested tools), and extraction is synchronous inside fflate,
  bounded by the limits above.
- **Pinning:** once per session build or terminal open. Reads `state.json`
  and one lock file, checks bounded PATH
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
- Pins are released per process, not per session: a tool set used once stays
  pinned until the app restarts.
- Lock `entry` is `other` for every session (the builder does not know which
  entry called it) and `terminal` for terminals. It is diagnostic only.
