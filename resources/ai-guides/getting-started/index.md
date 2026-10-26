# Getting Started — Install, First Run, Updates, and Where Files Live

Last updated: 2026-10-18

Read this whenever the user is installing Halo, stuck on first launch, asking whether Halo
auto-updates, or asking where its config/logs/database files are on disk. This topic has no
companion documents — everything is in this file.

## 1. Concept: one first-run wizard, and no guided tour

Halo 3.0 shows a single first-run wizard before Home (`src/renderer/pages/SetupPage.tsx`):

1. **Windows only, when no Git Bash is found**: **First-time setup required** comes first
   (`src/renderer/pages/GitBashSetupPage.tsx`) with **Auto download and install** (recommended,
   about 50 MB) or **Skip, install manually later**, then **Continue** (§2).
2. **Preferences** (`src/renderer/components/setup/PreferencesStep.tsx`): **Language** and
   **Theme**, then **Continue** ("Step 1 of 2"). Shown only while `config.isFirstLaunch === true`.
3. **Welcome to Halo** / "Select a method to start" (`src/renderer/components/setup/LoginSelector.tsx`).
   The methods are the build's `product.json` `authProviders`, in order: the recommended one as the
   large button, the rest under **Or choose another method**, then **Custom API** (the user's own
   key). Entries flagged `setupHidden` are left out here but stay available in **Settings › AI
   Model** — the official build hides **Claude Code CLI** this way and shows Claude first, then
   Tencent, Kiro, ChatGPT, GitHub Copilot and Custom API. Builds can differ; go by the user's
   screen.
4. **Skip for now** ("Configure your AI later in Settings"): `handleSkipModelConfig()` sets
   `{isFirstLaunch: false, modelConfigSkipped: true}` and opens Home with no AI source. The wizard
   does not come back on the next launch; chat works once a source is added in **Settings › AI
   Model**.

The routing check (`src/renderer/stores/app.store.ts:314,378`) is
`isFirstLaunch || (!hasAnyAISource(aiSources) && !modelConfigSkipped)` → show Setup.
`isFirstLaunch` is cleared when the first source is saved (`components/setup/saveFirstRunSource.ts:46`,
`src/main/services/ai-sources/manager.ts:1132`), when a source is chosen in Settings
(`components/settings/AISourcesSection.tsx:138,144`, which also clears `modelConfigSkipped`), or
by Skip — not by merely viewing the page. An existing user who removes every AI source (and never
skipped) gets the sign-in screen again at the next launch, without the Preferences step
(`SetupPage.tsx:19-22`).

**There is no guided tour in 3.0.** The old 3-step spotlight tour (`halo-space` → `send-message`
→ `view-artifact`, `src/renderer/stores/onboarding.store.ts`) is dormant: nothing calls
`startOnboarding()` (`onboarding.store.ts:62`), so the demo artifact and demo conversation it used
to write never appear. `config.onboarding.completed` still exists but changes nothing the user
sees. Do not tell a user to expect a tour, and do not treat its absence as a fault.

### Data directory: dev vs. production, and per-build isolation

`getHaloDir()` (`src/main/foundation/config.service.ts:933-955`) resolves in this order:
1. `HALO_DATA_DIR` env var (test/CI override).
2. **Unpackaged (dev) run** → `~/.halo-dev`.
3. **Packaged (production)** → `~/.{dataFolderName}`, where `dataFolderName` comes from the
   build's `product.json` (public default: `halo`, i.e. `~/.halo`). A build with a different
   `dataFolderName` gets a fully separate data directory — this is how differently-branded builds
   avoid colliding on one machine; it is not something an end user configures.

## 2. Installation

- **Platforms**: macOS `dmg` + `zip` for arm64 and x64; Windows `nsis` installer, **x64 only**;
  Linux `AppImage`, **x64 only** (`package.json` build targets, lines 291-370). There is no
  Windows-on-ARM or Linux arm64 build.
- **macOS: official builds are Developer ID signed, notarized and stapled.** The tracked
  `package.json` keeps `hardenedRuntime: false, gatekeeperAssess: false, notarize: false`
  (lines 286-290) so anyone can build without Apple credentials; the release build turns signing
  and notarization on at build time (`docs/mac-signing-and-notarization.md`). Someone installing
  the official download sees only the normal "downloaded from the Internet — are you sure you want
  to open it?" prompt. A "cannot verify the developer" / "unidentified developer" block means a
  self-built or unofficial copy: ask where it came from and point to the official download first;
  the standard bypass (Control-click → Open, or System Settings → Privacy & Security → Open Anyway)
  is only for copies the user trusts.
- **Windows: the installer is not code-signed** ("Windows builds carry no code signature",
  `src/main/services/updater/DESIGN.md` §3), so Microsoft Defender SmartScreen may show "Windows
  protected your PC" on first run. **More info → Run anyway** continues. That is expected for the
  official installer, not a sign of a broken download.
- **Windows installer**: `oneClick: false`, lets the user change the install directory, and
  **does not delete app data on uninstall** (`deleteAppDataOnUninstall: false`,
  `package.json:353-360`) — reinstalling after uninstalling preserves `~/.halo` (or the OS
  equivalent) config/spaces/database.
- **Windows also needs Git Bash** for the underlying Claude Code CLI to function.
  `detectGitBash()` (`src/main/services/git-bash/detection.ts:38-89`) checks, in order: an env
  var override, an app-local install under `userData/git-bash/bin/bash.exe`, common system paths
  (`Program Files\Git`, etc.), then `PATH`. If none is found, the first-run page from §1 appears
  (`needsSetup: true`); if the user skips it, a **mock bash mode** is used instead of blocking the
  app — so a missing Git Bash degrades Claude Code CLI functionality on Windows but never hard-
  blocks Halo from launching. A Git Bash installed later is picked up automatically at the next
  check, even after a skip (`resolveGitBashAvailability()`, `detection.ts:112-155`).

## 3. Auto-update

- **Mechanism**: the module `src/main/services/updater/` (`index.ts` schedules; `legacy.ts` drives
  `electron-updater`). Checking and downloading work the same on every OS and do not depend on
  code-signing — **do not tell a user that one platform does not auto-update**. The feed comes
  from the build's `product.json` (`updateConfig`). The one platform difference is how Windows
  *applies* an update: the installer path by default, or a faster "staged" path that a build can
  enable (`updateConfig.windowsMode: "staged"` plus `manifestPublicKey`; `updater/DESIGN.md` §2) —
  the public `product.example.json` does not enable it.
- **Schedule**: checks 5 s after launch, then every hour, and 3 s after resume from sleep;
  automatic checks are throttled to at most one per 5 minutes. **About › Check for updates**
  bypasses the throttle (`index.ts:50-59,287-300`). **Disabled entirely in dev builds.**
- **Behavior**: `autoDownload: true` — updates download silently in the background with no
  prompt. Only *applying* needs action: the user clicks the button in the update toast, or, on the
  installer path, it installs the next time the app quits (`autoInstallOnAppQuit`, turned off on
  the staged path). On the Windows installer path the button is **Install now** and the NSIS
  installer runs; macOS, Linux and staged Windows show **Restart now** and swap the build in place.
- **Toast** (`src/renderer/components/updater/UpdateNotification.tsx`): "New version Halo
  {version} available", the release notes as a markdown list, and **Remind me later**, which
  snoozes that version for 6 hours (`src/renderer/services/update-snooze.ts:11`). A release marked
  `mandatory` in its feed shows "This update is required and cannot be postponed", with no
  snooze and no close.
- **Failure fallback**: if a download/install error occurs after an update was already announced,
  the toast changes to "Could not update automatically — you can download this version manually"
  with **Go to download**, rather than leaving a stuck progress bar — same on every platform.

## 4. Where files live

| What | Path | Source |
|---|---|---|
| Main config | `{haloDir}/config.json` | `getConfigPath()`, `config.service.ts` |
| Spaces | `{haloDir}/spaces/` | `getSpacesDir()` |
| SQLite database | `{haloDir}/halo.db` | `src/main/platform/store/index.ts:53,69-70` |
| Claude CLI-compatible config (skills, MCP, agent settings) | `{userData}/claude-config/` by default (Halo-isolated mode) | `resolveClaudeConfigDir()`, `config.service.ts:985-998` — see §6 |
| Logs | OS default Electron log location (`~/Library/Logs/Halo/` on macOS; `%USERPROFILE%\AppData\Roaming\Halo\logs` on Windows) | `src/main/index.ts:9-16`, via `electron-log`'s own default resolution — not a custom Halo path |

`{haloDir}` is `~/.halo-dev` (dev) or `~/.{dataFolderName}` (production, §1) — not the same as
`{userData}`, which is Electron's own per-app-name directory and is what `claude-config` sits
under by default.

### Moving Halo to another computer

There is no export/import of a whole install; moving means copying folders. Point the user to the
docs page "换电脑迁移 Halo" / "Move Halo to a New Computer" and keep to these facts:

1. Quit Halo on the old computer first (tray icon → **Quit Halo**).
2. Copy **both** `{haloDir}` (config, spaces and conversations, `halo.db`, knowledge bases) and
   `{userData}` (`claude-config`, the browser profile). Without `{userData}`, old conversations still
   display, but continuing one starts a fresh engine session: resume looks up
   `{userData}/claude-config/projects/<working-dir>/<session-id>.jsonl` and starts fresh when it is
   missing (`session-manager.ts`, `migrateSessionIfNeeded`). Also copy any project folders used as
   space working directories.
3. **Same OS, same user name, same project paths.** `spaces-index.json` and each space's
   `meta.json` store absolute paths, so a space whose path does not exist on the new machine shows
   as missing (`isMissing`, `space.service.ts`). Do not suggest hand-editing those files.
4. API keys, email and IM credentials travel in `config.json` (plaintext on the open-source build),
   so warn the user to keep the copy private. Sign-ins that do **not** travel: websites logged in to
   in the built-in browser (cookies are bound to the machine) and the Claude Code CLI-delegated
   source on macOS (its credentials live in the system keychain).
5. Do not run both computers with the same setup: one WeCom bot is active on one device at a time,
   a Feishu bot splits messages between both connections, and the permanent remote-access address
   follows `deviceIdentity` in `config.json` to the new machine.
6. To move a single digital human instead: digital human → **More** (更多) → **Share** (分享) →
   **Export** (导出) a `.dhpkg`, then on the new computer **My Digital Humans** (我的数字人) →
   **Create Digital Human** (创建数字人) → **Import** (导入). The package carries the spec and its
   bundled skills — not conversations, memory, knowledge base contents or IM channel bindings.

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
  (`src/main/services/health/orchestrator.ts:109-115`). Health monitoring is event-driven at
  runtime, plus whatever the user triggers manually from Settings — **don't tell a user Halo
  scans for problems automatically on every launch; it doesn't, by design.**
- **Manual "Run Diagnostics"** collects: config summary (provider, whether an API key is present,
  MCP server count), process/orphan status, recent errors, and system info (memory/uptime) —
  sanitized before display/export (`src/main/services/health/diagnostics/collector.ts`).
- **Recovery buttons** map to fixed escalation tiers: **Reset AI Engine** (no confirmation needed,
  auto-triggers after 3 consecutive agent errors) and **Restart App** (requires confirmation,
  auto-triggers after 5 consecutive errors; errors count within a 60 s window) — both exposed in
  Settings → System, and both correspond 1:1 to backend recovery strategies S2/S3
  (`src/main/services/health/recovery-manager/strategies.ts:16-83`).
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
| macOS says the app is from an "unidentified developer" / "cannot verify the developer" | Not the official download: official builds are notarized (§2) | Ask where the copy came from and suggest the official download; the Control-click → Open bypass is only for a copy the user trusts |
| Windows: "Windows protected your PC" when running the installer | The official installer is not code-signed (§2) | Expected — **More info → Run anyway**; not a corrupted download |
| App reaches Home with no AI provider configured, chat doesn't work | User clicked **Skip for now** on the sign-in screen | Not a crash — `modelConfigSkipped` is a legitimate state; add a source in **Settings › AI Model** whenever ready |
| Windows: Claude Code CLI features misbehave | Git Bash not found and setup was skipped | Falls back to a mock-bash mode rather than blocking the app (§2) — the real fix is installing/pointing Halo at a real Git Bash, not restarting |
| Local server / remote access seems to bind an unexpected port | The HTTP server auto-retries on `EADDRINUSE` by trying the next port | This is silent and automatic (`src/main/http/server.ts:424-433`) — not an error state; see `remote-access/index.md` §7 for the exact retry mechanics |
| `config.json` seems to have "reverted" to defaults after a crash | The file was corrupted; Halo refused to overwrite it and ran on in-memory defaults instead (§4) | The original corrupted file is still on disk, untouched — recoverable by inspecting it, not silently lost |
| App still opens after what looked like a database problem | `halo.db` corruption is auto-detected and the file is quarantined + rebuilt automatically (§4) | Expect a fresh, empty database in that case — the corrupted file is renamed with a `.corrupt.{timestamp}` suffix, not deleted |
| Sign-in screen reappears on a later launch | No AI source is left and Skip was never used — the routing check in §1 | Sign in again, or **Skip for now**; the Preferences step does not repeat. `config.onboarding.completed` plays no part — there is no tour in 3.0 |

## 8. Never ask / never tell the user

- **Don't say one platform does not auto-update** (e.g. "Mac doesn't auto-check because it isn't
  signed"). Checking and downloading are identical on every platform (§3); the feed is a build
  setting, and only the way Windows applies a downloaded update differs.
- **Don't tell a macOS user that a Gatekeeper "unidentified developer" warning is normal for
  Halo,** or a Windows user that SmartScreen means the download is broken. Official macOS builds
  are notarized; the Windows installer is unsigned (§2).
- **Don't promise a guided tour or demo conversation after setup.** 3.0 does not start one (§1).
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
