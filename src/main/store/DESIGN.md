# Store Module Design

> Read `.claude/skills/halo-dev` (CONTEXT.md → ARCHITECTURE.md → quick.md) first.
> This document is the contract for `src/main/store/**`. Where it and the code
> disagree, the code wins and this document must be corrected.

## 1. Two axes

The store has exactly two structural axes. Every file belongs to one of them.

| Axis | Unit | Where | Shape |
|---|---|---|---|
| **Source driver** | one registry source | `adapters/` | polymorphism — one class per protocol |
| **Composition** | N sources | everything above `adapters/` | aggregation — merge, project, cache, validate |

A store is **not** a polymorphic object. It is a federation of sources, closer
to `mount` than to a filesystem: several sources are active at once and a
catalog read merges all of them. The community build ships five enabled
sources; an enterprise build ships one (the rest are `hidden: true` via
`product.json`). **A federation of one degrades to an exclusive store for
free** — there is no second design for the enterprise edition, and no code
path that only enterprise takes.

Consequence: adding support for a new registry protocol means adding one file
under `adapters/`, one `case` in `adapters/index.ts`, and one entry in
`STORE_SOURCE_TYPES` (`shared/store/store-types.ts`), from which both the
`RegistrySource` type and the config-validation enum derive. Nothing else
changes.

## 2. The adapter contract

`adapters/types.ts` declares three tiers:

```
required     fetchSpec                       — without it, it is not a source
             fetchIndex   (mirror strategy)
             query        (proxy strategy)

optional     fetchDocument, fetchBundledSkills
catalog

optional     serverFeatures, openInstallOrder, fetchCollections,
backend      fetchMyPublications, unpublish              (per source)
             fetchPageTaxonomy, fetchPageLayout          (primary source only)
```

**Optional means the source decides.** The architecture assigns no work: a
driver that does not implement `fetchCollections` simply has no such method,
and the composition layer's `adapter.fetchCollections?.(source) ?? []` issues
zero requests. This is what replaces the six divergent HTTP-status-code
branches the module used to carry.

Backend methods return `unknown` on purpose. The payload is untrusted remote
data; the driver is responsible for transport only. Validation
(`validateTaxonomy`, `validateLayout`, `mapCollection`, `mapPublication`)
stays in the domain module that owns the resulting shape.

### 2.1 Cardinality: per-source vs primary-only

| Endpoint | Cardinality | Reason |
|---|---|---|
| capabilities handshake | per source | each backend advertises itself |
| install ledger | per source | an install belongs to the source it came from |
| collections | per source | curated bundles merge |
| my publications / unpublish | **primary only** | one identity token ⇒ one attributing store (§3.4) |
| category taxonomy | **primary only** | there is one chip row |
| discover layout | **primary only** | there is one discover page |

Merging N discover layouts has no meaning. Someone must decide, and the
decision follows the existing `isDefault` flag — never a source id or name.

### 2.2 Read degrades, write raises

```ts
// read: absent method → empty result, zero requests
const raw = await adapter.fetchPageLayout?.(source) ?? null

// write: absent method → explicit error, never a silent no-op
if (!adapter.unpublish) throw new Error('This store does not support …')
```

A user pressing "Unpublish" on a store with no backend must be told so.
Nothing happening is the worst possible outcome.

## 3. Invariants (non-negotiable)

### 3.1 The handshake does not decide whether a driver method exists

The server mounts its three subsystems on **different** conditions
(`cmd/registry/server.go`): the install-order route is mounted
unconditionally, `/my/publications` requires the introspector, and
`/capabilities` itself lives inside the admin block together with
collections / taxonomy / discover-layout.

A ledger-only deployment (no admin console) therefore answers `404` on
`/capabilities` while `POST /apps/{slug}/installs` works normally.

> **Never gate a driver method on the handshake result.**
> `if (features.installs) …` before recording an install would silently drop
> every install count in that deployment.

Which methods exist is decided by `sourceType` — a deployment fact, known at
release time. Which surfaces the UI shows is decided by the handshake — an ops
setting, changeable without a client release. Two different questions, two
different mechanisms.

### 3.2 `features.installs` is not "can record installs"

Server side these are two subsystems:

- `capabilities.installs` ← `s.installs != nil` — the index carries
  `meta.installs`, i.e. **display data**.
- the install ledger ← `s.ledger != nil` — the **write side**.

Client side `capabilities.installs` only decides whether `StoreCard` /
`StoreDetail` render an install-count number. It says nothing about whether
opening an install order is possible.

### 3.3 Handshake cache: per source, with stale-retry

The adapters are stateless singletons except for the DHP v2 driver's
handshake cache, which is a `Map` keyed by source URL — a federation may hold
several `dhp-v2` sources, so a module-level single variable would cross-talk.

| Outcome | Cache policy |
|---|---|
| 200 / 404 / 501 | cache for **1 h** |
| 5xx / 429 / network error | keep **last-known** value, retry after **5 min** |

The second row is load-bearing: one backend blip must not lock the read-only
baseline in for an hour.

### 3.4 Identity-bound calls target the primary source only

A build mints one identity token from the one provider declared in
`product.json.identityProvider`, so exactly one store can attribute a
publication to this user. "My publications" therefore reads and unpublishes
against the primary source — reads included.

Federating the read while writing to the primary would be incoherent twice
over: the user could act on a row the write path cannot address, and the
deployment's token would be handed to sources that are not its own (the
built-in set includes third-party brands, and `sourceType` is settable through
the add-registry API).

Collections federate because they carry no credential.

### 3.5 `openInstallOrder` is a three-state contract

| Return | Meaning | Ledger module's action |
|---|---|---|
| `InstallGrant` | authorised | use the granted path |
| `null` | 4xx permanent refusal, or no such endpoint | indexed path, **do not queue** |
| `throw` | 5xx / 429 / network fault | **queue for backfill** |

The split of duty is deliberate: the **driver** decides whether the transport
failure is retryable (protocol semantics); **`install-orders.ts`** decides
whether a retryable failure enters the backfill queue (ledger policy).

### 3.5.1 The ledger hangs off the download, not off an entry point

`acquireSpec()` in `registry.service.ts` is the single place an **install**
acquires its spec, and the only place an order is opened. Every install path —
the store button, an upgrade (auto or manual), a non-bundled skill dependency,
an install an agent performs — reaches it, so a new path is counted without
being told to be. The previous hook sat on the store button alone and missed the
other three.

Three consequences that read as surprises otherwise:

- **A skill dependency counts, every time it is fetched.** It is a separate
  artifact pulled over the network, so re-installing a parent re-downloads and
  re-counts its non-bundled dependencies. That is the caliber working, not a
  leak: bytes moved. It also keeps `AppManager`'s skill-overwrite path, which is
  how a dependency with damaged local files gets repaired.
- **Bundled skills do not count separately.** They travel inside the parent's
  package (`fetchBundledSkills`), so they are already counted as part of it.
- **Each call site resolves its own source.** `installFromStore` resolves by
  slug, `applyUpgrade` by slug + the installed app's `registry_id`. Sharing one
  resolution would open the order against source A and download from source B
  in a federation (§2.1).

Browsing is not installing: `query.service.ts` fetches specs for the detail view
without an order, and must keep doing so.

`installs` therefore means *authorised* downloads: an order is opened before the
transfer, so one that then fails locally still counts. A delivery receipt would
cost a second round trip and would undercount exactly when the receipt is what
gets lost.

### 3.5.2 One install is one intent, not one attempt

The server counts distinct `orderUuid`s. The client mints one per
`(source, slug, version)`, persists it in
`~/.halo/store-install-intents.json`, reuses it for every retry, and drops it
once the download lands (`completeInstallIntent`).

This is load-bearing, not bookkeeping. The upgrade scheduler retries a failed
upgrade every tick and never gives up, so a uuid minted per attempt would bill
one install per device per tick for as long as a release stayed broken —
silently, and indistinguishably from real re-installs. Two deliberate user
installs of the same version are two intents and do count twice.

A client that predates the field sends no uuid and the server falls back to its
old device+app+version key, which never counts a re-install. Both paths are
deleted together, once no client sends the empty value.

### 3.6 Federated aggregation is partial-failure tolerant

`Promise.all` rejects on the first failure, which would make one broken source
blank the whole page — worse than the bug this refactor fixes. Aggregation
uses `Promise.allSettled`:

| Outcome | Behavior |
|---|---|
| all failed | throw — the caller renders a load error |
| some failed | return the successes, `console.warn` the failures |
| all succeeded | merge |

### 3.7 Known deferral: publish target resolution is not federated

`publish/index.ts` still reads `registryOverrides['official'].publish`.
Federating it means the user must *choose* a destination, which is a new UI
flow and an independent feature. It is deliberately out of scope here — not an
oversight, and not a counter-example to §1.

### 3.8 Known deferral: the collections error state is not rendered

`backend/collections.ts` distinguishes "no collections" from "load failed" and
the IPC response carries `success: false` on failure. That distinction stops at
the renderer: `lib/store-resources.ts` maps a failed fetch to `[]`, so the
discover page shows an empty section either way. `createCachedResource` now
drops (rather than caches) a rejection, so the retry path is correct — but a
consumer still only ever receives a value, never a failure, so rendering the
difference needs a UI-level error state and is left as a separate change.

### 3.9 Known deferral: two `sourceType` branches survive above `adapters/`

`query.service.ts` (`supportsType`) and `registry.service.ts` (the
catalog-only preview shortcut for `claude-skills` / `skillhub`) still switch on
`sourceType`. Both predate this design and both encode the same thing: a
*static capability of the protocol* — which app types it can serve, and whether
its detail view needs a network fetch. They belong on the adapter as declared
properties (`supportedAppTypes`, `catalogOnly`), which would delete the
branches outright. That is a behaviour-preserving refactor of the catalog read
path and is deliberately out of scope here; until it lands, these two are the
registered exceptions to §1, like `publish/index.ts` is to §3.7.

## 4. Vocabulary

Identity values name a **capability**, never a provider. A third party running
its own registry must be able to advertise account-level identity without
uttering another company's internal system name.

| Wire (`identityBinding`) | Client (`StoreIdentityMode`) | Meaning |
|---|---|---|
| `account` | `account` | authoritative per-person identity, cross-device |
| `shared` | `shared` | deployment-level shared credential |
| `none` | `none` | anonymous |

Server side the *mechanism* (`auth.type`: `token` / `introspect` /
`token+introspect`) is kept separate from the *strength* it yields
(`identityBinding`). A future mechanism (mTLS, mutual OIDC, …) that also
reaches account strength changes `auth.type` only; no client changes.

## 5. Persistence

`~/.halo/store-install-orders.pending.json` — the backfill queue, de-duplicated
by `orderUuid` so a retry of one intent does not queue twice while a genuinely
new intent does.

`~/.halo/store-install-intents.json` — the live intent per
`registryId|slug@version` (§3.5.2), capped at 200 entries. Minting an intent for
an app drops any other intent for the same app on the same source: an app has at
most one install in flight per source.

`~/.halo/store-install-id` — the device identifier, owned by the store rather
than by telemetry so counting survives analytics being disabled.

Older queue entries lack `orderUuid` (replayed under the server's legacy key) or
`registryId` (resolved against the primary source). Both reproduce the previous
behaviour exactly, so no versioned migration is required.

Source resolution is **injected** into `flushPendingInstallOrders`. The ledger
module imports nothing from `registry.service`, which is what keeps the two out
of an import cycle now that the composition layer calls the ledger.

## 6. File map

Directories are named after responsibility. `backend/` is the layer that
consumes the *source's* backend surface (§2) — it is not server code; nothing
in it runs anywhere but the main process.

```
adapters/                 source drivers — the only polymorphic layer
  types.ts                the contract
  index.ts                sourceType → driver (the discoverable catalogue)
  halo.adapter.ts         DHP static source (GitHub Pages / mirror), catalog only
  dhp-v2.adapter.ts       DHP v2 full protocol: catalog (delegated to Halo)
                          + 7 backend endpoints + handshake + wire vocabulary
  mcp-registry / smithery / skillhub / claude-skills

backend/                  consumers of the backend surface
  sources.ts              the two read cardinalities: federated aggregation
                          (§3.6) and primary-source page documents (§2.1)
  capabilities.ts         projection: primary source features + publish target
  install-orders.ts       install ledger: installId, backfill queue, retry policy
  collections.ts          federated aggregation + payload mapping
  publications.ts         federated read / primary write + NOT_SIGNED_IN semantics
  taxonomy.ts             server ?? product.json ?? built-in
  discover.ts             server ?? built-in
  identity.ts             identity-token resolution (product.json → AI-source OAuth)

registry.service.ts       source config, CRUD, install/upgrade orchestration
query.service.ts          catalog aggregation (already federated)
sync.service.ts           mirror sync → SQLite
registry.cache.ts, store-cache.schema.ts, upgrade.service.ts, registry.types.ts

publish/                  publish dispatchers (see §3.7)
dhpkg/, skill-pkg.ts      packaging
```

## 6.1 Vocabulary

One concept, one word: this module is the **store**. `Marketplace` survives only
as the user-facing label of the Apps page tab (`t('Marketplace')`) and the
navigation action named after it; no type, function, file, or directory carries
it.

## 7. Checks that must keep passing

- `getOfficialRegistryUrl` does not exist.
- `'official'` appears in `registry.service.ts` only at its definition
  (`BUILTIN_REGISTRIES[0].id`); `publish/index.ts` is the registered
  exception of §3.7.
- `fetchWithTimeout` is called only from inside `adapters/`.
- `sourceType` is switched on only in `adapters/index.ts`; `query.service.ts`
  and `registry.service.ts` are the registered exceptions of §3.9.
- The protocol list is written once, in `STORE_SOURCE_TYPES`
  (`shared/store/store-types.ts`); the config schema derives its enum from it.
- No file above `adapters/` reads an HTTP status code. (Each driver reads its
  own protocol's codes; `publish/dispatchers/*` read their upload responses.
  The rule is about the composition layer, not about a single file.)
- A community build entering the store and installing an app issues **zero**
  requests to `/installs`, `/collections`, `/my/publications`,
  `/category-taxonomy.json`, `/discover-layout.json`.
