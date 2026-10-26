# Halo Experimental: default engine and optional Claude Code

Halo SDK is the default engine and is included in the application. Claude Code
and the upstream Claude Agent SDK are not included. The application never
downloads Claude Code automatically. Codex and dsh retain their existing roles.

## Installation and isolation

The experimental application has its own name, application identifier, data
directory, browser profile and deep-link scheme. It can run beside the regular
application. Automatic updates are disabled and no production update feed is
packaged. Installing it does not import the production profile or activate a
second copy of existing automations.

To prepare a variant from the configured product and build a local macOS installer:

```sh
npm run product:experimental
npm run build:experimental -- --arm64
```

The build writes DMG and ZIP artifacts under `dist/experimental`. It does not
publish, bump the production package version or use release signing credentials.
`npm run install:experimental` installs only the explicitly named experimental
application. The existing build prerequisites, including the independent Halo
SDK package under `src/sdk/halo-sdk`, still apply.

## Choosing Claude Code

Open Settings → Advanced → Claude Code. Its setup opens inside the engine card:

- **Connect local installation:** scan common locations or use the single local
  picker. The platform chooses files/folders as appropriate; manual paths remain
  under a disclosure. Halo checks it before selection. User-owned
  installations are never patched, upgraded or uninstalled by Halo.
- **Install online:** choose a source and version, then install explicitly.
  The download is checked before an atomic publication into Halo's private
  runtime directory. Failed or cancelled installs keep the previous selection.

Changing the default engine requires no restart. It applies to newly created
conversations; existing conversations retain their own engine. A newer engine
choice made during a download is preserved when that download finishes.

A conversation's model menu offers an Advanced engine selector. Digital humans
have their own selector under Advanced settings. Both explain context and
resource implications before confirmation. A running task keeps its current
engine; the requested change applies at a safe subsequent turn. Compatible
accounts/models remain separate choices, and a CC-delegated account requires CC.
Codex accepts OpenAI-compatible Chat Completions or Responses accounts. Known
incompatible combinations are refused before saving; an account whose protocol
is not yet available may be selected offline, then must pass the runtime check.
Halo never substitutes another model or another account to make a selection work.

Native session ownership is recorded independently of the default. When a native
session cannot be reused across engines, Halo prepares a new session with visible
history, task goals, completed results and references. Original records remain
available, and a long handoff explicitly identifies omitted records. Engine
internal state and running tools are not transplanted. Returning to a prior
engine carries the intervening work rather than restoring an outdated session.
Multiple engines load only when used, share the resident-session budget, and
release unused non-default shared resources after their last session closes.
Messages awaiting redelivery retain their local record identities. A handoff
excludes those pending records until their own delivery, and keeps withdrawn
inputs marked as withdrawn. Identical text in an older message is still history.
Halo and CC support the currently enforced team permission/audit requirements;
other engines may reject collaboration modes their adapters cannot enforce.

## Compatibility and download mirrors

The recommendation is maintained periodically; it is not an automatic promise
to support each upstream release. The initial range is `>=2.1.89 <2.2.0`, with
exact regressions for `2.1.89` and `2.1.310`. The default download is pinned to
`2.1.310`. Users may request another version, `stable` or `latest` explicitly.

Every local or downloaded candidate must pass the same process and protocol
checks, without a model request or user credentials. A verified version is an
exact version in Halo's regression list that also passed the local check.
An interface check on another version permits trying it, without claiming full
compatibility. A timeout is reported as unavailable, not as proven incompatibility.

Internal mirrors use the same layout as the official release source:

```text
<base>/<version>/manifest.json
<base>/<version>/<platform>/claude
<base>/<version>/win32-x64/claude.exe
```

The manifest supplies `platforms[platform].checksum` as SHA256. Optional `stable`
and `latest` text files contain version numbers. Configure an HTTP(S) base URL in
the download panel. Source URLs cannot embed credentials; existing Halo proxy
settings apply. The installer downloads data and never executes a remote shell
installer. Use a trusted source: checksums establish consistency with its manifest.

## Existing users and history

An absent engine preference now means Halo SDK. Explicit engine choices remain
intact. An old explicit CC preference without a selected external installation
gets one bounded local discovery attempt. If CC is unavailable, Halo SDK runs
and a visible notice explains how to reconnect CC.

Existing CC and Halo transcripts retain their legacy working-directory migration
behavior. Once a session has explicit engine ownership, native resume uses only
that engine's current record; a missing native file triggers a visible-history
handoff instead of restoring an older archive. Original files remain intact.
Running tools are not transferred between engines.

A Claude Code delegated account authenticates through CC itself. Its credentials
cannot be converted to another engine's API key. Such accounts are preserved and
the chat shows the recovery path before sending: connect CC, or choose another
AI source. Halo does not silently switch accounts or billing sources.

## Verification

The change includes focused runtime, adapter, migration, configuration and
packaging tests. Real CC regression uses an explicit external executable:

```sh
CC_E2E=1 CC_TEST_CLI=/path/to/claude npm run test:unit -- tests/unit/services/agent/cc-live-input-e2e.test.ts
```

Before distributing a build, verify default startup, local runtime selection,
online installation, mobile layout, existing conversation history and
delegated-account recovery in the packaged application. Inspect the packaged
contents to confirm Claude Code is absent; a source build alone does not verify
the distribution.
