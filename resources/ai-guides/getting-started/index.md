# Getting Started — Install, First Run, Updates, and Where Files Live

Last updated: 2026-09-03

Read this whenever the user is installing Halo, stuck on first launch, asking whether Halo
auto-updates, or asking where its config/logs/database files are on disk. This topic has no
companion documents — everything is in this file.

## 1. Concept: two independent first-run gates, not one linear wizard

Halo has **two separate, independently-gated first-run mechanisms** — don't describe them as one
flow:

- **AI provider Setup wizard** (`src/renderer/pages/SetupPage.tsx`) — gated by
  `config.isFirstLaunch === true`. Steps: pick an auth method (Claude OAuth, GitHub Copilot,
  custom API key) → provider-specific login/config. It has an undocumented **Skip** path
  (`handleSkipModelConfig()` sets `{isFirstLaunch: false, modelConfigSkipped: true}`) — a user can
  reach Home with zero AI providers configured. The routing check
  (`src/renderer/App.tsx:923`) is: `isFirstLaunch || (!hasAnyAISource && !modelConfigSkipped)` →
  show Setup. `isFirstLaunch` is cleared once a provider is actually added
  (`src/main/services/ai-sources/manager.ts:787,857`), not by merely viewing the page.
- **3-step guided tour** (`src/renderer/stores/onboarding.store.ts`) — `halo-space` →
  `send-message` → `view-artifact` → `completed`, tracked independently in
  `config.onboarding.completed`. Backed by `src/main/services/onboarding.service.ts`, which writes
  a demo artifact and a demo welcome conversation on first Home visit.

A user can have finished one and not the other (e.g. skipped AI setup but still sees the tour, or
configured a provider from Settings later without ever seeing the tour). When diagnosing "why does
Halo keep showing onboarding," check both flags, not just one.

### Data directory: dev vs. production, and per-build isolation

`getHaloDir()` (`src/main/foundation/config.service.ts`, ~lines 798-834) resolves in this order:
1. `HALO_DATA_DIR` env var (test/CI override).
2. **Unpackaged (dev) run** → `~/.halo-dev`.
3. **Packaged (production)** → `~/.{dataFolderName}`, where `dataFolderName` comes from the
   build's `product.json` (public default: `halo`, i.e. `~/.halo`). A build with a different
   `dataFolderName` gets a fully separate data directory — this is how differently-branded builds
   avoid colliding on one machine; it is not something an end user configures.

## 2. Installation

- **Platforms**: macOS (`dmg`+`zip`, arm64 and x64) and Windows (`nsis` installer, x64) are the
  primary distributions; a Linux `AppImage` (x64) also exists (`package.json` build config,
  `electron-builder.cjs`).
- **macOS is not notarized** (`hardenedRuntime: false, gatekeeperAssess: false, notarize: false`,
  `package.json:239-243`) — Gatekeeper's "can't verify developer" warning on first open is
  expected, not a sign of a broken download. The fix is the standard macOS bypass (right-click →
  Open, or System Settings → Privacy & Security → "Open Anyway"), not something Halo can suppress
  from inside the app.
- **Windows installer**: `oneClick: false`, lets the user change the install directory, and
  **does not delete app data on uninstall** (`deleteAppDataOnUninstall: false`,
  `package.json:302-309`) — reinstalling after uninstalling preserves `~/.halo` (or the OS
  equivalent) config/spaces/database.
- **Windows also needs Git Bash** for the underlying Claude Code CLI to function.
  `detectGitBash()` (`src/main/services/git-bash/detection.ts:38-89`) checks, in order: an env
  var override, an app-local install under `userData/git-bash/bin/bash.exe`, common system paths
  (`Program Files\Git`, etc.), then `PATH`. If none is found, the app surfaces a setup prompt
  (`needsSetup: true`); if the user skips it, a **mock bash mode** is used instead of blocking the
  app — so a missing Git Bash degrades Claude Code CLI functionality on Windows but never hard-
  blocks Halo from launching.

## 3. Auto-update

- **Mechanism**: `electron-updater`, driven by `src/main/services/updater.service.ts`. Identical
  logic on every OS — **do not tell a user updates work differently on Windows vs. macOS**; what
  actually varies is only the *provider* configured in the build's `product.json`
  (`updateConfig.provider`), never the platform or code-signing status.
- **Schedule**: checks 5s after launch, then every hour, plus a check on resume-from-sleep and on
  manual "Check for Updates" — all throttled to at most once per 5 minutes. **Disabled entirely in
  dev builds.**
- **Behavior**: `autoDownload: true` — updates download silently in the background on all
  platforms with no prompt. Only *installing* requires action: either the user confirms
  "Install now" in the update toast, or it installs automatically the next time the app quits
  (`autoInstallOnAppQuit: true`). Windows runs the NSIS installer UI on install; macOS/Linux swap
  the build in place and relaunch.
- **Changelog**: shown in a sticky in-app toast (`src/renderer/components/updater/UpdateNotification.tsx`)
  as rendered markdown release notes, with an "Install now" action and a per-version "Don't remind
  me today" snooze.
- **Failure fallback**: if a download/install error occurs after an update was already announced,
  Halo falls back to showing a direct download-page link rather than leaving a stuck progress bar
  — same behavior on every platform.

## 4. Where files live

| What | Path | Source |
|---|---|---|
| Main config | `{haloDir}/config.json` | `getConfigPath()`, `config.service.ts` |
| Spaces | `{haloDir}/spaces/` | `getSpacesDir()` |
| SQLite database | `{haloDir}/halo.db` | `src/main/platform/store/index.ts:49,66` |
| Claude CLI-compatible config (skills, MCP, agent settings) | `{userData}/claude-config/` by default (Halo-isolated mode) | `resolveClaudeConfigDir()`, `config.service.ts:843-856` — see §6 |
| Logs | OS default Electron log location (`~/Library/Logs/Halo/` on macOS; `%USERPROFILE%\AppData\Roaming\Halo\logs` on Windows) | `src/main/index.ts:6-24`, via `electron-log`'s own default resolution — not a custom Halo path |

`{haloDir}` is `~/.halo-dev` (dev) or `~/.{dataFolderName}` (production, §1) — not the same as
`{userData}`, which is Electron's own per-app-name directory and is what `claude-config` sits
under by default.

**Config writes are atomic and crash-safe**: `saveConfig()` writes to `config.json.tmp` then
renames over the real file — never a "half-written config" state. If `config.json` is corrupt at
startup, Halo does **not** try to overwrite it — it runs on in-memory defaults and leaves the
broken file on disk untouched, so a corrupted config is recoverable/inspectable rather than
silently destroyed.

**Database corruption is also self-healing**: if `halo.db` fails to open with a corruption error
(`SQLITE_CORRUPT`, "database disk image is malformed", etc.), Halo renames it (and its `-wal`/
`-shm` siblings) to `halo.db.corrupt.{timestamp}` and creates a fresh database automatically —
the app always starts (`src/main/platform/store/database-manager.ts`, `openDatabase()`).

## 5. Health checks & diagnostics (Settings → System Diagnostics)

- **Startup health checks are deliberately disabled**, not a bug: the orchestrator's own code
  comment states *"Startup checks disabled — waste CPU/time for diagnostics that don't trigger
  recovery. Issues are caught naturally when they matter"*
  (`src/main/services/health/orchestrator.ts:107-114`). Health monitoring is event-driven at
  runtime, plus whatever the user triggers manually from Settings — **don't tell a user Halo
  scans for problems automatically on every launch; it doesn't, by design.**
- **Manual "Run Diagnostics"** collects: config summary (provider, whether an API key is present,
  MCP server count), process/orphan status, recent errors, and system info (memory/uptime) —
  sanitized before display/export (`src/main/services/health/diagnostics/collector.ts`).
- **Recovery buttons** map to fixed escalation tiers: **Reset AI Engine** (no confirmation needed,
  auto-triggers after 3 consecutive agent errors) and **Restart App** (requires confirmation,
  auto-triggers after 5 consecutive errors) — both exposed in Settings → System, and both
  correspond 1:1 to backend recovery strategies S2/S3
  (`src/main/services/health/recovery-manager/strategies.ts:16-70`).
- **Copy Report / Export Report** buttons produce the same sanitized diagnostic JSON described
  above — this is the artifact to ask for when debugging a report from a user, rather than asking
  them to describe symptoms from memory.

## 6. Claude CLI coexistence (`configDirMode`)

Settings → Advanced → "Claude CLI Integration" (`src/renderer/components/settings/CLIConfigSection.tsx`)
lets a user choose where Halo reads skills/MCP/agent config from:

| Mode | Path | Notes |
|---|---|---|
| `halo` (default) | `{userData}/claude-config/` | Isolated from any standalone Claude Code CLI install — recommended |
| `cc` | `~/.claude` | Shares config with a standalone Claude CLI install — the UI itself labels this **"High Risk" / "Not Recommended"** and warns that a custom API key/endpoint in the standalone CLI's config **takes priority over Halo's own model selection and can break chat** |
| `custom` | user-specified path | |

There is also an active, guided **migration tool** (not just a path comparison): "Migrate Skills
from Claude CLI" scans `~/.claude/skills/` and "Migrate MCP Servers from Claude CLI" scans
`~/.claude.json`, each with per-item conflict resolution (skip / overwrite / rename) before
importing into Halo's own config location. See `skills-and-mcp/index.md` for what happens to
skills/MCP servers once installed.

## 7. Diagnostics — common first-run problems

| Symptom | Cause | What actually happens |
|---|---|---|
| macOS says the app is from an "unidentified developer" | No notarization (§2) | Expected — right-click → Open, or allow it in System Settings → Privacy & Security; not a corrupted download |
| App reaches Home with no AI provider configured, chat doesn't work | User hit **Skip** in the Setup wizard | Not a crash — `modelConfigSkipped` is a legitimate state; add a provider from Settings → AI Sources whenever ready |
| Windows: Claude Code CLI features misbehave | Git Bash not found and setup was skipped | Falls back to a mock-bash mode rather than blocking the app (§2) — the real fix is installing/pointing Halo at a real Git Bash, not restarting |
| Local server / remote access seems to bind an unexpected port | The HTTP server auto-retries on `EADDRINUSE` by trying the next port | This is silent and automatic (`src/main/http/server.ts:392-402`) — not an error state; see `remote-access/index.md` §7 for the exact retry mechanics |
| `config.json` seems to have "reverted" to defaults after a crash | The file was corrupted; Halo refused to overwrite it and ran on in-memory defaults instead (§4) | The original corrupted file is still on disk, untouched — recoverable by inspecting it, not silently lost |
| App still opens after what looked like a database problem | `halo.db` corruption is auto-detected and the file is quarantined + rebuilt automatically (§4) | Expect a fresh, empty database in that case — the corrupted file is renamed with a `.corrupt.{timestamp}` suffix, not deleted |
| Onboarding tour or Setup wizard reappears unexpectedly | Two separate flags control this (§1) — check both `config.isFirstLaunch`/`modelConfigSkipped` and `config.onboarding.completed`, not just one | |

## 8. Never ask / never tell the user

- **Don't say updates behave differently on Windows vs. macOS** (e.g. "Mac doesn't auto-check
  because it isn't signed"). They don't — the mechanism and schedule are identical on every
  platform (§3); what differs is a build-time server config, not the OS.
- **Don't tell a user Halo scans for problems automatically at startup.** It explicitly does not,
  by design (§5) — diagnostics are manual (Settings → System Diagnostics) or event-driven at
  runtime, never a startup scan.
- **Don't ask the user to manually back up or move `config.json`/`halo.db` before troubleshooting.**
  Both have automatic corruption recovery built in (§4) — manual file surgery is rarely necessary
  and risks losing the "recoverable, untouched" corrupted file that would otherwise help diagnose
  the actual cause.
- **Don't suggest switching Claude CLI config mode to `cc` (shared with a standalone CLI
  install) to "simplify things."** The UI itself flags this as high-risk because a standalone
  CLI's own API key/endpoint config can silently override Halo's model selection (§6) — only
  suggest it if the user explicitly wants config sharing and understands that risk.
- **Don't treat a missing Git Bash on Windows as a hard blocker requiring immediate action.**
  Halo degrades gracefully (mock-bash mode) rather than failing to launch (§2) — surface it as a
  "some Claude Code CLI features may not work" note, not an emergency.
- **Don't assume `{haloDir}` and `{userData}` (where `claude-config` lives) are the same
  directory.** They resolve independently (§1, §4) — conflating them will give a user the wrong
  path when they're looking for config vs. skills/MCP files.
