# Decentralized Office — Local Multi-Node Testing

How to exercise the distributed digital office (federation) end-to-end on a
**single machine**, driving everything over HTTP with no UI clicks. This lets an
automated driver (a script, CI, or an AI agent) stand up N real federation nodes,
have them join one virtual office, and assert the collaboration — without N
physical computers.

> Scope: this validates the **functional** federation path (join / presence /
> remote roster / run). Resilience behaviour (authority handover, network
> partition, clock skew) is intentionally **not** faithfully reproducible on one
> machine — see [Limitations](#limitations).

---

## TL;DR

```bash
# 1. Build once (produces out/main/index.mjs)
npm run build

# 2. Configure the model in .env.local (gitignored) — see "Model config" below

# 3. Start a 3-node cluster (auto-reads .env.local)
node scripts/cluster/launch-nodes.mjs start --nodes 3 --fresh

# 4. Drive the full join → presence → run flow over HTTP
node scripts/cluster/demo-federation.mjs

# 5. Tear it down
node scripts/cluster/launch-nodes.mjs stop
```

The launcher writes a machine-readable manifest to `.cluster/nodes.json` with
each node's port, token, and federation identity — everything a driver needs.

> These are AI/script-driven test entrypoints, invoked directly with `node`
> (intentionally not wired into `package.json` scripts, which are a human-facing
> surface).

---

## Why this works

Each node is a real, independent Halo instance. They stay isolated because the
launcher gives every node its own environment:

| Concern | Mechanism | Effect |
|---|---|---|
| Single-instance lock | `HALO_E2E_TEST=1` | Multiple instances may run at once |
| On-disk state | unique `HOME` + `HALO_DATA_DIR` per node | Separate config, DB, spaces |
| Node identity | derived from a keypair in `<dataDir>/node-identity.json` | Each node = a distinct federation node id |
| HTTP/WS port | unique `remoteAccess.port` per node | No port contention; one server per node |
| Auth | a known PIN seeded into each node's config | Driver authenticates with `Authorization: Bearer <pin>` |

Nodes connect over the loopback interface: a joiner points its federation client
at the host's `ws://127.0.0.1:<hostPort>` (the host already listens on
`0.0.0.0`).

---

## Model config

Agents need a model to actually run. The launcher reads it from `.env.local` at
the project root (gitignored — never commit real keys). The E2E names are reused
so one config serves both E2E and the cluster:

```bash
# .env.local  (OpenAI-compatible endpoint example: Zhipu GLM Coding Plan)
HALO_TEST_API_KEY=<your-key>
HALO_TEST_API_URL=https://open.bigmodel.cn/api/coding/paas/v4
HALO_TEST_MODEL=glm-5.2
HALO_TEST_PROVIDER=custom
```

Cluster-specific overrides (`HALO_TEST_MODEL_API_KEY`, `HALO_TEST_MODEL_BASE_URL`,
`HALO_TEST_MODEL_ID`, `HALO_TEST_MODEL_PROVIDER`) take precedence when set. An
explicit shell env always wins over `.env.local`.

> The endpoint is treated as OpenAI-compatible: the base URL is normalized to
> `.../chat/completions`. For a native Anthropic endpoint set
> `HALO_TEST_PROVIDER=anthropic` and use the Anthropic base URL.

---

## CLI reference

```bash
# Start (defaults: --nodes 3, --base-port 3460, --cluster .cluster)
node scripts/cluster/launch-nodes.mjs start [--nodes N] [--base-port P] [--cluster DIR] [--build] [--fresh]
#   --build   run "npm run build" first
#   --fresh   delete the cluster dir before starting (reset all node state)

# Stop all nodes recorded in the manifest (node data dirs are preserved)
node scripts/cluster/launch-nodes.mjs stop [--cluster DIR]

# Reference driver: join → presence → run, with assertions
node scripts/cluster/demo-federation.mjs [--cluster DIR]
```

Node `i` listens on `base-port + i` (e.g. base 3460 → nodes on 3461, 3462, 3463).

---

## The manifest: `.cluster/nodes.json`

```jsonc
{
  "createdAt": "…",
  "clusterDir": "…/.cluster",
  "model": { "baseUrl": "…", "modelId": "glm-5.2", "provider": "custom", "hasKey": true },
  "nodes": [
    {
      "index": 1,
      "pid": 71539,
      "port": 3461,
      "baseUrl": "http://127.0.0.1:3461",
      "wsUrl": "ws://127.0.0.1:3461",
      "token": "HaloNode-1-Aa1!",          // bearer PIN for this node
      "identityId": "id_vfVsaMgaAr7T4uCHR…", // federation node id
      "dataDir": "…/.cluster/node-1/.halo",
      "logFile": "…/.cluster/node-1/node.log",
      "ready": true
    }
    // … one per node
  ]
}
```

A driver reads this file, treats `nodes[0]` as the host and the rest as joiners,
and calls each node's HTTP API with its `token`.

---

## Federation HTTP control-plane

These routes mirror the desktop-only IPC surface so a node can be driven purely
over HTTP. They are **control-plane**: reachable only by the node's own
remote-control PIN (an office-member credential is rejected with 403).

| Method & path | Purpose |
|---|---|
| `POST /api/teams/:officeId/join` | Join an office hosted elsewhere, bringing local digital humans. Body: `{ serverUrl, inviteToken, bringAppIds }` |
| `POST /api/teams/:officeId/leave` | Leave a joined office |
| `GET /api/teams/:officeId/federation/presence` | Read node presence + authority view: `{ officeId, role, nodes[], authority }` |

Supporting routes used by the flow (all under `Authorization: Bearer <pin>`):
`POST /api/spaces`, `POST /api/teams`, `POST /api/teams/:id/invite`,
`PATCH /api/teams/:id` (set `leadAppId`), `POST /api/teams/:id/run`,
`GET /api/teams/:id/detail`, `GET /api/teams/:id/chat-messages?appId=`.

### Example: drive a node by hand

```bash
# Host mints an invite
curl -s -X POST http://127.0.0.1:3461/api/teams/$OFFICE/invite \
  -H "Authorization: Bearer HaloNode-1-Aa1!" -H 'content-type: application/json' -d '{}'

# A joiner joins, bringing one of its local digital humans
curl -s -X POST http://127.0.0.1:3462/api/teams/$OFFICE/join \
  -H "Authorization: Bearer HaloNode-2-Aa1!" -H 'content-type: application/json' \
  -d '{"serverUrl":"http://127.0.0.1:3461","inviteToken":"'"$TOKEN"'","bringAppIds":["'"$APP"'"]}'

# Host reads presence
curl -s http://127.0.0.1:3461/api/teams/$OFFICE/federation/presence \
  -H "Authorization: Bearer HaloNode-1-Aa1!"
```

The reference driver `scripts/cluster/demo-federation.mjs` automates exactly this.

---

## Limitations

Single-machine simulation faithfully covers the M1 functional path but distorts
or omits some behaviours — do not treat a green local run as proof of these:

- **Presence jitter under contention.** N Electron processes plus N model
  streams on one machine starve the CPU, delaying heartbeats; a node can flap
  `online → suspect → online`. On real machines the heartbeat budget is not
  contended. Treat brief flapping locally as an artifact, not a bug.
- **No real network faults.** Partition, packet loss, latency, and NAT are not
  reproduced over loopback. Resilience criteria (authority handover / partition
  convergence) need fault-injection hooks and/or real multi-machine runs.
- **Shared wall clock.** Clock-skew assertions cannot be exercised; every node
  reads the same system clock.
- **Not headless.** Each node opens a hidden window (`show:false`); extended
  services initialize on `ready-to-show`. The window exists but is not shown.

For M2 resilience (handover, partition, clock skew) prefer real machines, VMs, or
containers plus programmable fault injection.

---

## Cleanup & reset

- `npm run cluster:stop` terminates the node processes; data dirs are kept so you
  can re-run against the same state.
- `--fresh` on the next start (or deleting `.cluster/`) resets all node state and
  identities.
- `.cluster/` is gitignored; it holds isolated node data, logs, and the seeded
  config (which contains the model key). Never commit it.

---

## File map

| Path | Role |
|---|---|
| `scripts/cluster/launch-nodes.mjs` | Launcher: seed config, spawn N isolated nodes, write `nodes.json` |
| `scripts/cluster/demo-federation.mjs` | Reference driver: join → presence → run with assertions |
| `.cluster/nodes.json` | Manifest consumed by drivers |
| `.env.local` | Model config (gitignored) |
| `src/main/http/routes/team.routes.ts` | The `join` / `leave` / `federation/presence` routes |
| `src/main/controllers/team-invite.controller.ts` | `joinTeamOffice` / `leaveTeamOffice` business logic |
| `src/main/apps/runtime/federation/manager.ts` | `getOfficePresence()` read model |
