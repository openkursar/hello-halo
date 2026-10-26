# External Claude Code runtime

## Boundary

This service owns discovering, checking, selecting and explicitly installing an
external Claude Code executable. It depends on foundation configuration and the
public proxy-fetch utility. It never imports the agent service. Agent adapters
consume only `index.ts`; renderer-safe contracts live in `shared/types/cc-runtime`.
This boundary keeps external distribution concerns out of the engine adapter.

There is no bundled executable, automatic download, startup scan, filesystem
watcher or background upgrade. Migration may explicitly request one bounded scan.
Ordinary launch resolution examines only the saved selection with an eight-second
total deadline that aborts the probe process. Manual checks allow twenty seconds
per stage. User-owned files are never modified; environment overrides affect only
the child process.

## Compatibility

Each candidate must report a Claude Code version and complete the stream-json
initialize, permission-mode, queued-message cancellation and thinking-limit control
exchange in an isolated temporary working and configuration directory. No prompt,
user settings, credentials or MCP servers
are supplied. Detection does not make a model request. Time and output are bounded,
and the child is terminated and its temporary directory removed on every outcome.

`verified` means an exact version, platform, architecture and distribution in the
maintained regression list passed the local probe. `compatible` means the local protocol probe passed, without claiming
full behavioral verification. A version outside the recommendation can still be
selected. An explicit protocol failure is `incompatible`; missing files and
operational failures are `unavailable`, so a timeout is never misreported as a
proven version incompatibility. Rechecks are user-triggered; launch checks reuse a
24-entry LRU keyed by launcher target and file stamps. Failures expire after 30 s.
At most three probes run concurrently, with a maximum of 24 queued checks.
Bootstrap cleanup calls `shutdownCcRuntime` to abort downloads and active/queued
probes; no child process or transfer survives application shutdown.

The reviewed range is `>=2.1.89 <2.2.0`; the default installation is pinned to
`2.1.310`. Exact regression baselines are `2.1.89` and `2.1.310`. Both native
releases passed stream-json, permission, hook, live-input and resume regressions
on macOS arm64; `2.1.89` also passed the legacy JavaScript path. A range match
alone never grants `verified`. Updating this policy is a deliberate maintenance
change after running the real-runtime tests, not an automatic check of `latest`.

Probes override home, XDG and Windows application-data directories, disable hooks
and nonessential traffic, and point API/proxy endpoints at loopback port 9. These
are process configuration boundaries, not an OS sandbox for an arbitrary program;
only inspect executables the user selected or recognized CC installation paths.

## Discovery and persistence

Discovery considers selected and managed paths, bounded PATH entries, common
native/npm locations, and a bounded set of installed Node version directories.
It never recurses through user data. A directory chosen by the user is resolved
against a small list of recognized binary/package layouts. Symlinks retain the
user-facing launcher path but resolve to a stamped target for process creation.
The explicit migration helper has an eight-second total deadline and stops at
the first compatible installation; it never selects after cancellation. Its
caller persists `discoveryCompleted` so an unsuccessful migration does not scan
again at every launch. Settings discovery remains an explicit user action.
Settings discovery has a twelve-second total deadline and returns completed
checks with `truncated: true` on timeout. The deadline aborts real probe children;
an uncancellable filesystem lookup cannot hold the response and cannot launch
more probes after it eventually returns.

`agent.ccRuntime` stores the chosen launcher and download preferences. Selecting
requires a successful probe and a persisted config readback. Choosing a new runtime
does not interrupt existing sessions. Migration and engine fallback are owned by
their callers, not this service.

## Installed runtime catalog

The module owns one versioned `catalog.json` under its private runtime directory.
It retains at most 64 recently added/used installations, keeps the selected entry,
and exposes bounded snapshots through status. Explicit successful local checks,
selection and managed installation update the catalog atomically. No executable
is deleted by catalog eviction. Records include the last compatibility result;
using a record still validates the current file rather than trusting its label.
Health updates replace old issues on success and preserve managed ownership,
install provenance and checksum anchors when a file is missing or not executable.
Checks recorded on another platform/architecture are shown as `unchecked`.

The first catalog read loads at most 128 KiB. If no catalog exists, a one-time
index considers at most 512 entries and 64 recognized version directories in
Halo's own runtime folder. It reads names and file metadata, never hashes or
executes binaries, and marks imported entries `unchecked`. It also preserves a
previously selected local path without scanning that user's directory. A fresh
profile with no runtime directory pays a failed stat/read and creates no folder.
Later settings reads use this single in-memory catalog; there is no watcher,
startup scan, subprocess or large-file hash on the settings read path.

An exact managed version previously validated against the same normalized source
URL is checked locally before any network request: verify its recorded SHA256,
then its required interfaces. Successful reuse makes no binary or metadata request.
A changed source, a legacy entry without source provenance, and channel names
first resolve small release metadata; reuse then requires the full matching
checksum. A legacy directory's checksum prefix is also checked and upgraded to the
full checksum after validation. Explicitly using an inventory path remains local
and does not consult the selected download source. Corrupt entries
never become successful installations; download may repair them into a new
immutable directory while retaining a file any existing session could still use.

## Release lookup

`lookupCcRelease` reads only the version pointer and manifest for the requested
source and platform. It does not install or probe anything. A 12-second deadline,
128-KiB metadata limit, five redirect hops and a 32-entry, short-lived LRU bound
the work. Cache identity includes the normalized source URL, requested version
and platform, so switching a mirror cannot reuse another source's metadata.
The result distinguishes syntax errors, a missing release (404), unreachable
source, timeout, authorization rejection, invalid manifest and absent platform.
Checksums and source identity remain available for the install operation; an
`installedPath` is inventory evidence, not a fresh executable health guarantee.
Status exposes `recommendedVersion` separately from the user's last
`installVersion`, so trying another release never changes the recommended action.

## Managed installation

A download source is an HTTP(S) base URL with Anthropic's public layout:
`<base>/<version>/manifest.json` with `platforms[platform].checksum`, and
`<base>/<version>/<platform>/claude` (`claude.exe` on Windows). `latest` and `stable`
are optional text version pointers. A private mirror uses the same declarative
layout; no script from the server is executed. Source URLs must not embed secrets.
HTTP is allowed for explicitly configured intranet sources. Redirects are capped
at five hops, reject credentials and non-HTTP(S) schemes, and never downgrade an
HTTPS source to HTTP. Cross-host HTTPS redirects support storage/CDN downloads.

The binary streams through the existing proxy-aware fetch into an exclusive
staging directory under Halo's own runtime directory, with SHA256 and size limits.
Only a verified checksum and successful interface probe permit atomic publication
into a version/platform/content-addressed directory. Selection changes after
publication and persistence verification. Failed or cancelled installs preserve
the previous selection. Old versions remain available for existing sessions and
rollback; the service never mutates a published binary.

Only one install runs at a time. Its bounded in-memory progress is read by settings
while an install is active; cancellation aborts fetch and probe, then cleans up.
Progress updates do not create per-chunk logs. Start, phase failures and terminal
outcomes are logged once without download URLs, user settings or process output.

Distribution evidence: https://code.claude.com/docs/en/setup and the read-only
installer source at https://claude.ai/install.sh (checked 2026-10-25). The native
release base is https://downloads.claude.ai/claude-code-releases. Private mirrors
must preserve the platform manifest and matching artifact checksum.

## Settings and user intent

The settings UI nests installation management inside the Claude Code engine card.
It shows the bounded catalog first, then a recommended release, with other
versions, download sources and local discovery behind separate disclosures.
A custom version is checked against release metadata before download. Errors use
typed RPC issue codes so invalid input, missing releases and network failures
remain distinct without parsing process error text in the renderer.

Controllers own activating Claude Code after a successful selection or install.
Source preferences travel with an install request so activation intent is captured
before any asynchronous preparation. Explicit user engine choices, including
selecting the already selected engine, supersede an earlier pending install.
Desktop and remote configuration writes share this rule through `updateConfig`;
each transport retains its existing response masking. Closing settings does not
cancel an install or discard its intent. A later runtime selection also wins over
a pending download. Selecting another CC version affects new sessions; only an
engine change requires an application restart.

## Periodic compatibility review

Keep routine tests offline. To review another release, first obtain its native
artifact from the intended source and verify its manifest checksum. Run the
opt-in checks against that exact artifact:

```sh
HALO_TEST_CC_PATH=/path/to/claude npm run test:unit -- tests/unit/services/cc-runtime-probe.test.ts
CC_E2E=1 CC_TEST_CLI=/path/to/claude npm run test:unit -- tests/unit/services/agent/cc-live-input-e2e.test.ts
```

The first command checks the real executable's version and protocol. The second uses a local scripted
Messages API to cover actual engine behavior without a paid model request.
Only then change `policy.ts`'s exact verified list or recommended installation.
Document the tested platforms; do not imply cross-platform execution was tested
when only the transport and layout tests ran elsewhere.
