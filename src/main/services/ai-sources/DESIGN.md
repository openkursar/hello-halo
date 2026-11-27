# AI source configuration

`index.ts` is the public service surface. Source credentials and catalogs belong to `AISourceManager`; load-balancing group writes belong to `groups.ts`.

## Client refresh

Every window and remote client keeps its own copy of the saved sources. `listed-sources.ts` follows the foundation's successful-save subscription and emits `ai-sources:catalog-changed` with the affected source/group ids whenever what clients list changes, whoever wrote it (a login from another client, a catalog refresh, a deletion). Credential renewals change only tokens and timestamps and stay silent. The channel name predates the wider meaning and is kept for installed mobile clients.

## Subagent model assignments

`subagent-models.ts` owns targeted assignment writes under `aiSources.subagentModels`. It stores logical source/model or group references only, never credentials or provider connection data. Generic client config saves preserve this managed field.

Management reads synthesize the three fixed empty slots without persisting or enabling them. The first successful target save records version 1; custom profiles have generated identities. Builtin slot identity and order are fixed. Clearing a builtin preserves its purpose and increments its revision, removing the target. Clearing or deleting the last configured target restores inherit mode without stopping existing work.

Profile revisions reject stale edits and stale execution references. Settings revision changes on actual configuration changes; policy revision changes on activation and selection-mode transitions. Identical updates are no-ops. A failed configuration write cannot return success or publish a change notification. Deleted source/group references remain stored for repair.

Runtime settings reads use an in-memory snapshot seeded by the manager's existing configuration reads and updated through the foundation's successful-save subscription. They do not read disk, refresh catalogs, discover credentials, start timers, or create sessions. Execution adapters remain responsible for engine/source compatibility, trusted caller scope, strict credential resolution, and SDK selection/finalization.

The renderer-safe shapes and input helpers live in `shared/types/subagent-models.ts` and `shared/subagent-models.ts`. Resource bounds come from the SDK's browser-safe collaboration protocol. Assignment inputs and responses do not carry reasoning effort. A retired effort field in older settings is ignored without a migration or revision change; a real edit replaces only the edited assignment.

`controllers/subagent-models.controller.ts` gives IPC and owner-authenticated HTTP the same non-secret response envelope. `subagent-models:changed` carries only settings/policy revision scalars, once per actual successful mutation. Clients reread on demand; there is no polling or full-list broadcast.
