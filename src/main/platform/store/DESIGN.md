# platform/store -- Design Decisions

> Date: 2026-02-21
> Author: platform-store engineer
> Status: Implementation ready

## 1. Context

`platform/store` is the persistence foundation for the entire new feature system.
Every platform module (scheduler, event, memory) and apps module (manager,
runtime) depends on it for SQLite access. It must be the first module completed.

### What this module does

- Provides application-level SQLite database connection management via `better-sqlite3`
- Offers a versioned, module-scoped migration mechanism
- Supplies transaction helpers for consumers
- Manages database lifecycle (open, close, WAL mode, PRAGMA tuning)

### What this module does NOT do

- Not an ORM; no query builder
- Does not replace existing JSON persistence (config, conversation, space untouched)
- Does not own any business table CRUD -- consumers manage their own tables/migrations

## 2. Research Findings

### 2.1 Existing SQLite usage in the project

**None.** The project has zero `better-sqlite3` or SQLite dependencies. The only
mention of "sqlite" in source code is in file-type constants for artifact display.
This is a greenfield module.

### 2.2 better-sqlite3 characteristics

- Synchronous API (no async/await needed for queries)
- Runs in-process, no IPC overhead
- Excellent performance for read-heavy workloads
- WAL mode supports concurrent reads with one writer
- Native addon -- needs `electron-rebuild` or `electron-builder` native dep handling
- The project already uses `externalizeDepsPlugin()` in electron-vite, which
  externalizes all deps from the main process bundle. This handles native modules.

### 2.3 Migration simplicity guidance

Use small, explicit migrations with inline `CREATE TABLE IF NOT EXISTS`
statements for V1. This keeps schema evolution easy to audit and avoids
unnecessary abstraction layers.

### 2.4 Database path resolution

The project uses `getHaloDir()` from `config.service.ts` which resolves to:
- Production: `~/.halo/`
- Development: `~/.halo-dev/` (when `app.isPackaged === false`)
- Custom: `HALO_DATA_DIR` env var
- Tests: overridden via `os.homedir()` mock

For the store module, we use `getHaloDir()` to get the base path, then append
`halo.db`. This keeps consistency with the existing data path strategy.

### 2.5 Electron build pipeline

`electron.vite.config.ts` uses `externalizeDepsPlugin()` which externalizes
native Node modules. `better-sqlite3` will be automatically handled. The
`package.json` build config already has `npmRebuild: false` and a `postinstall`
script with `electron-builder install-app-deps` which rebuilds native modules
for the correct Electron ABI.

## 3. Key Design Decisions

### 3.1 Migration mechanism: module-namespaced version tracking

**Problem**: Multiple independent modules (scheduler, manager, runtime, event-bus)
each need their own tables and migrations. They must not conflict.

**Decision**: Each module registers migrations with a unique namespace string.
The `_migrations` meta-table tracks `(namespace, version)` pairs. When
`runMigrations(db, namespace, migrations)` is called, it only looks at the
version for that namespace.

```
_migrations table:
  namespace TEXT  -- e.g., "scheduler", "app_manager", "event_bus"
  version   INTEGER -- current schema version for this namespace
  applied_at INTEGER -- timestamp
  PRIMARY KEY (namespace)
```

**Why not a single global version?**
- Modules are developed independently by different engineers
- Adding a new module should not require coordinating version numbers with others
- Each module owns its own migration sequence (version 1, 2, 3...)

**Idempotency**: Migrations check current version and only run unapplied ones.
The entire migration sequence for a namespace runs in a single transaction.

### 3.2 Database path strategy

| Database | Path | V1 Status |
|----------|------|-----------|
| App-level | `{haloDir}/halo.db` | Active |
| Space-level | `{space}/data.db` | Interface only, not created |

We use `getHaloDir()` from config.service.ts for path resolution. This respects
`HALO_DATA_DIR` env var, dev mode separation, and test isolation.

### 3.3 better-sqlite3 in Electron main process

**Concern**: better-sqlite3 is synchronous. Will it block the main process?

**Analysis**: For our use cases (migration at startup, small CRUD ops for scheduler
jobs, app installs, run logs), query durations are sub-millisecond. The main risk
is during migration or bulk inserts. Mitigations:

1. Migrations run at startup before UI interaction (in bootstrap Phase 3)
2. WAL mode enables concurrent reads without blocking
3. Transactions batch multiple writes into single disk flush
4. If future profiling shows blocking, we can move to a worker thread

**Decision**: Use synchronous API directly. No worker thread for V1.

### 3.4 Connection management

- Single `Database` instance per database file (app-level or space-level)
- Lazy initialization: database opened on first `getAppDatabase()` call
- Connection cached in a Map keyed by file path
- `closeAll()` iterates and closes all connections
- WAL mode enabled on open for better concurrent performance

### 3.5 Database corruption and failure handling

Strategy: log + graceful degradation, never crash the app.

1. **Database open failure**: Log error, return null. Consumers must handle null.
   Wait -- this would force null checks everywhere. Better: if the database
   cannot be opened, throw during `initStore()`. The bootstrap layer can catch
   this and log a warning. Subsequent `getAppDatabase()` calls will retry.

2. **Actual strategy**: On init failure, attempt recovery:
   - Try opening normally
   - If corruption detected (SQLITE_CORRUPT), rename broken file to `.corrupt.{timestamp}`
   - Create fresh database
   - Log prominently so user knows data was lost

3. **Migration failure**: Transaction rollback. The database stays at the previous
   version. Log the error. The consuming module can decide how to handle.

### 3.5a Data written by a newer build (schema-ahead)

Migrations are forward-only. An older build opening a database that a newer
build already migrated finds nothing pending and would run against a shape it
does not know — silent damage, not a startup failure. This stops being
hypothetical when two installs share one data directory (stable and preview
share `dataFolderName` by design; see `services/updater/DESIGN.md` §8).

- **Detection.** `runMigrations` compares the namespace's stored version with
  the newest migration the build carries, and throws `SchemaAheadError`
  (namespace, stored, supported) when the stored one is higher. The newest
  migration *is* the supported version, so there is no separate constant to
  drift.
- **Refuse, never degrade.** The caller must stop the process, not continue
  with the module disabled: every write from a build that cannot read the
  schema compounds the damage. `isSchemaAheadError` is exported so bootstrap
  can tell this apart from an ordinary init failure; the dialog and exit live
  in `bootstrap/schema-refusal.ts` because this module stays free of Electron
  and UI.
- **Pre-migration snapshot.** Before the first pending migration of a run,
  a file-backed database with existing data (`currentVersion > 0`) is copied
  with `VACUUM INTO` to `<db>.<timestamp>.premigrate.bak` — consistent even
  with WAL content outstanding. Once per database per process, however many
  namespaces migrate. A failed snapshot is logged and does not block startup:
  refusing to start over a precaution would turn a full disk into an unusable
  app. The newest two snapshots are kept; older ones are pruned, since each is
  a full copy of a database that is routinely hundreds of MB.
- **Why the snapshot matters.** It is the way back for a user who opened
  their data with a newer build and needs the older one again; the refusal
  dialog points them to it. Reinstalling does not help and is the one action
  the dialog must not suggest.

### 3.6 PRAGMA configuration

Applied on every connection open:
- `journal_mode = WAL` -- better concurrent read performance
- `synchronous = NORMAL` -- good balance of safety and speed (WAL mode)
- `foreign_keys = ON` -- enforce referential integrity
- `busy_timeout = 5000` -- wait up to 5s for locks instead of failing immediately

### 3.7 Test strategy

- Use `:memory:` databases for all unit tests (fast, no cleanup needed)
- Test migration idempotency: run migrations twice, verify no errors
- Test migration ordering: verify sequential version execution
- Test concurrent namespace migrations: two modules, same database
- Test transaction helpers
- Test database close and reopen

## 4. Public API

```typescript
// Types
interface Migration {
  version: number
  description: string
  up(db: BetterSqlite3.Database): void
}

interface DatabaseManager {
  getAppDatabase(): BetterSqlite3.Database
  getSpaceDatabase(spacePath: string): BetterSqlite3.Database
  runMigrations(db: BetterSqlite3.Database, namespace: string, migrations: Migration[]): void
  transaction<T>(db: BetterSqlite3.Database, fn: () => T): T
  closeAll(): void
}

// Initialization
async function initStore(): Promise<DatabaseManager>
```

### Deviation from architecture doc

The architecture doc shows `runMigrations(db, migrations)` without a namespace
parameter. I am adding the `namespace` parameter because without it, multiple
modules cannot independently track their migration versions. This is a strictly
additive change that improves the design.

I am also adding a `transaction<T>` helper since it is a common need and
better-sqlite3's transaction API is slightly awkward to use raw.

## 5. File Structure

```
src/main/platform/store/
  index.ts          -- Public API: initStore(), DatabaseManager, types,
                       SchemaAheadError / isSchemaAheadError
  database-manager.ts -- DatabaseManager implementation
  schema-guard.ts   -- schema-ahead error + pre-migration snapshot (§3.5a)
  types.ts          -- Migration, DatabaseManager interfaces
```

## 6. Implementation Plan

1. Create type definitions (`types.ts`)
2. Implement DatabaseManager class (`database-manager.ts`)
3. Implement `initStore()` and exports (`index.ts`)
4. Write unit tests (`tests/unit/platform/store/`)
5. Verify TypeScript compilation (`tsc --noEmit`)
6. Install `better-sqlite3` + `@types/better-sqlite3` if needed
