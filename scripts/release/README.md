# Release Verification System

Production builds (any brand variant) must be reproducible, traceable, and
fail loudly when a build input is missing. This directory holds the
variant-agnostic half of that system; each private variant repo holds its own
declaration files. The public repo never references any variant by name.

## Principles

1. **One declaration, two gates.** Every build input a variant needs is
   declared once in that variant's `build-manifest.json`. `verify-inputs`
   asserts the declarations before the build; `verify-artifact` asserts them
   inside the produced packages after the build. Adding a new build input =
   one edit to the manifest; both gates cover it automatically.
2. **Missing blocks, change confirms.** A missing input always aborts and can
   not be overridden. A *change* relative to the last successful release is
   classified by the manifest's `sensitiveFields`: sensitive diffs require
   explicit confirmation, routine diffs are printed only.
3. **Config follows git, secrets follow the environment.** Everything that
   ships inside the package (product.json including telemetry/analytics
   values) lives committed in the variant repo. Only true secrets (publish
   tokens, signing credentials) come from the environment — validated by name
   against `requiredEnv`, never silently defaulted.
4. **The build record is the lock.** Every build writes a `build-record.json`
   capturing the exact SHAs of every participating repo, the product.json
   hash, the mode, and the check results. Release artifacts ship with their
   record; reproducing a build = checking out the recorded SHAs.
5. **Release mode reads no dirty state.** In `--mode release` every
   participating repo must be clean and pushed. In `--mode dev` dirty state
   is allowed but the record is marked `dirty` and publish must not happen.

## Files

| File | Where | Role |
|---|---|---|
| `verify-inputs.mjs` | this repo | Pre-build gate (git state, env, product fields, engines, binaries, baseline diff) |
| `verify-artifact.mjs` | this repo | Post-build gate (asar contents, artifact list, update ymls) + finalizes the record |
| `lib.mjs` | this repo | Shared helpers (manifest, git, hash, asar, diff report) |
| `build-manifest.json` | variant repo | The single declaration of that variant's build inputs |
| `last-release-record.json` | variant repo | Baseline for diffing; updated after each successful release |
| `dist/build-record.json` | build output | Per-build record (lock + audit trail) |

## build-manifest.json shape

```jsonc
{
  "variant": "myvariant",              // free label, goes into the record
  "product": "product.myvariant.json",// path relative to the manifest file
  "requiredEnv": ["GH_TOKEN"],         // must exist AND be non-empty
  "requiredEngines": ["anthropic", "halo", "codex"],
  "requiredProductFields": [           // dot-paths into product.json, must be non-empty
    "updateConfig.provider",
    "analytics.ga.measurementId"
  ],
  "sensitiveFields": [                 // diff vs baseline in these requires confirmation
    "product:authProviders",           //   product:<dot-path> → inside product.json
    "product:telemetry",
    "requiredEngines",                 //   bare key → manifest/record top-level
    "sdkVersion"
  ],
  "expectedArtifacts": {               // keyed by platform id; {version} substituted
    "mac-arm64": ["{productName}-{version}-arm64.dmg", "{productName}-{version}-arm64-mac.zip", "latest-mac.yml"],
    "win":       ["{productName} Setup {version}.exe", "latest.yml"]
  },
  "repos": {                           // repos whose git state is checked & recorded
    "main": "../hello-halo",           //   paths relative to the manifest file
    "variant": "."
  }
}
```

## CLI

```bash
# Before the build (from anywhere; paths resolved against the manifest):
node scripts/release/verify-inputs.mjs \
  --manifest <variant>/build-manifest.json \
  --mode release|dev \
  [--baseline <variant>/last-release-record.json] \
  [--record dist/build-record.json] \
  [--confirm-sensitive]     # non-TTY acknowledgment (CI approval step / operator flag)

# After the build:
node scripts/release/verify-artifact.mjs \
  --manifest <variant>/build-manifest.json \
  --record dist/build-record.json \
  --platforms mac-arm64,mac-x64,win,linux
```

Exit codes: `0` all green · `1` missing/hard failure · `2` unconfirmed
sensitive diff (rerun with confirmation after review).

## What each gate checks

`verify-inputs` (nothing has been compiled yet — failing here costs zero):

1. Git state of every repo in `repos`: release → clean + pushed, dev → dirty
   allowed, recorded as `dirty` with a diff summary.
2. `requiredEnv`: every key present and non-empty (names are printed, values
   never are).
3. product.json: parses, schema-level required fields, every
   `requiredProductFields` dot-path non-empty. Its sha256 is recorded.
4. Engines + binaries via `tests/check/binaries.mjs --require-engines`.
5. Baseline diff vs `last-release-record.json` → three-tier report
   (missing = abort · sensitive = confirm · routine = print).
6. Writes `build-record.json` (mode, SHAs, hashes, env key names, versions).

`verify-artifact` (runs against `dist/` after all platforms are packed):

1. Every unpacked app (`dist/mac*`, `dist/*-unpacked`) contains in its asar:
   `product.json` with the recorded hash, every `requiredProductFields`
   non-empty, every required engine directory.
2. Every `expectedArtifacts` entry for the built platforms exists on disk;
   `latest*.yml` files parse and their `version` matches `package.json`.
3. Finalizes `build-record.json` with per-check results. Release flows upload
   it next to the artifacts and copy it into the variant repo as
   `last-release-record.json` (the next build's baseline).

## Telemetry / analytics configuration

Telemetry and analytics identifiers ship inside the package and are readable
by any user — they are configuration, not secrets. They live in
`product.json` (`analytics.ga`, `analytics.baidu`, `telemetry.endpoint`,
`telemetry.apiKey`) and are read at runtime by the analytics service. There
is deliberately **no build-time env injection** for them: a missing value is
a missing product field caught by gate 3, not a silently-empty constant.
Open-source builds omit both blocks entirely → all providers disabled.
