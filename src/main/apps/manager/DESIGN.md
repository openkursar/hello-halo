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

**Not the authority on what is pending.** An app can hold several unanswered questions at
once (one per escalating run), which a single id cannot express; this column only names the
most recent one, for display. Whether the app is waiting, and which question an answer
belongs to, are both resolved against `activity_entries` in `apps/runtime`. Treating this
column as the authority is what once let a second run auto-close the first run's question.

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

**Only MCP servers and skills may be global** (`space_id` is nullable for them). A digital
human (`type: 'automation'`) always belongs to a space: its working directory, memory and
conversations all resolve through one. `install` and `moveToSpace` reject a null space for
automation with `AutomationSpaceRequiredError`. Callers that receive a nullable space from a
user (package import, store install) resolve it with `resolveInstallSpaceId`
(`shared/apps/install-scope.ts`), which falls back to the Halo space for a digital human.
There is no migration for rows written before this rule.

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

Automation identity storage is pinned in `installed_apps.data_path` before a
default-space change. A nullable column (migration 8) preserves legacy layouts;
the first move records the existing absolute root without moving files. All
manager memory/purge operations resolve that root thereafter. Runtime captures
each run/session's separate working and transcript environment; changing the
default does not interrupt running work or relocate its files. Skills and MCP
scope changes retain their existing resource-specific behavior.

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
  manifest. It runs only when the bundle differs from the one its last
  complete run applied (`bundle-seed-stamp.ts`, keyed by app version + the
  manifest; `builtin-skills.ts` uses the same stamp keyed by its SKILL.md
  set) — an idle task still blocks the main thread, and an unchanged bundle
  has nothing to do. Within a run, installed rows are read once, since
  `listApps()` parses every row's spec including bundled skill files.
- **User state preservation**: `userConfig`, `userOverrides`, and `status`
  live in DB columns that the loader never touches when refreshing. A newer
  bundled version goes through `service.upgradeSpec` (2.13), so the user's
  edits to the definition survive it as they survive a store upgrade; the
  loader then resyncs the app's subscriptions, which the runtime activated from
  the previous spec earlier in startup.
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

**Symmetric cleanup on permanent delete**: `deleteApp()` calls
`unbindAppFromAllKBs(appId)` so a hard-deleted app's row disappearing does
not leave dangling `appIds` on any KB. Soft `uninstall()` does not call it —
that transition is reversible and, per the one-shot seed flag above, a
reinstalled app never gets re-seeded, so unbinding there would strand a
reinstalled app without its knowledge bases.

### 2.13 Upgrades Keep the User's Edits (the Author's Original)

**Decision**: an author's new version — a store upgrade (automatic, manual, or
"check for upgrades") or a bundled one — is applied with `upgradeSpec`, never
`updateSpec`. For a digital human it is merged against the **author's
original**: the spec as the author last shipped it, kept in `author_spec_json`,
written at install and replaced at every upgrade (`spec-upgrade.ts`).

- A top-level field still equal to the original was never edited and takes the
  new version (including its removal); any other field keeps the user's value.
- Release fields — `type`, `spec_version`, `version`, `author`, `store` — always
  follow the author.
- Run triggers are compared one by one: an edited trigger stays (whatever the
  author did to it), a deleted one stays deleted, an untouched one takes the new
  version or goes with the author's removal, the author's new ones are added
  and the user's own are kept. A trigger with an `id` is identified by it.
  Id-less triggers — how authors and the AI guides usually write them — are
  anchored on a longest common run of identical triggers (order kept); what
  lies between two anchors is paired in order as the same trigger edited, and
  what is left over there was added or removed. Pairing by position, or across
  the whole list, would let a trigger inserted or removed elsewhere drop the
  author's new one and revive the one the user replaced. The same trigger added
  by both sides is kept once.
- Where the author's stretch between anchors changed length (a trigger added
  or removed there as well as one changed), which one changed is a guess. If
  the user also changed or deleted a trigger in that stretch, the user's list
  is kept as it is and reported as kept, rather than risk losing the author's
  new trigger or running an edited one twice; the user can take the author's
  version from the activity note.
- Nothing is merged inside a field: a prompt is the user's or the author's.

The outcome (`SpecUpgradeOutcome`, shared) names the fields left different from
the author's new version (`kept`) and whether they are known edits. A digital
human the user never edited is upgraded exactly as before, and applying the
same upgrade twice changes nothing.

**Why an original rather than a record of edited fields**: every way to edit a
definition — the settings panel, the YAML editor, an AI changing it, the
frequency API — already ends in `updateSpec`, and none of them has to take part:
a comparison against the original catches an edit wherever it came from. The
original is a comparison basis only; the runtime never reads it, so the spec
remains the one definition (a competing second copy is how a schedule override
once silently outranked the schedule the settings showed — migration 7).

**Who has one**: digital humans with an upgrade source — `store.slug` (store)
or `install_source: 'builtin'` (bundle). Locally created ones are never
upgraded; MCP servers and skills are upgraded as before (`upgradeSpec`
delegates to `updateSpec`). It is not part of `InstalledApp`: `listApps()`
parses every row, so the row reads name their columns and leave it out, and
only an upgrade reads it (`getAuthorSpec`).

**Installs from before originals were recorded** stay NULL after migration 10 —
copying the current spec would pass the user's edits off as the author's. The
original exists only while its source still serves the installed version, so it
is recorded then: by the store's update check (`recordStoreOriginals`) and by
the built-in loader when the bundled version equals the installed one
(`recordAuthorSpec`, which accepts no other version and never replaces one).
The store check only trusts the source the app was installed from; an install
that recorded none is matched only when a single source lists its slug, since
another source's app under the same slug may be someone else's.

An upgrade that finds no original presumes every difference to be the user's:
nothing is overwritten, the author's new triggers are not added (the user
might have removed them), and the outcome says the kept fields are
undetermined (`editsKnown: false`). From then on the new version is the
original, so the fields kept that time differ from it at every later upgrade
and stay at the user's current version until the user switches them to the
author's version. Nothing records that they were undetermined: the activity
note says only that these fields differ from the author's new version, which
stays true either way, never that the user changed them.

**When the merge is invalid**: fields from two versions can break a rule that
spans fields (a kept `config_schema` lacking a key the author's new trigger
refers to). The upgrade then keeps every differing field — the current spec at
the new version, which is valid — instead of failing, and logs why.

---

## 3. SQLite Schema

```sql
CREATE TABLE installed_apps (
  id TEXT PRIMARY KEY,                    -- UUID
  spec_id TEXT NOT NULL,                  -- App spec identifier
  space_id TEXT,                          -- Space this app belongs to (NULL = global MCP/skill)
  spec_json TEXT NOT NULL,                -- Full AppSpec as JSON
  status TEXT NOT NULL DEFAULT 'active',  -- active|paused|error|needs_login|waiting_user|uninstalled
  pending_escalation_id TEXT,             -- Opaque ID (no FK, managed by runtime)
  user_config_json TEXT DEFAULT '{}',     -- User config values
  user_overrides_json TEXT DEFAULT '{}',  -- User overrides (notification level, model, memory)
  permissions_json TEXT DEFAULT '{"granted":[],"denied":[]}',
  installed_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_outcome TEXT,                  -- 'useful'|'noop'|'error'|'skipped'|null
  error_message TEXT,
  uninstalled_at INTEGER,                 -- soft-delete time
  upgrade_strategy TEXT NOT NULL DEFAULT 'auto', -- auto|notify|manual
  ignored_versions TEXT NOT NULL DEFAULT '[]',   -- versions the user chose to skip
  knowledge_seeded INTEGER NOT NULL DEFAULT 0, -- 1 once install() has seeded KB bindings (see 2.12)
  data_path TEXT,                         -- pinned work directory (see 2.8)
  author_spec_json TEXT                   -- the author's original, NULL when none is recorded (see 2.13)
);
-- One app per spec_id per scope: partial unique indexes on (spec_id) WHERE
-- space_id IS NULL and on (spec_id, space_id) WHERE space_id IS NOT NULL.
CREATE INDEX idx_installed_apps_space ON installed_apps(space_id);
CREATE INDEX idx_installed_apps_status ON installed_apps(status);
CREATE INDEX idx_apps_directory ON installed_apps(json_extract(spec_json, '$.type'), installed_at DESC, id ASC);
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
  spec-upgrade.ts     -- Merging an author's new version over the user's edits (pure; see 2.13)
  errors.ts           -- Custom error types (incl. BuiltinAppProtectedError)
  skill-sync.ts       -- Filesystem sync for skill apps (SDK-discoverable .md files)
  seed.ts             -- One-shot "Halo 助手" placeholder when no apps exist
  builtin-loader.ts   -- Built-in (bundled) digital human loader; runs as Tier-3 idle task
  builtin-skills.ts   -- Repo-authored global skills seeder; Tier-3 idle task
  bundle-seed-stamp.ts -- Which bundle each seeder last applied in full (skip when unchanged)
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
  updateSpec(appId: string, specPatch: Record<string, unknown>): void          // user and AI edits
  upgradeSpec(appId: string, authorSpec: AppSpec): SpecUpgradeOutcome          // author's new version (2.13)
  recordAuthorSpec(appId: string, authorSpec: AppSpec): boolean                // original for an earlier install
  listStoreInstallsWithoutAuthorSpec(): string[]
  updateStatus(appId: string, status: AppStatus, extra?: { errorMessage?: string; pendingEscalationId?: string }): void
  updateLastRun(appId: string, outcome: RunOutcome, errorMessage?: string): void
  getApp(appId: string): InstalledApp | null
  listApps(filter?: AppListFilter): InstalledApp[]
  listPersonIdsByStatus(statuses: readonly AppStatus[]): string[]
  ensureKnowledgeSeeded(appId: string): void
  getAppWorkDir(appId: string): string
  clearAppMemory(appId: string): number
  grantPermission(appId: string, permission: string): void
  revokePermission(appId: string, permission: string): void
  onAppStatusChange(handler: StatusChangeHandler): Unsubscribe
}
```

`listPersonIdsByStatus` answers set membership without deserializing specs —
`listApps` parses every installed spec, which is the wrong price for a question
about one column. The people directory uses it to decide, before it paginates,
who is stopped.

## Capability inventory and shared-resource impact

`getCapabilityInventory(manager)` is a read-only public projection of installed
skills and MCP connection instances. It exposes installation IDs, scope and
human consumers, never credentials or transcripts. MCP consumers include disabled
declarations so removing a connection does not erase its dependency record.
Workspace MCP installations override global installations with the same spec ID;
active workspace skills override global skill directories. Skill counts describe
installed-resource scope, not proof that an agent used a skill. Disk-authored
skills remain owned by skill discovery and are labelled separately in the UI.

The capability library and shared mutation dialogs consume this projection.
Creation dialogs keep their originating person and workspace rather than using a
previously selected global UI workspace. Store installation reuses the store
installer with a locked contextual scope. A successful install ID survives a
failed binding attempt within the form, so retry does not create another resource.
Shared edits, disables, scope changes and removal show consumers before applying;
per-person MCP switches only change that person's dependency declaration.

Renderer capability drafts are volatile and keyed by origin and scope. Skill
content survives closing a creation form. MCP draft caching excludes raw JSON,
commands, arguments, environment variables and headers because they can contain
credentials; only name, transport and scope are retained after leaving the form.
The form states this limitation before closing. In-place failures retain the full
form without persisting credentials in a generic draft store.

The capability inventory distinguishes inherited chat access from independent-task
MCP declarations. Shared edits include undeclared chat consumers in their impact.
`getPersonConnectionAccess` exposes only installation/configuration booleans and
instance references; health is explicitly `not_checked`. Team and guest permission
policies further constrain this scope eligibility and remain runtime-owned.

Digital-human directory reads use explicit lightweight records projected by SQL,
never truncated InstalledApp objects. The public paginated query accepts bounded
limits, stable installed-time/id ordering and ID filters provided by runtime for
membership and pending work. Full app retrieval remains unchanged for detail,
team and store consumers. Prompts and connection configuration do not enter the
summary contract. Runtime owns cross-module directory orchestration and grouped
state projection; transport only forwards that public query.
