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

Catalog fetch, download and the catalog UI belong to the store module
(`src/main/store/backend/cli-catalog.ts`), which calls this module's public
surface to install a verified file and apply revocations. Not part of any
module yet: user import and a management UI for installed tools. Callers
depend only on `index.ts`.

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
archive sha256 and an expected payload integrity, for example from a catalog. A
mismatch in any of these checks returns `DIGEST_MISMATCH`. An expected id and
version that differ from the manifest return `PACKAGE_INVALID`.

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

The runtime also gets `--require <view>/argv-preload.cjs`, which only sets
`process.defaultApp = true`. Running as Node, Electron still reports
`process.versions.electron` but leaves `defaultApp` unset, so yargs and
commander take the process for a packaged Electron app and pass the entry path
to the tool as its first argument. `defaultApp` is the flag Electron sets when
it runs a script, and with it those parsers read argv as Node does. The
preload is CommonJS, so it also loads before `.mjs` entries, and `fork()`
children inherit it through `execArgv`. It belongs to the view, and the view
key includes the launcher format, so a format change builds new views.

When `basePath` is given and a command name already resolves there, the command
is exposed as `halo-<name>`. The user's own tool keeps its name. The lock
records which name was used.

`releaseExecution` deletes the lock. `removeVersion` returns `IN_USE` while a
version is current or pinned by any lock. `pruneViews` deletes views that no
lock references. Deciding when executions end, and clearing locks left by a
crashed process, is the caller's job.

`pinCurrent` is the form the host uses. It pins the current tool set for a
`holder` (one per app process) under the id `<holder>-<entry>-<viewKey>`, so
every environment built for the same entry with the same tool set shares one
lock, a changed set gets a new one, and each lock records the entry it serves.
It returns `null` and writes nothing when no tool is usable.
`releaseOtherHolders` deletes every lock whose holder is not the given one,
including locks without a holder.

Every view also holds `TOOLS.md`: a table of each command with its tool,
version, side effects, sign-in method and the absolute path of its guide, plus
the meaning of a `halo-` name and the rule not to replay a write whose outcome
is unknown. The built-in `halo-cli-tools` skill tells the AI to read it from
`$HALO_CLI_TOOLS_BIN/../TOOLS.md`, so the guide matches the pinned set.

**Administrator guide overrides.** A catalog may replace the package guide of
one version (`CatalogToolStatus.guides`). `applyCatalogStatus` applies it only
to an installed `preset` or `catalog` version whose payload integrity equals
the catalog's, after re-checking the sha256 and the 64 KiB limit. The text is
stored once per content as `guides/<sha256>.md`; the version record keeps only
`guideOverride: {revision, sha256}`, never the text. `override: null` clears
it and the package guide applies again; a version the catalog omits (for
example a malformed or unsigned override) is left as it is. The pinned lock
records the override, the view key includes its sha256 only when one is
pinned (views without one keep their keys), and the view copies the text to
`views/<viewKey>/guides/<id>.md`, which TOOLS.md names instead of the package
guide. A running execution therefore keeps the text it started with; the next
one gets the new revision. Guide files no record or lock refers to are
deleted after each catalog apply. A missing or altered file is logged and that
view falls back to the package guide.

Revocation excludes a tool from new pins. It is not credential revocation: a
tool's authorization is checked when the tool uses its identity, which a
version pin never freezes.

### Credential bindings

`CliToolStoreOptions.credentialBindings` lists tools whose process receives a
host-held credential (`credentials.ts`; supplied by enterprise-identity, see
its DESIGN.md). A binding applies only to a version whose source is `preset` or
`catalog`; a user import or a registered program of the same id never gets
one. Invalid bindings (reserved or malformed variable names such as `PATH`,
`NODE_OPTIONS`, `DYLD_*`, a relative file, a NUL in a value) are ignored and
logged by field only.

For a bound command the view holds `credential-<n>.cjs`, loaded as a second
`--require` after the argv preload. It removes an inherited value of the
variable, sets the binding's fixed variables, and sets the variable from the
credential file only when the file holds an unexpired token. The binding is
part of the view key, so bound and unbound tool sets get different views, and a
tool set without a binding keeps the view it had. TOOLS.md marks a bound tool's
sign-in as "enterprise sign-in (provided by Halo)" and tells the AI to ask the
user to sign in under Settings rather than handle a credential.

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
  Every pin except a terminal's is remembered as a session pin.
- **Callers.** `buildUserSessionSdkOptions` applies it for every user session,
  whatever the engine, with the entry its caller names (`chat`, `app-chat`,
  `im`, `team`, `automation`; `other` when none is named); internal tasks get
  no tools. The DSH launch spec copies the directory into its own child env.
  The AI terminal applies it with entry `terminal` when a terminal opens.
- **Version timing.** A session or terminal keeps the directory it was built
  with. A new tool set changes the directory, which changes the credentials
  fingerprint, so the next request rebuilds the session with the new set while
  a running turn finishes on the old one.
- **Releasing session pins.** `holdCliTools(binDir)` marks a session's
  launcher directory as in use and returns an idempotent release; holds are
  counted per directory. The agent runtime (`resolved-sdk`) takes one for
  every engine session and query, resident or transient, and releases it once
  the session's processes have exited. When the last hold on a directory
  ends, an unref'd sweep `releaseIdleCliTools(now?)` runs shortly after. A
  session pin no hold covers is released only once it was already unheld at
  an earlier sweep at least `CLI_TOOLS_IDLE_GRACE_MS` (10 minutes) ago, which
  covers an environment assembled for a session that has not started yet;
  being held again restarts the wait, and the sweep repeats after the grace
  period while pins are waiting. After a release it deletes removed versions
  and views nothing pins. It returns `{ released, waiting }` and never throws.
  Pinning and releasing are serialized, so a release never drops a lock a
  concurrent environment just reused. Terminal pins, and any pin left when the
  process exits, are released at the next start.
- **Catalog packages.** `installCatalogPackage(archive, expected)` imports a
  package the caller downloaded from an administrator catalog with source
  `catalog` and makes it current. The archive sha256, payload integrity, id
  and version must all equal the catalog's (`expectedArchiveSha256`,
  `expectedIntegrity`, `expectedTool`); any difference fails before publish
  and leaves the installed versions unchanged.
- **Catalog revocation.** `applyCatalogRevocations({ id: revoked })` sets the
  revocation flag of each installed tool the catalog lists, whatever its
  source; tools the catalog does not list are untouched. The catalog is the
  only revocation authority today, so clearing a flag it no longer sets is
  safe. `readCliToolState` gives callers the installed state to compare with
  a catalog. All three wait for prepare.

## Local management (F03–F05, F08, F09)

The renderer manages tools through `cliToolsRpc`
(`src/shared/rpc/contracts/cli-tools.contract.ts`), served by
`controllers/cli-tools.controller.ts` over IPC. The HTTP routes are all
`internal`. Picking files, confirming an import and registering a program
answer 403 `DESKTOP_ONLY`, because they need a native file dialog and a person
at the device.

**No path comes from the renderer.** `pick-package` and `pick-external` open
the dialog in main and return a `pickId`. The controller keeps the chosen path
for 10 minutes. `preview` and `register` take that id.

**Preview, then confirm (F03).**
- `previewUserPackage` stages the archive in private staging and returns what
  the import would do: `existing`, `sameVersion` (identical/conflict) and
  `clashes`. It runs every import check — archive limits, paths, manifest,
  platform, runtime, integrity and the pure-JS rule — then deletes the staging
  copy. Nothing in the package is executed or installed.
- `importUserPackage(path, { archiveSha256, makeCurrent })` re-imports from
  the file, and requires the archive digest to equal the previewed one. A file
  replaced between preview and confirm fails with `DIGEST_MISMATCH`.
- Import never takes over a current version unless the user ticks
  "make current". The tool must have no current version for an import to
  become current without that.
- User packages carry no signature. The dialog says so.

**Current, disable, delete.**
- `setCliToolCurrent` uses the existing `activateVersion`. The change applies
  to new sessions only, through the view fingerprint (see Version timing).
- `disabled` is the user's switch. `revoked` is the catalog's and is never
  touched by the user's action, and vice versa. Either one keeps the tool out
  of new pins.
- `removeVersion` refuses the current version and preset versions
  (`PRESET_PROTECTED`). A preset can only be disabled, because the next launch
  would reinstall it anyway. `removeTool` refuses a tool that holds a preset
  version.
- **Reference-safe deletion.** The record is removed first. A store directory
  still named by a live execution lock or a view is written to
  `state.pendingCleanup` instead of being deleted, and the call returns
  `{ deferred }`. `prepare` runs `collectPendingCleanup` at the next start,
  after the locks of earlier processes are released. A re-import of the same
  directory takes it out of the list. An empty list is removed from the state,
  so a state that never deleted anything is byte-identical to before.

**Registered existing programs (F04).**
- A program is stored as a version named `external` with `external: { path,
  interpreter, size, mtimeMs, sha256 }` and no store directory. It is never
  copied, modified or deleted; removing it only drops the record.
- It can be a tool of its own (`external.<command>`) or an extra version of an
  installed tool (`toolId`).
- `interpreter` is `halo-node` for `.js/.mjs/.cjs` (run with the bundled Node,
  like packaged tools). Otherwise it is `null` and the file must be executable;
  the launcher `exec`s it directly. The command name follows the manifest rules
  and may not start with `halo-`. The path must be absolute and a regular file.
- Every new pin checks the fingerprint first (`checkExternals`). Size and mtime
  are compared, and the file is re-hashed only when they differ. A touched but
  identical file stays usable. A changed or missing file is marked `changed:
  modified|missing` and is kept out of new pins until `reconfirmExternal`
  records the new fingerprint. The fingerprint is part of the view key, so a
  re-confirmed program gets a new launcher set.
- TOOLS.md marks the command "existing program, not managed by Halo", and the
  UI shows the same warning.

**Catalog status.** `applyCatalogStatus` replaces `applyCatalogRevocations`
for full catalog reads (the old call still exists for revocation-only data).
For each tool with a catalog version installed:
- `revoked` is as before.
- `delisted` is set when the catalog no longer lists the tool, or lists it
  with no version and no revocation. It is excluded from new pins. Tools that
  never came from the catalog are never delisted.
- Each catalog version that is no longer listed gets `withdrawn`. This is
  advice only: it does not disable the version, and the UI suggests updating.
- `catalogUpdate` holds the newest listed version that is higher than every
  installed one. A revoked tool gets none. Nothing is downloaded until the
  user confirms; the UI then calls the store's `installCliTool`.
- A failed catalog read changes nothing.

**Signatures (A07).** `signature.ts` checks catalog versions with Ed25519 over
the bytes
`"halo.cli.sig/1\n" + id + "\n" + version + "\n" + archiveSha256 (lowercase hex) + "\n" + integrity + "\n"`.
Trust comes from `<presetDir>/trusted-keys.json` (`halo.cli.trust/1`, raw
32-byte base64 public keys), which the main build ships with the presets. A
private deployment only injects the file.

| Trust file | Mode | Catalog install |
|---|---|---|
| absent, or `keys: []` | `off` | not verified. UI shows "signature verification not enabled" |
| at least one valid key | `on` | needs a valid signature from a listed key, otherwise `SIGNATURE_MISSING` / `SIGNATURE_INVALID` |
| unreadable, wrong schema, bad key | `broken` | every signed install fails (`SIGNATURE_INVALID`) — fail closed |

Verification runs before download, inside `installCatalogPackage`, so a
caller that skips the store layer is still checked. Presets and user imports
are not catalog packages and are not signature-checked. The real backend
sample (key id `halo-test-2026-11`) is a unit-test fixture.

An administrator guide override is signed separately, because it can change
after the version was approved:
`"halo.cli.guide/1\n" + id + "\n" + version + "\n" + revision + "\n" + sha256 of the text (lowercase hex) + "\n"`.
The host (`withAcceptedGuides`) applies the same trust modes: `off` accepts
it, `on` needs a valid signature from a listed key, `broken` accepts none. A
refused override is dropped with a log line (no text) and the version keeps
the guide it had. The registry's Go test and `signature.test.ts` share one
RFC 8032 vector.

**State compatibility.** All new fields are optional, and `schema` stays 1.
An older build reads the state, ignores `disabled`, `delisted`, `withdrawn`,
`catalogUpdate`, `guideOverride` and `pendingCleanup`, and would treat an `external` version as
a broken store version: it fails that tool's pin, not the session. A
downgrade therefore loses disables, and a registered program stops working
until the newer build is back.

**UI entry point.** Capability library (`AppsPage` → Library) gets a third
segment, "Command-line tools", next to Skills and MCP connections. Tools are
capabilities an agent uses, like skills and MCP servers. The library works
with or without a store, while the catalog is a store surface. Catalog
installs stay in the store; the library shows installed tools from every
source, plus their catalog status and updates.

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
work. Catalog download does not reuse the `external-runtime` transfer: the
catalog is an endpoint of the store source, so the store module fetches it and
the package through its source driver (same proxy, timeout and token rules as
other identity-bound store calls) and hands this service a local file.

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
- A tool child started with `spawn(process.execPath, [script])` instead of
  `fork()` does not get the argv preload, so a yargs or commander child started
  that way sees its script path as an argument.
- On Ctrl+C, cmd.exe may ask "Terminate batch job".
- Paths containing `"` or line breaks are refused for launchers.
- Windows behavior has unit-test coverage only, until it is verified on a real
  machine.
- A removed version used by a closed session is deleted one to two grace
  periods after the session closed, not at once. Terminal pins last until the
  app restarts.
- An environment whose session starts more than `CLI_TOOLS_IDLE_GRACE_MS`
  after it was assembled may find its tool set already released; that session
  runs without tools, it does not fail.
- Lock `entry` is diagnostic only; it never changes which tools a session gets.
