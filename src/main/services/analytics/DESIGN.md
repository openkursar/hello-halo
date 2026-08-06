# Analytics Module — Design

## Purpose

Single entry point for all telemetry in the main process. Accepts events from
the renderer (via IPC or HTTP), from internal subscribers (app lifecycle, run
lifecycle), and from startup snapshot, and fans them out to a pluggable set
of providers (GA, Baidu, self-hosted Telemetry).

Disabled in development (`is.dev`) and in open-source builds where no
provider credentials are injected.

## Directory Layout

```
src/main/services/analytics/
├── analytics.service.ts     # Singleton service: init, track, destroy, watermark,
│                            # trackErrorSurface
├── types.ts                 # AnalyticsEvent*, UserContext, AnalyticsConfig, AnalyticsProvider
├── error-code.ts            # Shared deriveErrorCode helper (privacy-safe first token)
├── index.ts                 # Public re-exports
├── snapshot.ts              # Startup snapshot + run replay (one-shot per launch)
├── providers/
│   ├── base.ts              # BaseProvider: timeout / retry / safeTrack / logging
│   ├── ga.ts                # Google Analytics 4 (Measurement Protocol)
│   ├── baidu.ts             # Baidu Tongji
│   └── telemetry.ts         # Self-hosted batched provider (three-layer sanitize)
└── subscribers/
    └── apps.subscriber.ts   # AppManager + Runtime lifecycle → analytics events
```

## Core Concepts

### Singleton service (`analytics.service.ts`)

- `analytics.init()` — called exactly once from `main/index.ts` after
  `app.whenReady()`. Loads config, builds `UserContext`, initializes every
  provider that has credentials.
- `analytics.track(name, properties?)` — fire-and-forget event entry point.
  Dropped silently (with a throttled warning) when init has not completed.
- `analytics.destroy()` — called from `cleanupExtendedServices`. Triggers
  provider teardown (Telemetry flushes its batching queue).
- `analytics.whenSettled(timeoutMs)` — returns a promise that resolves once
  `init()` has finished (success or skip). Used by consumers that start on
  the same tick as init (notably `snapshot.ts`) to avoid race-drop.
- `analytics.getSnapshotState() / setSnapshotState()` — persists the
  `(lastSnapshotRunId, lastSnapshotTs)` watermark pair to
  `config.analytics.*` for the run-replay module.

### UserContext + external ID

`UserContext` always carries an anonymous per-install UUID (`userId`). When
`product.json.identitySource` is configured, `track()` resolves an
externally-meaningful UID from the active AI source via a dot-path
(e.g. `user.uid`) and sets `UserContext.externalUserId`. Resolution is
cached by `(sourceId, path)` so switching the active source or editing the
product config invalidates the cache on the next `track()`.

### Providers

All providers implement `AnalyticsProvider { name, initialized, init,
track, destroy? }`. Providers are isolated via `Promise.allSettled` — a
failure in one cannot starve the others.

| Provider  | Transport       | Batching | Flush                      | Privacy filter |
|-----------|-----------------|----------|----------------------------|----------------|
| Baidu     | Image beacon    | none     | immediate                  | upstream only  |
| GA4       | Measurement API | none     | immediate                  | upstream only  |
| Telemetry | POST /v1/events | in-memory queue | debounce 5s + size 100 + destroy() | **double pass** |

The Telemetry provider applies a three-layer sanitize pass (order matters):

1. **Global blocklist** (`BLOCKED_KEYS`) — absolute. Drops every
   content / token / secret / path key regardless of any other rule.
   Last line of defence against accidental additions.
2. **Per-event whitelist** (`EVENT_WHITELIST`) — keep only listed keys
   for known event names. When the name is absent, every key not in
   BLOCKED_KEYS is kept (used for the `action.*` family).
3. **SENSITIVE_KEYS gate** — user-authored / user-identifiable keys
   (`specId`, `spaceName`, `modelName`, `sourceName`, `mcpId`, `skillId`,
   `imBotName`, `inputTokens`, `outputTokens`, `errorCode`) are dropped
   unless the product variant explicitly opted-in via
   `product.json.telemetry.allowedSensitiveFields`.

Open-source builds omit the product `telemetry` block entirely, so
`allowedSensitiveFields` is empty and every SENSITIVE_KEY is dropped at
sanitize time — in addition to the empty-endpoint provider-disabled
safety net. Enterprise / internal builds typically allow the full
SENSITIVE_KEYS set so internal dashboards can show readable spec names,
model usage, token consumption, etc.

The `mcp:*` tool name redaction in `tool.usage_summary` is a separate
defence-in-depth measure: tool names ride inside a nested array
(`toolCalls[].name`) that the property-level gate cannot reach, so the
flush helper explicitly rewrites `mcp:<name>` → `mcp:<redacted>` before
emission.

### Subscribers

`installAppsSubscribers(appManager, runtime)` wires the two domain services
to the analytics pipeline:

| Source event                 | Emitted analytics event |
|------------------------------|-------------------------|
| `AppManager.onAppInstalled`  | `app.installed`         |
| `AppManager.onAppUninstalled`| `app.uninstalled`       |
| `Runtime.onRunStarted`       | `app.run.started`       |
| `Runtime.onRunFinished` (ok) | `app.run.completed`     |
| `Runtime.onRunFinished` (err)| `app.run.failed`        |

Every emitted run event carries both `appId` (UUID — the dashboard
aggregation key) and `specId` (human-readable spec.name — display tag,
gated by the SENSITIVE_KEYS framework). `specId` is reverse-looked-up
from `appManager.getApp(evt.appId)` because the runtime events do not
carry it directly.

All subscribers are `void analytics.track(...)` — never awaited, never
throw into the business path. Error details are reduced to a short
`errorCode` via the shared `deriveErrorCode()` helper in
`error-code.ts` (first colon / whitespace-delimited token, capped at 48
chars); the full error message never leaves the main process and even
the short code is gated by SENSITIVE_KEYS.

### Model + tool observability

Beyond run-level events, the stream-processor in
`src/main/services/agent/stream-processor.ts` emits two additional
telemetry signals so dashboards can correlate model usage and tool
behaviour with run outcomes:

| Source point                      | Emitted analytics event   | Rate          |
|-----------------------------------|---------------------------|---------------|
| Each assistant SDK message        | `llm.invocation` (status:'ok')   | Per model call |
| Stream exit when no usage captured| `llm.invocation` (status:'error')| Once per turn  |
| processStream end                 | `tool.usage_summary`       | Once per turn  |

`llm.invocation` includes `modelName` and token counts — all sensitive
and gated. `tool.usage_summary` aggregates `agent:tool-call` and
`agent:tool-result` events keyed by conversationId, then drains via
`flushToolStats(conversationId)` at the end of every processStream
invocation. The flush also fires on the `agent:error` path in
`send-message.ts` so the in-memory stats map can never leak entries
when a turn aborts before processStream returns.

### Error surface

`analytics.trackErrorSurface(area, error)` is the centralized way for
IPC handlers and service catch paths to record a coarse error map.
It is internally try/caught (telemetry must never re-throw into an
error path) and emits `error.surface` with two fields:

| Field        | Source                                       |
|--------------|----------------------------------------------|
| `area`       | Stable short string (e.g. `'agent-send'`, `'app-install'`, `'mcp-connect'`) |
| `errorCode`  | `deriveErrorCode(error)` — gated by SENSITIVE_KEYS |

Use `area` as a stable bucket for dashboards. `errorCode` is sensitive
and dropped for open-source builds.

### Startup snapshot (`snapshot.ts`)

Runs once per launch after both AppManager and Runtime are initialized
**and** after `analytics.whenSettled()` resolves. Emits:

1. `installed_apps.snapshot` — the current population of non-uninstalled
   automation apps (summaries only: appId, specId, type, version, status,
   installedAt).
2. `app.run.replay` — one event per `automation_runs` row whose
   `finishedAt > lastSnapshotTs` and whose status is terminal
   (`ok | error | skipped`). Bounded by `MAX_RUNS_PER_APP=200` and
   `MAX_REPLAY_EVENTS=2000`. On success the watermark advances to the
   latest finished run shipped.

## Transport surfaces

| Caller      | Channel                        | Allowed events                                                      |
|-------------|--------------------------------|---------------------------------------------------------------------|
| Renderer    | `ipcMain.on('analytics:report')` | session.start, session.end, page.view, message.sent, message.received |
| Capacitor / remote | `POST /api/analytics/report`   | same whitelist (enforced by the IPC/HTTP handler)                   |
| Main-native | `analytics.track(...)` direct  | full event catalogue                                                |

The IPC + HTTP handlers both validate the payload shape, enforce the
renderer-allowed event whitelist, and forward to `analytics.track()`. Event
names outside the whitelist are rejected at the boundary.

## Bootstrap & shutdown ordering

Startup (`main/index.ts` + `bootstrap/extended.ts`):

1. `app.whenReady()` → create window.
2. `ready-to-show` → `setImmediate(() => { initializeExtendedServices(); initAnalytics(); })`.
3. `initializeExtendedServices()` registers IPC (`registerAnalyticsHandlers`)
   synchronously, then kicks off `initPlatformAndApps()` async.
4. `initPlatformAndApps()` inits AppManager and Runtime, calls
   `installAppsSubscribers(...)`, and kicks off `runStartupSnapshot(...)`
   fire-and-forget.
5. `runStartupSnapshot()` awaits `analytics.whenSettled(10s)` before
   emitting, so it never loses data to the init race.

Shutdown (`cleanupExtendedServices`):

1. `shutdownAppRuntime()` — deactivates apps, any trailing
   `RunFinishedEvent`s are still delivered to subscribers which enqueue
   them into the telemetry batch.
2. `shutdownAppManager()`.
3. `analytics.destroy()` — telemetry provider flushes the queue with a
   bounded 3s budget, then all providers release.

## Config keys

`config.analytics`:

| Field                | Meaning                                                             |
|----------------------|---------------------------------------------------------------------|
| `userId`             | Anonymous per-install UUID, generated on first launch               |
| `lastVersion`        | Last launched app version (drives `app_install`/`app_update` events)|
| `lastSnapshotRunId`  | Watermark for `app.run.replay` — most recent replayed runId         |
| `lastSnapshotTs`     | Watermark for `app.run.replay` — most recent replayed finishedAt    |

Provider identifiers (read from `product.json` at runtime via
`getAnalyticsConfig()` / `getTelemetryConfig()` — per-variant configuration
committed in the variant repo, never build-time env injection):

| product.json field         | Provider  |
|----------------------------|-----------|
| `analytics.ga.measurementId` | GA4     |
| `analytics.ga.apiSecret`     | GA4     |
| `analytics.baidu.siteId`     | Baidu   |
| `telemetry.endpoint`         | Telemetry |
| `telemetry.apiKey`           | Telemetry |

A missing/empty value disables the corresponding provider cleanly — its
`init()` sets `_initialized = false` and `track()` becomes a no-op.
Open-source builds omit both blocks entirely. Release builds validate the
fields via `scripts/release/verify-inputs.mjs` (declared per variant in
`build-manifest.json.requiredProductFields`).

## Extension points

- **Adding a provider**: implement `AnalyticsProvider`, register in
  `AnalyticsService.initProviders()`, add its identifier fields to the
  `product.json` schema/`ProductConfig` and read them in
  `loadProviderConfig()`.
- **Adding a renderer event**: extend `RENDERER_ALLOWED_EVENTS` in
  `ipc/analytics.ts` and add a whitelist entry in
  `providers/telemetry.ts#EVENT_WHITELIST`. Update `useTelemetry` hook if
  the event is emitted by the renderer shell.
- **Adding a subscriber domain**: add a new file under `subscribers/`
  following the pattern of `apps.subscriber.ts` — return an unsubscribe
  function, isolate every handler with try/catch.
