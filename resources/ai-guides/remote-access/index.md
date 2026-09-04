# Remote Access — HTTP API, Auth, and the Internet Tunnel

Last updated: 2026-09-03

Read this whenever the user wants to control Halo from another device, asks about the HTTP/API
surface, wants an internet-reachable URL (not just LAN), or reports remote access failing to
enable/connect. This topic has no companion documents — everything is in this file.

## 1. Concept: three layers, one shared credential

- **HTTP/WebSocket server** — Express 5 on plain Node `http` (no TLS anywhere in
  `src/main/http/server.ts` — confirmed by `import { createServer } from 'http'`, no
  `https`/cert code). WebSocket mounted at `/ws` on the same server
  (`src/main/http/websocket.ts:6,30`).
- **Auth subsystem** — a single shared password/PIN, not per-user accounts
  (`src/main/http/auth/*.ts`).
- **Optional internet tunnel** — Cloudflare Tunnel (`cloudflared` package, spawned as a child
  process), for reaching Halo from outside the LAN without port-forwarding
  (`src/main/services/remote/tunnel.ts`).

All three are controlled from **Settings → Remote Access** (`RemoteAccessSection.tsx`), and all
API access — local or tunneled — uses the exact same bearer token/password. There is no separate
"internet" credential.

**Do not confuse this with `ai-terminal`/SSH** — Remote Access is Halo's own HTTP+WebSocket API
for driving Halo itself from another device/script; it has nothing to do with SSH sessions the
agent might open as part of a task.

## 2. Configuration — shortest path

1. Open **Settings → Remote Access** (设置 → 远程访问).
2. Read the security warning first — it is not boilerplate: *"After enabling remote access,
   anyone with the password can fully control your computer (read/write files, execute
   commands). Do not share the access password with untrusted people."*
   (`RemoteAccessSection.tsx:189-199`). This is accurate — the bearer token grants access to the
   file system (via Artifacts endpoints), a real shell (via Terminal endpoints), and the full
   agent chat interface, not a read-only view.
3. Toggle **Enable Remote Access** on. This calls `enableRemoteAccess()`
   (`src/main/services/remote/service.ts`), which starts the HTTP server on the configured port
   (default **3456** — from the persisted config default, `config.service.ts:888-891`; a
   different constant `DEFAULT_PORT = 3847` also exists in `server.ts:39` but is dead code under
   normal app flow since `service.ts` always resolves the port from config first) and generates
   or reuses a persisted access password.
4. Note the **Local Address** (`http://localhost:<port>`) and **LAN Address**
   (`http://<lan-ip>:<port>`) shown, or the **Access Password** if a device needs to type it in
   manually. Both have Copy buttons.
5. For internet access beyond the LAN, use the **Internet Access (Tunnel)** section (§4) — this
   is a separate, optional step. This whole section is hidden entirely when the build's
   `security.tunnelSafe` policy disables it (`RemoteAccessSection.tsx:373`) — if it's missing,
   check whether the build disallows it before assuming it's a bug.

### Access password

- Auto-generated: 12 characters, guaranteed one uppercase/lowercase/digit/special char, charset
  excludes visually-ambiguous characters (`I`/`O`/`l`/`o`/`0`/`1`)
  (`src/main/http/auth/token-store.ts:16-31,38-68`).
- Custom password allowed, policy: 8–64 characters, must include upper+lower+digit (special char
  optional — the code comment explicitly notes this is to keep it typeable on mobile keyboards)
  (`src/shared/auth/password-policy.ts:16-54`).
- Persisted in `config.json` under `remoteAccess.password`; masked like other credentials and
  encrypted at rest if the build's `credentialAtRestSafe` flag is on (same mechanism as email
  credentials, see `email-setup/index.md` §2 "Credential storage").
- **Regenerate** creates a brand-new random token immediately (`regeneratePassword()`,
  `service.ts:444-458`) — there is no expiry/auto-rotation otherwise; a token is durable until
  the user changes it.
- If the stored password can't be decoded on enable (corrupted/key-mismatch), Halo does **not**
  silently issue a new one — it disables remote access and throws `CredentialRestoreError`
  (code `CREDENTIAL_RESTORE_FAILED`), requiring the user to re-enable and re-pair every device
  (`service.ts:104-144`).

## 3. Headless "Server Mode" — a third, separate deployment context

Everything above describes the desktop Electron app with Remote Access toggled on. There is also
a **headless server mode**, gated by `HALO_SERVER_MODE=1`
(`src/main/foundation/runtime-mode.ts:11-17`), where Halo boots with no Electron window and only
serves the Remote Access HTTP+WebSocket stack — used for container/server deployments, not
desktop use. Don't conflate this with "regular Halo with Remote Access on":
- **Different default port: 8080**, not 3456 — `getServerPort()` reads `PORT`, then
  `HALO_SERVER_PORT`, falling back to `8080` (`runtime-mode.ts:20-27`). `bootServerMode()` passes
  this straight into `enableRemoteAccess(port)`, overriding the normal persisted-config default
  (`server-mode.ts:56,69`; `service.ts:98-118`).
- **Password comes from `HALO_REMOTE_PASSWORD`**, defaulting to the literal string `halo123` if
  the env var is unset and no password was already persisted
  (`src/main/foundation/env-config.ts:15,25,46-51`). Anyone deploying headless must set this env
  var explicitly — never tell a user the default is safe to leave as-is.
- This mode is for scripted/automated deployment, not something a desktop end user toggles from
  Settings — don't suggest `HALO_SERVER_MODE` to a user who's just trying to reach their desktop
  Halo from a phone; that's the ordinary Settings → Remote Access flow in §2.

## 4. The HTTP/WebSocket surface

All business endpoints live under `/api/*` and require the bearer token (or `?token=` query
param) except two public ones: `POST /api/remote/login` (validates a submitted token and answers
`{success:true}` — it sets no cookie and creates no session; every later request still carries the
bearer token, `src/main/http/auth/middleware.ts:109-143`) and
`GET /api/remote/status` (liveness probe) — both in `src/main/http/server.ts:194,197-206`.
`GET /api/security/policy` is also public (renderer-safe policy slice).

Route groups (each in its own file under `src/main/http/routes/`), roughly in the order a client
would use them:
- **`agent.routes.ts`** — the core chat surface: `POST /api/agent/message` sends a message to a
  conversation; `stop`/`approve`/`reject`/`answer-question` control an in-flight run;
  `GET /api/agent/sessions` lists active sessions. `POST /api/agent/message`'s actual body fields
  (`agent.routes.ts:13`): required `spaceId`, `conversationId`, `message`; optional
  `resumeSessionId`, `images`, `thinkingEnabled`, `knowledgeBaseId` (routes the turn through a
  bound knowledge base). There is **no `aiBrowserEnabled` field** — it is not destructured or
  used anywhere on this path; if you see it referenced elsewhere, don't send it, it's silently
  dropped. Response is `{success:true}` on success or `{success:false, error}` — no `data`
  payload.
- **`space.routes.ts`** — spaces and conversations CRUD, including message history.
- **`apps.routes.ts`** — the largest route file (~40 endpoints): install/list/manage digital
  humans, chat with an app, IM-channel sessions, escalation responses, spec import/export,
  permission grant/revoke, schedule frequency, pause/resume/trigger.
- **`artifact.routes.ts`** — file browser/editor over a space's working directory (read, write,
  rename, move, delete, download), guarded by symlink-resolving path checks in
  `routes/_shared.ts:143-213` that reject anything outside the space directory.
- **`terminal.routes.ts`** — remote shell takeover (create/input/resize/kill/replay). The file's
  own header comment is explicit that this adds no *new* privilege beyond what the bearer token
  already grants via the agent, and that remote callers cannot choose an arbitrary shell binary
  (`terminal.routes.ts:6-13,44-45`). Returns `403` on platforms where terminal isn't available.
- **`config.routes.ts`, `ai-sources.routes.ts`** — read/write app config and AI provider setup.
- **`im.routes.ts`, `notify.routes.ts`** — IM channel and notify-channel status/testing (see
  `message-channels/index.md` and `email-setup/index.md` for what these actually configure).
- **`store.routes.ts`, `tlon.routes.ts`, `system.routes.ts`** — app store operations, knowledge
  base ("Tlon") management, version/analytics.
- **Webhook ingress at `/hooks`** (not under `/api`) is a distinct trust boundary — its own 256KB
  body-size limit and per-hook HMAC auth owned by the automation runtime's webhook subscription
  source, mounted ahead of all `/api` auth (`server.ts:44-108`). This exists for external callers
  (e.g. third-party services posting events), not for remote-control clients.

WebSocket (`/ws`) message types: `auth`, `subscribe`, `unsubscribe`, `ping`, plus terminal
streaming (`terminal-input`, `terminal-resize`, `terminal-attach`, `terminal-detach`,
`terminal-ack`) — every type except `auth`/`ping` requires the connection to have already
authenticated (`websocket.ts:91-198`).

There is no OpenAPI/Swagger spec file anywhere in the repo — the route list above is the ground
truth; don't invent additional endpoints.

## 5. Internet Access (Tunnel)

Uses Cloudflare Tunnel (`cloudflared`), not a Halo-run relay. Two modes:
- **Named tunnel** (permanent hostname) — obtained once from an issuer service via the device's
  own persistent identity, then works fully offline afterward (grant cached locally). Credentials
  are written to `~/.{dataFolderName}/tunnel/credentials.json` and `config.yml`, both mode `0600`
  (`tunnel.ts:119-152`). `dataFolderName` is a build-time value from `product.json`
  (`getDataFolderName()`, `src/main/foundation/product-config.ts:459-467`), `halo` in the
  open-source template — resolve it before quoting a literal path to the user.
- **Quick tunnel** (random `*.trycloudflare.com`) — automatic fallback when the issuer is
  unreachable, rate-limited, or rejects the device.

**"Change address"** revokes the current hostname at the issuer and reissues a new one — the old
address is immediately dead and cannot be reclaimed (`service.ts:303-336`). The QR code shown in
Settings only appears once a tunnel is actually running (never for LAN-only), because a LAN URL
would silently fail off-network — this is a deliberate UI choice, not a missing feature
(`service.ts:381-386`). It encodes the public tunnel URL, optionally with `?token=` appended for
one-tap auto-login.

Cloudflare's edge terminates TLS on the public hostname, so tunneled traffic is encrypted between
the remote client and Cloudflare — but the local hop from `cloudflared` to Halo's own HTTP server
is still plain HTTP (§1). LAN-only access (no tunnel) is unencrypted end-to-end.

## 6. Verification

- `GET /api/remote/status` (no auth needed) returns `{active, clients, version}` — use this to
  confirm the server itself is up.
- **"Connected Devices" in the UI is a live WebSocket connection count**
  (`getClientCount()`, `websocket.ts:256-258`), **not** a persisted list of paired devices with
  names/history. Don't tell a user they can "see all devices that have ever connected" — that
  view doesn't exist; it only shows current, live connections.
- Successful login via `POST /api/remote/login` (or the WebSocket `auth` message) is the
  functional definition of "the password works" — a `200`/successful auth response is sufficient
  proof; no separate "test connection" button exists for Remote Access itself (unlike the
  notify-channel Email/WeCom Test buttons).

## 7. Diagnostics

| Symptom | Cause | Response / source |
|---|---|---|
| `401 {error:'No authorization token'}` | Request to `/api/*` sent with no token | `src/main/http/auth/middleware.ts:89-92` |
| `401 {error:'Invalid token'}` | Wrong password/token | `middleware.ts:98,142` |
| `429`, header `Retry-After`, `{error:'Too many failed attempts...', code:'LOCKED'}` | Per-IP (5 fails/5 min → 15 min lock) or per-credential (10 fails/60 min → 30 min lock) lockout tripped | `src/main/http/auth/rate-limit.ts:17-26,92-97`; `middleware.ts:114-126` |
| Desktop notification "Remote access locked" / "Remote access: suspicious activity" | Lockout just triggered (target-lockout vs IP-lockout respectively) | `src/main/http/auth/alert.ts:11-43` |
| Toggle-on fails with a decode/credential error | Stored password blob is corrupted or the encryption key changed | `CredentialRestoreError`, code `CREDENTIAL_RESTORE_FAILED` — user must re-enable and re-pair every device (§2) |
| App silently binds a different port than expected | Configured port was already in use; Halo auto-retried up to 20 sequential ports | `src/main/http/server.ts:110-136` |
| Enable fails outright with "no available port" | All 20 fallback ports were also occupied | `Error('Unable to find available port near ${startPort}')`, `server.ts:135` |
| Remote client can't reach the LAN address at all, no error shown anywhere | Likely a firewall silently dropping inbound connections | **Not detected by Halo** — the server just binds and listens; there is no client-visible error for this case, don't imply one exists |
| `403 {error:'Terminal is not available on this host'}` | Platform doesn't support the terminal feature | `terminal.routes.ts:19-23` |
| `403 {error:'Access denied'}` on an Artifacts call | Path resolves outside the space's allowed directory (symlink or `..` traversal) | `routes/_shared.ts:207-209` |
| Tunnel fails to start: "the issuing service was unreachable" | Network issue reaching the issuer, or offline | `issuer-client.ts:66-70` |
| Tunnel fails to start: "Your network reached today's limit..." | Issuer rate-limited this network/device (daily quota) | `issuer-client.ts:74-77` (HTTP 429 from issuer) |
| Tunnel fails to start: device identity rejected | Issuer returned 403 for this device identity | `issuer-client.ts:79-83` |
| Tunnel shows "disconnected unexpectedly" mid-session | The `cloudflared` child process died | `tunnel.ts:488-490` — Halo does not auto-restart it silently; the UI surfaces the error |
| Entire Internet Access section missing from Settings | Build's `security.tunnelSafe` policy disables the tunnel feature entirely | `RemoteAccessSection.tsx:373`, enforced again server-side (`tunnel.ts:162-165,283-286`) and at the IPC boundary (`src/main/ipc/remote.ts:78-86,164-170`) — not a bug |

## 8. Never ask the user

- **Don't offer to "set up HTTPS/TLS" for local/LAN Remote Access.** The server is plain HTTP by
  design; there is no TLS configuration surface anywhere in the code. If the user is worried
  about exposure beyond their own LAN, point them at the Tunnel (§4), where Cloudflare's edge
  provides TLS — not at a local certificate setup that doesn't exist.
- **Don't suggest changing the default port from 3847.** That constant is unused dead code in
  practice; the real, user-facing default is 3456 (§2) and is what actually gets applied.
- **Don't offer per-device accounts, usernames, or multi-user login.** Auth is a single shared
  password for the whole install (§2) — there is no user/account concept to configure.
- **Don't promise a persistent "device management" screen** (rename/revoke individual paired
  devices). The only device-related UI is a live connection counter (§5); there is nothing to
  manage per device beyond regenerating the one shared password.
- **Don't imply mDNS/Bonjour auto-discovery exists.** No such code exists anywhere in
  `src/main/services/remote/` or `src/main/http/` — pairing is manual: copy the address or scan
  the QR code shown in Settings.
- **Don't tell the user Halo will warn them if a firewall is blocking the connection.** It won't
  — there is no detection for this case (§6); troubleshoot it as a networking question, not a
  Halo bug.
