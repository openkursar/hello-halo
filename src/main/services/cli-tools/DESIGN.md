# CLI tools

## Purpose and boundary

This service keeps command-line tools that agents can call. A tool is a
pure-JavaScript Node program delivered as a `.hcli` package. It runs on the
runtime that ships with the app (Electron as Node), so users install no Node.js
and tools never use the user's global Node, npm or PATH.

An installed tool is one unit, like an editor extension: its package, its
launchers and its skill are installed, updated and removed together. The skill
names each launcher by absolute path and carries the tool's guide, so an agent
reads the skill and runs the command; nothing is added to a session's PATH or
environment for it, and a user's own program of the same name is never
shadowed or renamed.

There is one store for every source. A tool may be bundled with the build
(`preset`), delivered by an administrator catalog (`catalog`) or imported by
the user (`user-import`). The host records the source from the import path and
never trusts a source declared inside a package. The build and the catalog
deliver a tool as one delivery bundle (`halo.cli.bundle/1`): its unchanged
`.hcli` package and its skill, checked and switched together.

The module is pure Node. `store.ts` takes the store root, runtime executable,
runtime Node version and platform from its caller. `host.ts` is the one place
the app wires it: bootstrap passes the paths in and the idle task prepares the
store. The module imports no Electron, agent or app code; Apps installs the
skills (`apps/skills/tool-skills.ts`, `apps/manager/managed-tool-skill.ts`).

Catalog fetch, download and the catalog UI belong to the store module
(`src/main/store/backend/cli-catalog.ts`), which calls this module's public
surface to install a verified file and apply revocations. User import and the
management UI for installed tools reach it through
`controllers/cli-tools.controller.ts` (see "Local management"). Callers depend
only on `index.ts`.

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
5. Place the configured support files alongside the verified package entries.
6. Rename the tree into place and make it read-only before exposing it.
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

### Product support files

A deployment may declare `cliTools.supportFiles` in `product.json`: each entry
names a `source` relative to that config and a `target` relative to a managed
version root. The builder ships declared source files at those relative paths.
An omitted declaration or empty array adds no required files or launch check.
A nonempty declaration is one required set, not a list of optional files. Every
source must be a non-secret, nonempty, single-link regular file (up to 1 MiB
per file, 32 entries) with no linked path segments. Targets use portable
forward-slash paths outside package-owned roots and cannot collide. Invalid
sources, malformed lists, colliding targets and incomplete placement refuse the
whole set, even if none of the declared files can be loaded. Imports fail
transactionally. Preset, catalog and user-import packages share this rule;
registered external programs are not changed. Archive and payload integrity
checks are unchanged.

The first install uses the staged package as its runtime root, so it copies no
payload. If a later product deployment changes or removes the support files,
identical re-import or the next launcher write publishes a runtime root at
`support/<id>/<version>-<digest12>/<supportDigest>/`. It copies only the original
package entries, using filesystem copy-on-write when available, and places the
new files beside the real `payload/` directory. The launchers name the chosen
root, and its support digest is part of what they are written from. Neither the
base nor any earlier root is rewritten. Removing a version reclaims its entire
variant family under the same deferred-cleanup rule as the base. Expected sizes
and SHA-256 hashes come from the successful deployment snapshot, not from the
installed directory. A failed deployment read is retried on the next launcher
write. Each launcher write verifies its selected base or variant. A changed
deployment can incur one copy on the next start on filesystems without
copy-on-write. A damaged required set never repairs or replaces an installed
directory in place.

Configured managed launchers run a same-process preflight before credential
setup and the CLI entry. It checks the chosen canonical root and relative
paths, rejects linked ancestors and non-regular or multiply linked files,
checks containment and file size, and hashes each required file (up to 1 MiB).
A failure exits nonzero with one path-free message and does not execute the CLI
or switch programs. If a launcher write finds an invalid deployment or damaged
required files, the tool's launchers become refusal launchers that print that
message; other tools are unaffected, and a later write after repair restores
them. The launch check verifies the files before entry; it does not sandbox a
tool or lock its filesystem for the rest of the command.

On Windows the executable junction is only for the bundled runtime executable.
Supported entries and helpers use the real CLI store root, not that junction.
Native Windows packaged execution still requires platform verification.

## Launchers and installations

Every usable tool (`toolBlock(tool) === null`, with commands) has a directory
`tools/<id>/`:

```
tools/<id>/bin/<command>        sh launcher (and <command>.cmd on Windows)
tools/<id>/argv-preload.cjs     argv fix (see shims.ts)
tools/<id>/support-<n>.cjs      required support file check, when configured
tools/<id>/credential-<n>.cjs   credential preload, for a bound tool
tools/<id>/install.json         the installation record
```

Paths never contain the version, so a skill keeps naming the same file across
updates. A tool gets an installation id (`CliToolRecord.installId`, six hex
digits) the first time it becomes usable; it survives version changes,
disabling and revocation and is dropped with the tool, so a tool installed
again is a new installation. `install.json` (`CliToolInstallRecord`) records
the id, the current version and integrity, each command's launcher path, a
`launchKey` digest of everything the launchers were written from (format,
platform, runtime path, version, targets, support digest, credential binding,
external fingerprint), and — once Apps reports it through
`recordSkillLocation` — the name and file of the skill that belongs to this
installation. The skill location is carried across launcher rewrites of the
same installation and ignored for any other.

`writeState` keeps `tools/` in line with state: when the usable set changes it
rewrites the launchers of tools whose `launchKey` differs and removes the
directories of tools that are no longer usable, before it fires
`onDidChangeCurrentTools`, so no skill is published for a launcher that is not
there yet. `syncLaunchers` does the same once per process from `prepare`,
which catches a moved runtime, a changed support deployment or changed
registered programs, and removes the `views/` and `locks/` directories of
earlier builds. A directory is built beside the live one and swapped in, so a
command started meanwhile finds either set, never half of each. A tool whose
launchers cannot be written keeps the ones it had; the failure is logged and
the next change retries. A missing runtime writes nothing.

Launchers for the bundled runtime set `ELECTRON_RUN_AS_NODE` and clear
`NODE_PATH` so neither user paths nor Office's packaged modules affect CLI
dependency resolution. They pass arguments through to the fixed entry. The sh
launcher uses `exec`, so cwd, stdio, exit status and signals belong to the tool.
Windows gets both a `.cmd` launcher and an extensionless sh twin for Git Bash.
Registered programs run directly keep their inherited environment.

cmd.exe reads a batch file in the console code page, so a `.cmd` launcher holds
no non-ASCII text. A path under the launcher's own root is written relative to
`%~dp0` when that relative path is ASCII. A runtime in a non-ASCII folder (for
example an install directory with Chinese characters) is reached through a
junction at `runtime/<hash of its folder>` in the root; a wrong link there is
replaced, and anything else at that path is left alone and the absolute path is
used. ASCII paths are written as before.

The runtime also gets `--require <tools/<id>>/argv-preload.cjs`, which only sets
`process.defaultApp = true`. Running as Node, Electron still reports
`process.versions.electron` but leaves `defaultApp` unset, so yargs and
commander take the process for a packaged Electron app and pass the entry path
to the tool as its first argument. `defaultApp` is the flag Electron sets when
it runs a script, and with it those parsers read argv as Node does. The
preload is CommonJS, so it also loads before `.mjs` entries, and `fork()`
children inherit it through `execArgv`.

Versions are not pinned per session: the next run of a command uses the
current version, and a command already running finishes on the version it
started with. A store directory this process gave launchers to may still be
running a command, so removing its version defers the files to
`pendingCleanup` (deleted at the next start); a version that never had
launchers in this process is deleted at once, and one that cannot be deleted
now also waits. `launchedDirs()` exposes that set; the management view shows
such a version as in use.

### Delivery bundles (`bundle.ts`)

A delivery bundle is a zip holding `bundle.json`, an optional `bundle.sig`,
`cli.hcli` (the approved package, byte for byte) and `skill/` (SKILL.md and
its files; absent when the tool has none). It is identified by `(id, version,
revision)` and never changes; the Registry issues a new revision of an
approved version when its skill or the signing key changes, never for a new
CLI. `readBundle(bytes, reference, trust)` checks, stopping at the first
failure:

1. the whole bundle's sha256 and size against the catalog reference;
2. the entry layout and limits, read from the zip directory before anything
   is inflated (129 MiB bundle, 128 MiB `cli.hcli`, 2,000 skill files, 32 MiB
   of skill, safe relative paths, no case-insensitive collisions);
3. the signature under the build's trust policy (below), then `bundle.json`
   strictly (unknown keys refused) with the same id, version and revision;
4. `cli.hcli` against `cli.archiveSha256` and `cli.size`;
5. `skill/` against `skill.sha256` (`halo.cli.skillpkg/1`: sha256 over
   `"halo.cli.skillpkg/1\n"`, then `"<path>\n<sha256 of the file>\n"` per file
   sorted by UTF-8 path bytes) and `skill.files`; SKILL.md must be UTF-8 text
   within 1 MiB.

The CLI package then goes through the ordinary import with `cli.archiveSha256`,
`cli.integrity`, id and version as its expectations. When that content is
already installed (same version and payload integrity), nothing is
reinstalled: only the version's recorded `bundle` revision and `skill` change.
A version installed before bundles, such as an earlier build's preset, takes
its first bundle this way. A bundle's skill is recorded only on a `preset` or
`catalog` version; a user's import of the same version keeps its package
guide. The skill files are kept once per content in `skills/<sha256>/`,
written through staging and left read-only, and are deleted when no version
refers to them. A stored copy that no longer matches its digest is reported
and the package guide stands in. Records and `guides/` texts that earlier
builds kept for catalog guide overrides are dropped at the next start.

Revocation takes a tool's launchers and skill away; a command already running
finishes. It is not credential revocation: a tool's authorization is checked
when the tool uses its identity.

### Credential bindings

`CliToolStoreOptions.credentialBindings` lists tools whose process receives a
host-held credential (`credentials.ts`; supplied by enterprise-identity, see
its DESIGN.md). A binding applies only to a version whose source is `preset` or
`catalog`; a user import or a registered program of the same id never gets
one. Invalid bindings (reserved or malformed variable names such as `PATH`,
`NODE_OPTIONS`, `DYLD_*`, a relative file, a NUL in a value) are ignored and
logged by field only.

For a bound command the tool directory holds `credential-<n>.cjs`, loaded as a
second `--require` after the argv preload. It removes an inherited value of the
variable, sets the binding's fixed variables, and sets the variable from the
credential file only when the file holds an unexpired token. The binding is
part of the `launchKey`, so only the bound tool's launchers change when a
binding appears. How to sign in reaches the agent through the organization
status reminder (`services/agent/org-context.ts`), not the skill.

### Tool skills (`skills.ts`)

`readCurrentToolSkills` describes the skill of each usable tool with an
installation id. Its name is `<command>-<tool id>-<install id>`, folded to
lowercase letters, digits and dashes within 64 characters (a tool id cut to fit
gets a digest), so two Halo installations sharing the personal skill folder
never write or remove each other's skill. Its description says which command
it belongs to, followed by the bundle skill's `description`, the package
guide's, the manifest description, or a generated line, as one line of at most
300 characters. Its body is a Halo header — a comment with the tool id and
install id, then each command and its absolute launcher path (plus the `.cmd`
path on Windows) — followed by the bundle's SKILL.md without its frontmatter,
else the package guide (at most 64 KiB), or a pointer to `--help` when there is
none. The bundle skill's other files travel with it as `attachments` and are
installed beside SKILL.md. The skill names no Halo variable, index or
session concept: reading it is enough to run the tool.

Per-tool fingerprints cover the installation id, integrity, bundle skill sha256,
names, description and commands, so Apps reads guides only for tools whose
skill changed. `onDidChangeCurrentTools` fires after committing a change to
the usable set (launchers already written); changes during catalog delivery are
batched. `describeToolSkills(state)` and `previewPackage` provide management
summaries, not skill files.

## Host wiring (`host.ts`)

- **Init.** Bootstrap calls `initCliTools` with root `<userData>/cli`, the
  headless Electron runtime and the bundled preset directory
  (`<resources>/cli-preset`, or `resources/cli-preset` in development). It only
  stores the paths.
- **Prepare, once per process.** The idle task `prepare-cli-tools` (or the
  first management call) runs it: delete directories left in
  `pendingCleanup`, import bundled packages, then `syncLaunchers`. Sessions
  never wait for it; on a first start a session opened in the first moments
  may not list a bundled tool's skill yet.
- **Skills.** `bootstrap/cli-tool-skills.ts` subscribes Apps to
  `onDidChangeCurrentTools`: each changed tool's skill is reconciled through
  the App Manager, and the file Halo now manages (or none) is recorded in the
  installation with `recordCliToolSkill`. A tool that stops being usable has
  its skill removed. The idle task never waits for the App Manager.
- **Organization tools.** `peekOrganizationTools()` returns, from memory, the
  usable tools whose current version came from the build or an administrator
  catalog and whose installation records an installed skill: id, display name
  and skill name. It is refreshed after every change and skill record, for the
  organization status reminder.
- **Sessions and terminals** get nothing from this module. Organization access
  for commands (for example a sign-in broker command) comes from
  `enterprise-identity` (`applyOrgSessionEnv`).
- **Bundled tools.** Every delivery bundle (`*.zip`) and plain `*.hcli` in the
  preset directory is imported with source `preset`. A bundle must be named
  `<id>-<version>-r<revision>.zip` by the build's catalog snapshot
  (`catalog.json`, `halo.cli.catalog/2`), which gives its sha256 and size and
  may revoke the tool; an unnamed or revoked bundle is refused without
  touching installed state, and the whole bundle check runs as for a download.
  A plain package carries no skill of its own. A bundle becomes current only
  when newly installed and above the version that was current, so an older
  build never takes back a newer choice. It becomes current only when the tool has no current version
  or the current one is itself a preset, so a version the user or a catalog
  chose is kept. One exception: a tool the administrator delivers
  (`autoInstall`) takes a preset higher than its current catalog version, so
  a newer installer is not held back by an older delivery. `preset-stamp.json` records the file names, sizes and mtimes;
  an unchanged directory is skipped. Any failure leaves the stamp unwritten so
  the next launch retries.
- **Catalog bundles.** `installCatalogBundle(bytes, reference)` installs a
  bundle the store downloaded with source `catalog` and makes it current, or
  only takes its skill when that CLI content is installed. Any refusal leaves
  the installed versions unchanged. The verified CLI package is written to
  `downloads/` only for the import and removed after it.
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
- `setCliToolCurrent` uses the existing `activateVersion`. The launchers and
  skill follow at once; the next run of the command uses that version.
- `disabled` is the user's switch. `revoked` is the catalog's and is never
  touched by the user's action, and vice versa. Either one takes the tool's
  launchers and skill away.
- `removeVersion` refuses the current version and preset versions
  (`PRESET_PROTECTED`). A preset can only be disabled, because the next launch
  would reinstall it anyway. `removeTool` refuses a tool that holds a preset
  version. Catalog versions of a tool the administrator delivers, and that
  tool itself, are refused the same way (`ADMIN_MANAGED`): the next catalog
  read would install them again. Disabling still works; a disabled delivered
  tool keeps receiving updates.
- **Deferred deletion.** The record is removed first, which also removes the
  launchers. A store directory this process gave launchers to, or one that
  cannot be deleted now, is written to `state.pendingCleanup` instead of being
  deleted, and the call returns `{ deferred }`. `prepare` runs
  `collectPendingCleanup` at the next start. A re-import of the same directory
  takes it out of the list. An empty list is removed from the state, so a
  state that never deleted anything is byte-identical to before.

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
- `syncLaunchers` checks the fingerprint once per process (`checkExternals`).
  Size and mtime are compared, and the file is re-hashed only when they differ.
  A touched but identical file stays usable. A changed or missing file is
  marked `changed: modified|missing` and loses its launcher and skill until
  `reconfirmExternal` records the new fingerprint, which is part of the
  `launchKey`.
- The UI marks the command "existing program, not managed by Halo".

**Catalog status.** `applyCatalogStatus` replaces `applyCatalogRevocations`
for full catalog reads (the old call still exists for revocation-only data).
For each tool with a catalog version installed:
- `revoked` is as before.
- `delisted` is set when the catalog no longer lists the tool, or lists it
  with no version and no revocation. It loses its launchers and skill. Tools
  that never came from the catalog are never delisted.
- Each catalog version that is no longer listed gets `withdrawn`. This is
  advice only: it does not disable the version, and the UI suggests updating.
- `catalogUpdate` holds the newest listed version that is higher than every
  installed one. A revoked tool gets none. Nothing is downloaded until the
  user confirms; the UI then calls the store's `installCliTool`.
- `autoInstall` mirrors the catalog's mark (administrator delivery, see
  `store/DESIGN.md` §3.13). It is kept while the catalog lists the tool with
  no version, so the store can still fall back to the preset copy, and
  dropped when the tool is listed with versions and no mark, or not listed.
- `deliveryFailures` (`id@version` → `{bundle, code, at}`) records a
  delivered bundle that was refused, so background reads skip it.
  `recordDeliveryFailure` writes it; a catalog read drops entries whose
  version is no longer listed with the same bundle sha256; a successful
  import of that version drops it too. The
  overview returns them for the tools page.
- A failed catalog read changes nothing.

**Signatures (A07).** `signature.ts` checks a bundle's `bundle.sig`
(`{alg: 'ed25519', keyId, value}`) with Ed25519 over
`"halo.cli.bundle/1\n"` followed by the raw bytes of its `bundle.json`. Trust
comes from `<presetDir>/trusted-keys.json` (`halo.cli.trust/1`, raw 32-byte
base64 public keys), which the main build ships with the presets. A private
deployment only injects the file.

| Trust file | Mode | Bundle install (catalog and preset) |
|---|---|---|
| absent, or `keys: []` | `off` | `bundle.sig` is ignored; digests alone. UI shows "signature verification not enabled" |
| at least one valid key | `on` | needs a valid signature from a listed key, otherwise `SIGNATURE_MISSING` / `SIGNATURE_INVALID` |
| unreadable, wrong schema, bad key | `broken` | every bundle is refused (`SIGNATURE_INVALID`) — fail closed |

The check runs inside `readBundle`, so a caller that skips the store layer is
still checked. Plain `.hcli` presets and user imports carry no signature. The
skill is inside the signed `bundle.json` digest, so it needs no signature of
its own. `signature.test.ts` holds a vector the Registry's
`signing.VerifyBundle` also accepts.

**State compatibility.** All new fields are optional, and `schema` stays 1.
An older build reads the state, ignores `disabled`, `delisted`, `withdrawn`,
`catalogUpdate`, `bundle`, `skill`, `pendingCleanup`, `autoInstall`,
`deliveryFailures` and `installId`, and would treat an `external` version as
a broken store version: it fails that tool, not the session. A downgrade
therefore loses disables, a registered program stops working until the newer
build is back, and the older build's own session views come back alongside
`tools/`.

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
contract, several installed versions, and a skill per tool. Registering each
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

Nothing runs on the startup path or when a session starts. Bootstrap only
stores paths; the work runs once in an idle task. There is no watcher or scan.
fflate is loaded only when an archive is extracted.

- **Prepare:** reads `state.json`, the preset directory listing and each usable
  tool's `install.json`. Bundled packages are imported only when the directory
  changed; launchers are rewritten only when their `launchKey` changed.
- **Import:** hashing is proportional to the package (tens of MB for the
  tested tools), and extraction is synchronous inside fflate, bounded by the
  limits above. A bundle is read into memory once (its size is checked
  first); a skill-only revision of installed content costs that read and the
  skill write, no package extraction.
- **A change to the usable set:** one `install.json` read per usable tool and
  a launcher write for each changed tool; Apps then reads the skill (the
  stored bundle skill, re-hashed, or the package guide up to 64 KiB) of each
  tool whose skill changed.
- **Management view:** opening it reads, per tool, at most one SKILL.md head
  and one guide head to show the current skill.
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
- A registered program in a non-ASCII folder outside the launcher root keeps
  its absolute path in the `.cmd` launcher and may not start from cmd.exe.
- On Windows a launcher directory in use by a running `.cmd` may not be
  replaceable at once; the tool keeps its earlier launchers until the next
  change or start.
- Windows behavior has unit-test coverage only, until it is verified on a real
  machine.
- Several Halo installations on one computer share the personal skill folder:
  each sees the others' tool skills, which name launchers of the installation
  that wrote them. Run from another installation, such a tool lacks that
  installation's organization access.
- A session that started before a tool was installed lists its skill only once
  the session is rebuilt, like any other new skill.
