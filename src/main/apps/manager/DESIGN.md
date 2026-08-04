# apps/manager -- Design Decisions

> Module owner: apps/manager
> Date: 2026-02-21
> Status: Implementation

---

## 1. Module Role

Pure data/persistence layer for App lifecycle management.
Consumed by `apps/runtime` (activation, status updates) and renderer (IPC for UI).
Does NOT execute Apps, trigger scheduling, or call Agents.

---

## 2. Key Design Decisions

### 2.1 State Machine for Status Transitions

**Decision**: Implement an explicit allow-list state machine rather than free-form status updates.

**Rationale**: Prevents illegal transitions (e.g., `error` -> `waiting_user` directly) which
would indicate bugs in `apps/runtime`. The state machine is small and well-defined:

```
          install()
             |
             v
         [active] <--------- resume()
           |   |                ^
   pause() |   | updateStatus() |
           v   v                |
       [paused] [error] --------+--- (via resume after fixing)
           |       |
           |       v
           |  [needs_login] ----+--- (via resume after re-login)
           |       |
           +-------+
                   |
                   v
           [waiting_user] ------+--- (via resolveEscalation -> active)
```

Valid transitions:
- `active` -> `paused`, `error`, `needs_login`, `waiting_user`
- `paused` -> `active`
- `error` -> `active`, `paused`
- `needs_login` -> `active`, `paused`
- `waiting_user` -> `active`, `paused`, `error`

Any other transition throws an `InvalidStatusTransitionError`.

### 2.2 pendingEscalationId -- Decoupled from runtime tables

**Decision**: Store `pendingEscalationId` as an opaque `string | null` rather than a FOREIGN KEY
to `activity_entries.id`.

**Rationale**: The architecture doc suggests this field points to `activity_entries.id`
(an `apps/runtime` table). Having a cross-module FK creates a tight coupling and circular
dependency between manager and runtime schemas. Instead:
- Manager stores it as a plain TEXT column with no FK constraint.
- Runtime is responsible for keeping it semantically valid.
- On uninstall, runtime cleans up its own tables (CASCADE on `app_id`).

### 2.3 Uninstall: Default Preserve, Optional Purge

**Decision**: `uninstall(appId, options?)` with `options.purge?: boolean` (default `false`).

**Rationale**: The architecture doc says "default preserve work directory". However, users
may want a clean uninstall. Adding `purge` as an opt-in flag satisfies both cases without
breaking the default contract. Runtime should call `deactivate(appId)` before uninstall.

### 2.4 userConfig Validation

**Decision**: Manager does NOT validate `userConfig` against `config_schema`.

**Rationale**:
- The caller (IPC layer or runtime) is responsible for validation before calling `updateConfig`.
- Manager is a data layer -- it persists what it is told.
- Validation logic belongs in the IPC handler or a shared utility, not in the persistence layer.
- This avoids coupling manager to the Zod schema details of `apps/spec`.

### 2.5 Space Isolation

**Decision**: `(spec_id, space_id)` together uniquely identify an installed App instance.
Different spaces can install the same spec independently with completely isolated state.

**Implementation**: The `id` (primary key) is a UUID generated at install time. The
`(spec_id, space_id)` pair has a UNIQUE constraint so you cannot install the same spec
twice in the same space. Different spaces produce different UUIDs, different rows, different
work directories.

### 2.6 Event Notification: Callback Array Pattern

**Decision**: Use a simple callback array pattern (not EventEmitter) for `onAppStatusChange`.

**Rationale**: Consistent with the project's existing pattern seen in:
- `platform/background` -- `onStatusChange` uses a handler array with unsubscribe function
- This is simpler and more explicit than Node.js EventEmitter for single-event patterns.

### 2.6a MCP Change Event Carries Per-App Details

**Signature**: `onMcpAppsChange((spaceId: string | null, change?: McpAppChange) => void)`
where `McpAppChange = { appId, specId, action }` and `action` is one of
`installed | uninstalled | reinstalled | paused | resumed | updated | moved | status`.
The `McpAppChange` type lives in `services/app-bridge.ts` (type-only import here,
erased at runtime) because its consumers are on the services tier.

**Rationale**: The original space-only payload was enough for session
invalidation, but per-server subscribers need to know *which* server changed
and *how*: the agent's MCP status cache drops the entry on `paused`/`uninstalled`
(prevents stale "connection error" surviving a reinstall) and triggers a native
connection probe on `installed`/`reinstalled`/`resumed`/`updated`/`status`
(see `services/agent/mcp-probe.ts`). Every `emitMcpChange` call site in
`service.ts` must pass the change details; `change` stays optional only so
space-level handlers can ignore it.

### 2.6b Applying an App's Own Config Changes to Its Chat

**Decision**: The manager emits no event for this. Changing permissions, user
config, or a spec field is a plain store write.

**Rationale**: A chat session's defining inputs (system prompt, MCP server set,
guest permission envelope) are fingerprinted at creation and re-checked on every
send (`computeSessionInputsFingerprint`, `services/agent/session-manager.ts`).
A session whose inputs no longer match is torn down and rebuilt before the
message is dispatched, so a config change lands on the next message with nobody
notifying anybody. That path is declarative and self-healing; a parallel
manager→runtime notification would be a second, weaker answer to the same
question, able only to duplicate what the fingerprint already guarantees.

Interrupting an in-flight turn is a separate and explicitly manual concern —
`restartAppChat(appId, { interruptActive: true })`, reachable only from the
"Restart agent" IPC/HTTP path.

### 2.7 Migration Namespace

**Decision**: Use `'app_manager'` as the migration namespace.

**Rationale**: Consistent with the test example in `database-manager.test.ts` which already
uses `'app_manager'` as a namespace. Follows the underscore convention used by other modules.

### 2.8 App Work Directory Structure

```
{space.path}/.halo/apps/{appId}/          -- App root work directory
{space.path}/.halo/apps/{appId}/memory/   -- App memory directory
{space.path}/.halo/apps/{appId}/memory.md -- App memory file (created by memory module, not us)
```

`getAppWorkDir(appId)` returns the root. It ensures the directory exists (auto-creates).

### 2.9 updateStatus: Separate from pause/resume

**Decision**: Expose `updateStatus(appId, status, extra?)` as a general status setter
(used by runtime for `error`, `needs_login`, `waiting_user`), while `pause()` and `resume()`
are convenience wrappers that enforce specific transitions.

This keeps the interface clean:
- `pause(appId)` -- user action, only from `active`
- `resume(appId)` -- user action, from `paused`/`error`/`needs_login`
- `updateStatus(appId, status, extra)` -- runtime action, for `error`/`needs_login`/`waiting_user`

### 2.10 updateLastRun

**Decision**: Add `updateLastRun(appId, outcome, errorMessage?)` as a dedicated method
for runtime to record execution results. This is cleaner than overloading `updateStatus`.

### 2.11a Install Conflict — Skill vs Automation/MCP

**Decision**: `install()` overwrites an existing **active** skill of the same
`(specId, spaceId)` in place, but still rejects same-name `automation` /
`mcp` installs with `AppAlreadyInstalledError`.

**Rationale**: Skills are content-only artifacts — a prompt plus optional
files on disk — with no runtime state. Treating a re-install as an
overwrite matches how skill authors actually iterate: drop the same name
again with new content and expect the disk + DB to reflect the latest
version. Forcing an explicit uninstall first creates friction with zero
safety benefit.

Automation apps (and MCP apps) carry state the user does not want to
lose silently:

- `userConfig` values entered through the UI
- Runtime memory and run history
- Per-subscription `userOverrides` (schedule, frequency)
- Active sessions, pending escalations

Overwriting those silently would discard work the user did, so the
conflict gate still throws and the caller (UI / IPC / MCP tool) must
surface a clear message asking the user to uninstall or rename first.

**Uninstalled records** continue to follow the existing "soft-deleted →
reinstall on next install" path for both skills and apps — that branch
predates this decision and is unchanged.

### 2.11 Built-in Apps (VSCode-style bundled digital humans)

**Decision**: Bundle "built-in" digital humans with the build itself, install
them into the regular `installed_apps` table, and protect them from
permanent deletion. Mark them with `spec.store.install_source = 'builtin'`.

**Rationale**: Different product variants (open-source vs enterprise
variants) ship different default app sets. Hard-coding the spec content in
TypeScript would explode the source files and break maintainability; routing
through the App Store at first launch would require network connectivity. The
bundled-and-managed approach mirrors VSCode's built-in extension model:

- **Source of Truth** lives in an external repository per variant
  (e.g. `../digital-human-protocol-<variant>/packages/digital-humans/`), declared
  in `product.json` under the new `builtinApps` field.
- **Build-time sync**: `scripts/sync-builtin-apps.mjs` copies each declared
  app folder into `resources/builtin-apps/<specId>/` and writes a
  `manifest.json`. Runs automatically as a `prebuild` npm hook so any
  `npm run build` flow is covered. The destination is `.gitignore`d so the
  open-source repo never carries enterprise content.
- **Runtime loader**: `builtin-loader.ts` scans `resources/builtin-apps/` as
  a Tier-3 idle task, installs missing entries via the standard
  `appManager.install()` path (so all existing IPC, runtime, and analytics
  hooks just work), refreshes `spec_json` when the bundled version moves
  forward, and garbage-collects rows whose `specId` no longer appears in the
  manifest.
- **User state preservation**: `userConfig`, `userOverrides`, and `status`
  live in DB columns that the loader never touches when refreshing — only
  `spec_json` and `spec_id` are updated via `service.updateSpec`.
- **Disable semantics**: a "uninstall" on a built-in is a soft uninstall
  (status=`uninstalled`); the loader respects it across launches. Standard
  `reinstall` flow re-enables. This matches VSCode's per-user disable flag.
- **Hard-delete protection**: `service.deleteApp()` rejects built-ins with
  `BuiltinAppProtectedError` so a UI bug or curl call cannot wipe a built-in
  whose row would just respawn on next launch. The loader's GC sets a
  process-level bypass flag (`isBuiltinGcInProgress()`) when it legitimately
  needs to remove an obsolete built-in.

**Why not pure scanner / virtual entries?** A scanner-only design (no DB row,
merge in `listApps`/`getApp`) would have to rewrite ~40 caller sites across
IPC, runtime, services, and analytics — all of which currently assume a
single source of truth (the `installed_apps` table). The chosen design
achieves the same UX (auto-install, auto-upgrade, protected delete, user-
controlled disable) with zero changes to those callers.

**Performance**: The loader does N spec.yaml reads + N JSON parses per launch
(N = number of bundled apps, typically ≤10). For unchanged builds this is
~10–20ms total, all of which runs in the idle queue and never blocks the UI.

### 2.12 Knowledge Base Seeding: Once Per App, Ever

**Decision**: An automation app's knowledge-base bindings (space-bound KBs +
the default KB) are seeded exactly once in its lifetime, gated by the
`knowledge_seeded` column. `moveToSpace` and non-automation app types never
seed. Three paths can perform that one seed: `install()`'s fresh-install
branch, `install()`'s reinstall branch, and `ensureKnowledgeSeeded(appId)`.

**Rationale**: Seeding on every `moveToSpace` would silently swap a user's
curated KB bindings whenever an app moves between spaces; re-seeding on
`reinstall` would re-add bindings the user deliberately removed. The
one-shot flag makes "have we ever seeded this app" explicit and queryable,
instead of inferring it from `appIds.length === 0` (which can't distinguish
"never seeded" from "user unbound everything"). Because every path is gated
by the same flag, "which path ran the seed" carries no meaning — only
whether one already did.

**Why reinstall seeds too**: the startup backfill deliberately skips
uninstalled records (binding them would leave dangling `appIds` on the KB
for an app the user removed), so for a pre-feature app that sat uninstalled
across the upgrade, reinstall is its first moment back in the live
population. Without this the app would run with no knowledge until some
later launch caught it. The flag makes it safe: an app that was already
seeded reinstalls as a no-op.

**Backfill scope**: `knowledge-backfill.ts` (Tier-3 idle task, sibling to
`seed.ts` and `builtin-loader.ts`) covers every live status, not just
`active` — a paused or errored app resumes into a normal run, and filtering
to `active` would strand it.

---

## 3. SQLite Schema

```sql
CREATE TABLE installed_apps (
  id TEXT PRIMARY KEY,                    -- UUID
  spec_id TEXT NOT NULL,                  -- App spec identifier
  space_id TEXT NOT NULL,                 -- Space this app belongs to
  spec_json TEXT NOT NULL,                -- Full AppSpec as JSON
  status TEXT NOT NULL DEFAULT 'active',  -- active|paused|error|needs_login|waiting_user
  pending_escalation_id TEXT,             -- Opaque ID (no FK, managed by runtime)
  user_config_json TEXT DEFAULT '{}',     -- User config values
  user_overrides_json TEXT DEFAULT '{}',  -- User overrides (frequency etc.)
  permissions_json TEXT DEFAULT '{"granted":[],"denied":[]}',
  installed_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_outcome TEXT,                  -- 'useful'|'noop'|'error'|'skipped'|null
  error_message TEXT,
  knowledge_seeded INTEGER NOT NULL DEFAULT 0, -- 1 once install() has seeded KB bindings (see 2.12)
  UNIQUE(spec_id, space_id)
);
CREATE INDEX idx_installed_apps_space ON installed_apps(space_id);
CREATE INDEX idx_installed_apps_status ON installed_apps(status);
```

---

## 4. File Structure

```
src/main/apps/manager/
  index.ts            -- initAppManager(), shutdownAppManager(), re-exports
  types.ts            -- InstalledApp, AppManagerService, AppStatus, isBuiltinApp helper
  migrations.ts       -- Migration[] for the installed_apps table
  store.ts            -- SQLite CRUD operations (AppManagerStore class)
  service.ts          -- AppManagerService implementation (state machine, builtin guard)
  errors.ts           -- Custom error types (incl. BuiltinAppProtectedError)
  skill-sync.ts       -- Filesystem sync for skill apps (SDK-discoverable .md files)
  seed.ts             -- One-shot "Halo 助手" placeholder when no apps exist
  builtin-loader.ts   -- Built-in (bundled) digital human loader; runs as Tier-3 idle task
  knowledge-backfill.ts -- One-shot KB seed for apps predating knowledge_seeded; Tier-3 idle task
```

---

## 5. Interface Contract (what runtime depends on)

```typescript
interface AppManagerService {
  install(spaceId: string, spec: AppSpec, userConfig?: Record<string, unknown>): Promise<string>
  uninstall(appId: string, options?: { purge?: boolean }): Promise<void>
  pause(appId: string): void
  resume(appId: string): void
  updateConfig(appId: string, config: Record<string, unknown>): void
  updateFrequency(appId: string, subscriptionId: string, frequency: string): void
  updateStatus(appId: string, status: AppStatus, extra?: { errorMessage?: string; pendingEscalationId?: string }): void
  updateLastRun(appId: string, outcome: RunOutcome, errorMessage?: string): void
  getApp(appId: string): InstalledApp | null
  listApps(filter?: AppListFilter): InstalledApp[]
  ensureKnowledgeSeeded(appId: string): void
  getAppWorkDir(appId: string): string
  clearAppMemory(appId: string): number
  grantPermission(appId: string, permission: string): void
  revokePermission(appId: string, permission: string): void
  onAppStatusChange(handler: StatusChangeHandler): Unsubscribe
}
```
