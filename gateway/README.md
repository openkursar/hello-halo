# Halo Federation Gateway

A standalone Go service that lets Halo nodes in different networks collaborate
in the same office without exposing any node to the internet. It implements
the server role of the Halo federation wire protocol in **relay mode**:

- **Dumb relay** — rooms keyed by office, the host node is the routing hub;
  the gateway reads only envelope routing fields and never interprets business
  payloads. It holds no authority, no whiteboard, and cannot mint credentials.
- **Device-key admission** — sessions prove an Ed25519 identity via a one-shot
  challenge signature. Office invite tokens are opaque to the gateway (may be
  empty for hosts) and are verified end-to-end by the nodes themselves.
- **Room pinning** — the first `gw:host-attach` pins the office to that
  identity. The same identity may always replace its own connection; a
  different identity can take over only after the previous host has been
  disconnected past the retention window (logged as a warning and counted in
  `halo_gw_host_takeovers_total`). Anything else gets `gw:error HOST_CONFLICT`.
- **Discovery directory** — nodes publish signed, TTL-bound endpoint
  announcements for direct-dial optimization. Memory-only; rebuilt by nodes
  after a restart.
- **Invite landing page** — invite links point at the gateway
  (`https://<gateway>/?office=<id>&invite=<token>`); the page hands off into
  the installed app via a `halo://join` deep link. The token is never echoed
  into the served HTML.

Authority mode is a later milestone; configuring `mode: authority` refuses to
start with a clear error.

## 5-minute intranet deployment

### Option A: single binary

```sh
cd gateway
make build                       # -> dist/halo-gateway
./dist/halo-gateway -listen :3100
```

Cross-compile with `make cross` (linux-amd64, linux-arm64, darwin-arm64).

### Option B: Docker

```sh
cd gateway
make docker
docker run -d --name halo-gateway -p 3100:3100 halo-gateway:dev
```

The image is distroless/static and runs as a non-root user.

### Point nodes at it

In Halo, configure the gateway address (e.g. `https://gw.corp.example:3100`)
as the office server URL. Invite links minted afterwards route through the
gateway and stay valid across IP changes of the host machine.

## Configuration

Precedence: flags > `HALO_GW_*` environment variables > YAML file > defaults.
See [config.example.yaml](config.example.yaml) for every knob and default.

```sh
./halo-gateway -config /etc/halo/gateway.yaml
HALO_GW_LISTEN=:8443 HALO_GW_LOG_FORMAT=text ./halo-gateway
```

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `-listen` | `HALO_GW_LISTEN` | `:3100` | HTTP + WebSocket listen address |
| `-config` | `HALO_GW_CONFIG` | — | YAML config path |
| `-tls-cert` / `-tls-key` | `HALO_GW_TLS_CERT` / `HALO_GW_TLS_KEY` | — | serve TLS directly |
| `-log-level` | `HALO_GW_LOG_LEVEL` | `info` | `debug` `info` `warn` `error` |
| `-log-format` | `HALO_GW_LOG_FORMAT` | `json` | `json` or `text` |

## TLS and reverse proxies

- **Direct TLS**: set `tls.cert` / `tls.key` and expose the port.
- **Behind a reverse proxy** (nginx, Caddy, Traefik): terminate TLS at the
  proxy and forward to the gateway over plain HTTP. The proxy **must support
  WebSocket upgrades** on `/ws` (for nginx: `proxy_set_header Upgrade
  $http_upgrade; proxy_set_header Connection "upgrade";`) and should use a
  read/idle timeout above 90 seconds so protocol keepalive pings (every 30s)
  keep connections alive.
- Frame size is capped at 1 MiB; make sure the proxy does not buffer or limit
  WebSocket messages below that.
- Per-IP connection rate limiting uses the TCP peer address. Behind a proxy
  all connections share the proxy's IP, so either raise
  `limits.connPerIPBurst` or rate-limit at the proxy instead.

## Operations

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness probe (always 200 while the process serves) |
| `GET /readyz` | readiness probe (503 while draining for shutdown) |
| `GET /version` | build info JSON |
| `GET /metrics` | Prometheus text format |
| `GET /ws` | WebSocket endpoint for Halo nodes |
| `GET /`, `GET /invite` | invite landing page |

Key metrics: `halo_gw_sessions_active`, `halo_gw_rooms_active`, `halo_gw_host_takeovers_total`,
`halo_gw_frames_forwarded_total{plane}`, `halo_gw_frames_dropped_total{plane}`,
`halo_gw_auth_failures_total`, `halo_gw_rate_limited_total`.

Shutdown: on `SIGTERM`/`SIGINT` the gateway flips `/readyz` to 503, closes all
sessions, and exits (10s hard deadline). Nodes reconnect with their standard
backoff, so rolling restarts are safe.

State is fully in-memory by design — restarts lose only transient relay state
(rooms re-form on reconnect, the directory is re-announced within seconds).

## Development

```sh
make test    # unit + integration tests (real WebSocket connections)
make race    # same, with the race detector
make lint    # go vet + gofmt check
```
