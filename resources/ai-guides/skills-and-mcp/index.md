# Skills & MCP — Installing, Scoping, and Authoring

Last updated: 2026-09-03

Read this whenever the user wants to install/write a skill or MCP server, asks why a skill/tool
isn't showing up in a conversation or digital human, or confuses "skill" with "MCP server". This
topic has no companion documents — everything is in this file. For how a digital human *declares*
a dependency on a skill/MCP inside its own App Spec, see `create-digital-human/spec-reference.md`
(companion of `create-digital-human/SKILL.md`) — this document covers the install/scope mechanism
itself, that one covers the spec syntax.

## 1. Concept: two different kinds of installed thing, one scope model

- **Skill** — a `SKILL.md` file (+ optional companion files) that becomes part of an agent's
  instructions/context. `AppTypeSchema` includes `'skill'` as one of four app types
  (`src/main/apps/spec/schema.ts:66`). A skill has no runtime process — it's read as text.
- **MCP server** — an external tool-providing process/endpoint (`stdio`, `sse`, or
  `streamable-http`) that gets spawned/connected and exposes callable tools. Schema:
  `McpServerConfigSchema` (`schema.ts:268-281`).

Both are installed the same way (see §2) and follow the **same scope rule** everywhere in the
codebase: **`spaceId: null` = global; `spaceId: <uuid>` = space-scoped, and a space-scoped item
overrides a global one that shares the same identifier.** This is implemented independently at
the filesystem layer for skills (`src/main/apps/skill-discovery.ts:83-87`) and at the database
layer for both types (`listEffectiveByType()`, `src/main/apps/manager/service.ts:282-295`, with
thin wrappers `listEffectiveMcpApps()`/`listEffectiveSkillApps()` at lines 944-950).

**A real asymmetry between the two once scope is resolved:** access to *user-installed* MCP
servers is least-privilege and declared for scheduled/triggered automation runs (only the ones
listed in the app's own `requires.mcps` are injected, §3). This does **not** apply to Halo's
built-in capability toolsets (`ai-browser`, `ai-terminal`, `halo-email`, plus the always-on
`halo-memory`/`halo-report`/`halo-notify`/web-search/OCR) — those are gated purely by permission
flags in `execute.ts:443-457`, entirely independent of `requires.mcps`. Don't tell a user their
automation "has no browser/terminal/email tools because it's not declared in `requires.mcps`" —
that's only true for third-party MCP servers the user installed; built-in capabilities are a
separate mechanism. `create-digital-human/spec-reference.md` is the authoritative reference for
this built-in-vs-MCP distinction. Skills have
**no equivalent runtime gate** — every session (plain space chat, automation run, or
digital-human/IM chat alike) is built with `settingSources: ['user', 'project']` unconditionally
(`src/main/services/agent/sdk-config.ts:862`, called identically from
`session-manager.ts:987`, `send-message.ts:183`, `execute.ts:434`, and `app-chat.ts:590`). That
means **any skill physically present in the resolved global or space skills directory is
available in every conversation**, regardless of whether an automation's spec lists it under
`requires.skills` — that field only controls *install-time* auto-installation/bundling
(`installRequiredSkills()`, `registry.service.ts:629-730`), not runtime availability filtering.
Don't tell a user a skill needs to be "granted" to a specific digital human the way an MCP
dependency does — skills are ambient within scope, not permissioned per app.

**Don't confuse skill slash-invocation with Halo's built-in commands.** `/skill-name` is the
Claude Code SDK recognizing a skill's frontmatter `name` — no fixed command table involved.
Separately, Halo has hardcoded IM-only control commands (`/halo-stop`, `/halo-clear` and
aliases) implemented as literal string matching in `src/main/apps/runtime/dispatch-inbound.ts`
— those are a different mechanism entirely, valid only in IM-channel messages, not in native
Halo chat. See `create-digital-human/im-triggers.md` for those.

### Where skills physically live

- Global: `<claude-config-dir>/skills/<name>/SKILL.md`. `<claude-config-dir>` resolves via
  `resolveClaudeConfigDir()` (`src/main/foundation/config.service.ts:843-856`); in Halo's default
  mode this is the Electron `userData` path + `claude-config` — on macOS,
  `~/Library/Application Support/halo/claude-config/skills/<name>/SKILL.md`.
- Space: `<space-working-dir>/.claude/skills/<name>/SKILL.md`
  (`src/main/apps/skill-discovery.ts:78`).

These are the **exact same directories the underlying Claude Code SDK reads** — Halo's skill
discovery is a mirror of SDK behavior, not a separate mechanism (module header,
`skill-discovery.ts:1-17`). A directory missing `SKILL.md` is silently skipped, not reported as
an error (`skill-discovery.ts:29-69`).

### The Registry — where store installs come from

`src/main/store/registry.service.ts` defines 5 built-in registries (`BUILTIN_REGISTRIES`, lines
51-89): `official` (Halo's own Digital Human Protocol store, default), `mcp-official` (the public
MCP registry, queried live/proxy-style), `smithery`, `claude-skills`, `skillhub`. Some are
"mirror" sources (synced into local SQLite, browsable offline) and some are "proxy" sources
(queried live per request) — this distinction only matters for store-browsing latency, not for
install behavior. Adding a **custom** registry is blocked for loopback/private/link-local/cloud
metadata hosts as an SSRF defense (`isBlockedRegistryHost()`, `registry.service.ts:1287-1305`).

## 2. Configuration — installing a skill or MCP server

### From a conversation (agent-driven)

The `skill_manage` tool (exposed to the agent itself,
`src/main/apps/conversation-mcp/index.ts:567-680`) is the mechanism behind the `skill_manage`
tool documented in its own tool description. Two install paths:
- **By slug** (`slug` param) — installs from the store: `installFromStore(slug, spaceId)`.
- **By spec** (`spec` param, JSON string) — direct install without the store. Must include
  `name`, `description`, `version`, and either `skill_content` (single file, the whole `SKILL.md`
  body as a string) or `skill_files` (a `{filename: content}` map for multi-file skills —
  companion scripts/assets alongside `SKILL.md`). When both are present, `skill_files['SKILL.md']`
  wins over `skill_content` (`src/shared/skill-frontmatter.ts:130-134`).
- `scope` param: `'global'` or `'space'`, default `'space'`. This maps directly to
  `spaceId: null` (global) or `spaceId: <current space>` (space) — the same rule as §1
  (`conversation-mcp/index.ts:597`).
- Uninstall requires `skill_id` (the installed app's id) and only works on `type: 'skill'` apps —
  it rejects automation apps with a message telling the caller to use
  `delete_automation_app` instead.

### From the Settings/Apps UI (human-driven)

The Apps page has separate **My MCP** (我的MCP) and **My Skills** (我的技能) list views
(`AppListMode: 'mcp' | 'skill'`, `src/renderer/components/apps/AppList.tsx:27`), each with its
own mode-scoped add button — **"Manual Add MCP"** (手动添加MCP, `zh-CN.json:820`) on the MCP
list, **"Manual Add Skill"** (手动添加技能, `zh-CN.json:821`) on the Skill list
(`AppList.tsx:118,127`). Both open the same underlying `ManualAddDialog` component, which shows
a generic "Manual Add" (手动添加) header only when reached without a preselected type
(`ManualAddDialog.tsx:129-135`) — there is no single combined "add SKILL/MCP" button on either
list; don't describe it as one entry point. There's also a **Migrate MCP Servers / Migrate
Skills from Claude CLI** import path that reads an existing `~/.claude.json` (i18n strings at
`zh-CN.json:837-838,694`). MCP servers can be added as a visual form or by pasting a JSON config
(Cursor/Claude-Desktop-style `{"mcpServers": {...}}` is accepted and unwrapped,
`src/renderer/utils/mcpConfigCompat.ts:75-94`).

### An automation app declaring a dependency (`requires`)

```yaml
requires:
  mcps:
    - id: some-mcp-server-id
      enabled: true   # per-app switch; false disables it for THIS app only, never globally
  skills:
    - some-skill-id                       # shorthand
    - id: another-skill-id
      bundled: true
      files: ["SKILL.md", "script.js"]    # required when bundled: true
```
(`RequiresSchema`, `schema.ts:328-333`; `McpDependencySchema` lines 241-256;
`SkillDependencySchema` lines 313-322.) When such an app is installed via
`installFromStore()`, its `requires.skills` are auto-installed too
(`installRequiredSkills()`, `registry.service.ts:629-730`) — bundled entries come from the
parent package, non-bundled entries are separately fetched from the store.

## 3. Verification

- **Skill installed and visible?** Call `skill_manage` is not needed for checking — ask the agent
  to read the skill (via the normal skill-invocation path) or check the Apps → My Skills list.
  Remember: a space-scoped skill with the same name as a global one **replaces** the global one
  for that space (§1) — if a skill "isn't updating," check whether an older space-scoped copy is
  shadowing the newly-installed global one, or vice versa.
- **MCP server connected?** The Settings UI runs a manual connection test
  (`testMcpConnections()`/`runMcpConnectionTest()`, `src/main/services/agent/mcp-manager.ts:215-383`)
  that spins up a throwaway session and reports per-server status, cached and broadcast over IPC
  as `agent:mcp-status`. A live conversation's own MCP status always outranks a stale probe
  result, and a `'pending'` session status never overrides a completed probe
  (`deriveStatus()`, `mcp-manager.ts:95-100`).
- **Which MCP servers does a specific automation actually get at runtime?** Only those in its own
  `requires.mcps` — this is enforced by `getMcpServersForRequires()`
  (`src/main/services/agent/helpers.ts:570-609`), the least-privilege entry point used by
  `src/main/apps/runtime/execute.ts:429`. This is different from interactive chat, which uses
  `getDbMcpServers()` (`helpers.ts:541-557`) — **all** effective MCP servers for the space, no
  filtering. Don't assume an automation app has access to every MCP server just because the
  space does.
- **No restart is needed after installing/changing an MCP server.** MCP servers are resolved
  fresh at session-build time, not cached at app launch. Installing, uninstalling, pausing,
  resuming, or updating an MCP app fires `emitMcpChange()`
  (`src/main/apps/manager/service.ts:61-88`), which invalidates affected sessions
  (`invalidateAllSessions()`/`invalidateSessionsForSpace()`,
  `src/main/services/agent/session-manager.ts:1184-1213,1317-1323`) — a session with a turn in
  flight is marked for rebuild and picks up the new MCP set on its very next message; an idle
  session rebuilds immediately. If a user says a newly-added MCP tool "isn't showing up," send a
  new message before assuming anything is broken — don't tell them to restart Halo.

## 4. Diagnostics

| Symptom (exact string) | Cause | Source |
|---|---|---|
| `App '${specId}' is already installed in space '${spaceId}'` / `'global scope'` | Name/spec collision — same skill or MCP already installed at that scope | `src/main/apps/manager/errors.ts` (`AppAlreadyInstalledError`) |
| `App not found: ${appId}` | Stale/wrong id passed to uninstall or update | `manager/errors.ts` (`AppNotFoundError`) |
| `Built-in app '${specId}' (${appId}) cannot be ${operation}d...` | Attempted hard-delete of a bundled built-in skill/app | `manager/errors.ts` (`BuiltinAppProtectedError`) — use uninstall (disable) instead, not delete |
| `MCP server command '${command}' is blocked by security policy` | Command matched a security blacklist (deliberately generic, doesn't reveal the list). **Only reachable when the build declares a non-empty `security.mcpCommandBlacklist`** — `isMcpCommandBlocked()` returns false on an empty list (`security-policy.ts:233-255`) and the open-source template declares none, which is why `helpers.ts:501-511` describes itself as a no-op there. Don't offer this as a likely cause unless you know the build configures one | `manager/errors.ts` (`McpCommandBlockedError`); enforced at install and at runtime injection (`helpers.ts:501-511`) |
| "The MCP server failed to connect." | Live probe or session reported a connection failure | `zh-CN.json:1451`, driven by `mcp-manager.ts` status tracking |
| "The MCP server is disabled globally, so this digital human will not inject its tools at runtime." | The MCP *app itself* is disabled at Apps level (different from an app's own `enabled: false` in `requires.mcps`, which only affects that one app) | `zh-CN.json:1467` |
| `Required MCP "${id}" disabled for this digital human (spaceId=${spaceId})` | This automation set `enabled: false` on that dependency in its own `requires.mcps` | `helpers.ts:570-609` (log) |
| `Required MCP "${id}" not found or not active` | Declared dependency isn't installed, or is paused/uninstalled, in this space | `helpers.ts:570-609` |
| "{{count}} declared MCP dependency is not installed in this space." | Same as above, surfaced in the app's dependency panel | `zh-CN.json:1710-1711`, `AppMcpDepsSection.tsx:534` |
| `Skill dependency not found: {{ids}}. Install it first...` | Sharing/importing a package whose declared skill deps aren't present | `zh-CN.json:1351`, `ShareToStoreDialog.tsx:1335` |
| `SKILL.md not found. A skill package must contain SKILL.md at its root, or inside a single top-level folder.` | Malformed skill ZIP/folder import | `src/renderer/components/apps/skill-import-utils.ts:129-145` |
| `Could not extract ZIP...` / `ZIP archive is empty.` | Corrupt or empty ZIP on skill import | `skill-import-utils.ts:162-185` |
| Skill "installs" successfully but nothing appears on disk | `skill_content`/`skill_files` were both empty at install time — Halo logs a warning and skips the filesystem write rather than failing the install | `src/main/apps/manager/skill-sync.ts:98` |
| `Configuration must be an object` / `Invalid format: requires command (stdio) or type + url (http/sse)` | Pasted MCP JSON is malformed | `src/renderer/utils/mcpConfigCompat.ts:75-94` |
| `Configuration contains multiple servers. Paste a single server config here.` | Pasted a multi-server `{"mcpServers": {...}}` block into a single-server edit form | `mcpConfigCompat.ts:263-271` |
| `Name can only include letters, numbers, and . @ / _ -` / `Name already exists` | Invalid or duplicate MCP server name | `src/renderer/utils/mcpValidation.ts` |
| YAML/spec parse or validation errors (`APP_SPEC_PARSE_ERROR`, `APP_SPEC_VALIDATION_ERROR`) | Malformed skill/app spec YAML or a field that fails the Zod schema | `src/main/apps/spec/errors.ts`, `src/main/apps/spec/validate.ts` |

## 5. Never ask the user

- **Don't ask which scope a skill "should default to."** Default is always `space` unless the
  caller explicitly asks for `global` (`conversation-mcp/index.ts:597`) — space scope is the
  right default for anything project-specific; only suggest `global` when the user explicitly
  wants it available across every space.
- **Don't ask the user to manually place `SKILL.md` files.** Both install paths (§2) write to the
  correct discovery directory automatically via `syncSkillToFilesystem()`
  (`src/main/apps/manager/skill-sync.ts:85-143`) — there's no reason to hand-edit the filesystem.
- **Don't offer `feishu`/`dingtalk`-style "not yet real" MCP transports or invented transport
  types.** The only valid `transport` values are `stdio` (default), `sse`, `streamable-http`
  (`McpServerConfigSchema`, `schema.ts:268-281`) — nothing else parses.
- **Don't ask for credentials to store inside an MCP server's spec-level config for well-known
  first-party integrations** (email, IM, etc.) — those are configured once globally in Settings,
  not per MCP server; only ask for `env`/`headers` values a genuinely custom third-party MCP
  server needs.
- **Don't tell a user two differently-named skills will collide.** Non-ASCII (e.g. Chinese) skill
  names are romanized into an ASCII command name automatically
  (`src/main/apps/spec/skill-identity.ts`), with a numeric suffix added on any collision — this
  is handled for them, not something to warn about proactively.
- **Don't assume a scheduled/triggered automation's access to *user-installed MCP servers*
  mirrors the space's full MCP list.** That path is least-privilege (`requires.mcps` only, §3) —
  always check the app's own `requires` before telling a user "it should already have that
  tool." This applies only to user-installed MCP servers, not to built-in capabilities
  (ai-browser/ai-terminal/email/etc.), which are permission-flag gated and unrelated to
  `requires.mcps` — don't conflate the two when explaining why a tool is or isn't available.
- **Don't tell a user to restart Halo after adding/changing an MCP server.** That's not required
  (§3) — live session invalidation handles it on the next message.
