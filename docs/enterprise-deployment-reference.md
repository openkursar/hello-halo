# Enterprise Deployment — Reference

Advanced reference manual. Prerequisite for reading this: you have already produced your first enterprise dmg following [`enterprise-deployment.md`](./enterprise-deployment.md).

Read this on demand; you don't need to read it top to bottom.

> 中文: [`enterprise-deployment-reference.zh.md`](./enterprise-deployment-reference.zh.md)

---

## Table of Contents

- [Architecture Rationale](#architecture-rationale)
- [`product.json` Field Reference](#productjson-field-reference)
- [Security Policy in Detail](#security-policy-in-detail)
- [Custom Provider](#custom-provider)
- [Cross-platform Builds](#cross-platform-builds)
- [Multiple Vendors Side by Side](#multiple-vendors-side-by-side)
- [Upgrading hello-halo](#upgrading-hello-halo)

---

## Architecture Rationale

### Three-layer model

```
Layer 1 — hello-halo/                  Public OSS
└── halo-local/                        Layer 2 — personal private workspace
    └── <vendor>/                      Layer 3 — enterprise overlay
```

Each layer is aware only of itself and its parent layer — **not of child layers, not of sibling layers**.

| Layer | Owned by | Committed to | Contains |
|---|---|---|---|
| 1 | Halo open-source community | github.com/openkursar/hello-halo | UI, Agent SDK, all general capabilities |
| 2 | You (individual / team) | your own private git (e.g. GitHub Private, private Gitea) | tools shared across enterprises, personal dev scaffolding |
| 3 | A specific enterprise team | that enterprise's intranet git | branding, Provider, security policy specific to that enterprise |

### Why nested directories instead of Git submodules

A submodule writes the "submodule's commit pointer" into the parent repo's version control. This means:

- hello-halo's commit history would contain `halo-local @ <sha>` — the public repo leaks the fact that a private repo exists
- adding a new vendor requires modifying the parent repo's `.gitmodules` — the parent layer is forced to be aware of a child layer

With the nested-directory + `.gitignore` approach, each layer is a fully independent git repo, and the parent repo's `git status` cannot see the child repo's existence.

### How the `.gitignore` chain works

```
hello-halo/.gitignore               contains  halo-local/
hello-halo/halo-local/.gitignore    contains  <vendor>/
```

Each layer excludes the next one. When `git status` reaches `halo-local/` it is stopped by the parent layer's `.gitignore` and never descends; when it reaches `<vendor>/` it is stopped by the middle layer's `.gitignore`. **No layer can "see" or "accidentally commit" the contents of the layer below it.**

### What each layer does

**Layer 1 (hello-halo)**: keeps open-source defaults and **never leaves a hole for any specific enterprise**. All vendor differentiation goes through `product.json` config or overlay injection; no enterprise name ever appears in the source.

**Layer 2 (halo-local)**: your private workbench. Things commonly placed here:

- Provider code shared across multiple vendors (if you do integrations for N enterprises)
- small utility scripts for personal development
- your local experiment artifacts
- `node_modules/` (so each vendor doesn't install its own copy)

If you serve only one enterprise, Layer 2 can be almost empty, serving merely as a "container".

**Layer 3 (`<vendor>/`)**: content entirely centered on that one enterprise. Branding, config, intranet URLs, sample SSO credentials (not real ones), private Provider source, build scripts, ops scripts, internal docs.

---

## `product.json` Field Reference

Authoritative schema: `product.schema.json` (with `$schema` configured in your IDE you get full hints).

Grouped below by usage scenario.

### Basic metadata

```json
{
  "name": "Halo Acme",
  "dataFolderName": "halo-acme",
  "version": "1.0.0"
}
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | About page, menu bar, Dock name |
| `dataFolderName` | No | User data directory name, determines `~/.{dataFolderName}/` and the Electron `userData` path. **Must differ per vendor**, otherwise data gets mixed up. Validation: `^[a-z][a-z0-9-]*$` |
| `version` | Yes | Product version number (independent of `package.json#version`) |

### Update source

```json
"updateConfig": {
  "provider": "generic",
  "url": "https://release.acme.intra/halo/"
}
```

| `provider` | Required fields | Description |
|---|---|---|
| `github` | `owner`, `repo` | Pull updates from GitHub Releases, for the public build |
| `generic` | `url` | Pull updates from any HTTP static service, for the enterprise intranet |

If you don't need auto-update, **delete the entire `updateConfig` block**.

### Sign-in — three forms

Each item in the `authProviders` array can be one of three forms:

**Form 1 — built-in Provider:**

```json
{ "type": "claude", "builtin": true, "enabled": true, ... }
```

Directly enables a Provider already implemented in hello-halo (e.g. `claude`, `custom`, `github-copilot`).

**Form 2 — Preset API (90% of enterprises use this):**

```json
{
  "type": "preset-api",
  "preset": {
    "baseUrl": "https://ai-gateway.acme.intra/v1",
    "apiType": "chat_completions",
    "modelsPath": "/models",
    "fallbackModels": [{ "id": "gpt-4", "name": "GPT-4" }]
  }
}
```

Use this whenever the enterprise AI gateway is compatible with OpenAI Chat Completions (or the Responses / Anthropic protocols). **Zero code** — just set baseUrl.

`apiType` options: `chat_completions` (most common) / `responses` / `anthropic_passthrough` / `kiro`.

> The renderer routes a provider to the preset form by the **presence of the `preset` field**, not by the literal `type` string; `preset-api` is just the recommended type value.

**Form 3 — custom Provider:**

```json
{
  "type": "acme-sso",
  "path": "./halo-local/acme/build/dist/providers/acme/index.js",
  ...
}
```

Use this when you need an SSO / OAuth flow, special authentication, or a custom protocol. See [Custom Provider](#custom-provider).

### Browser policy

```json
"browserPolicy": {
  "mode": "allowlist",
  "allowlist": ["*.acme.com", "10.0.0.0/8"],
  "homepage": "https://intranet.acme.com"
}
```

| `mode` | Behavior |
|---|---|
| `unrestricted` | No restriction (OSS default) |
| `allowlist` | Only the listed targets are allowed |
| `blocklist` | The listed targets are forbidden, everything else is allowed |

Entries support:

- Exact domain: `intranet.acme.com`
- Wildcard: `*.acme.com`
- IPv4 CIDR: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`

`homepage` is the default URL for a new tab when the policy is in effect; omit it to use `about:blank`.

### Security policy

See [Security Policy in Detail](#security-policy-in-detail).

### Telemetry

```json
"telemetry": {
  "allowedSensitiveFields": ["modelName", "sourceName", "errorCode"]
}
```

By default OSS drops all "sensitive fields". When an enterprise runs its own telemetry backend, allow them as needed. The allowable key names are listed in the schema.

---

## Security Policy in Detail

The 4 switches under `product.json#security` are authoritatively defined in [`src/main/services/security-policy.ts`](../src/main/services/security-policy.ts).

### `tunnelSafe`

When on, the Cloudflare Quick Tunnel is disabled across all three layers:

- Service layer: `startTunnel()` short-circuits and no longer spawns the `cloudflared` subprocess
- IPC layer: `remote:tunnel:enable` is rejected outright (`remote:tunnel:disable` is not blocked, so it can clean up a tunnel that was already running before the policy was turned on)
- UI layer: the "Internet Access" subsection in remote-access settings and the Cloudflared row in system diagnostics are not rendered

**When to use**: any intranet deployment. Cloudflare Tunnel bypasses the corporate proxy and exposes the local HTTP service directly to the public internet, which nearly all compliance requirements forbid.

### `remoteMcpSafe`

When on, all remote HTTP entry points reject any write that could land an MCP server configuration:

| Endpoint | Interception condition |
|---|---|
| `POST /api/apps/install` | `type === 'mcp'` in the AppSpec |
| `POST /api/apps/import-spec` | `type === 'mcp'` after YAML parsing |
| `PATCH /api/apps/:id/spec` | the patch touches the `mcp_server` field, or the target app is already mcp |
| `POST /api/config` | the body touches the `mcpServers` map |
| `POST /api/store/install` etc. | the resolved spec has `type === 'mcp'` |

Returns HTTP 403 with error code `MCP_REMOTE_INSTALL_FORBIDDEN`.

**The local desktop UI is unaffected** — when a user installs an MCP from the settings panel, they still see the full command and confirm it manually.

**When to use**: scenarios with remote access enabled, to prevent a remote caller from landing arbitrary native commands on the user's machine.

### `credentialAtRestSafe`

When on, the remote-access credential is encrypted at rest with **SM4-CBC + HMAC-SM3 (encrypt-then-MAC)**. The encryption key is derived via **HKDF-SHA-256** from a persisted random master key (`userData/cred.key`, generated randomly on first run with `0o600` permission), which stays stable across restarts, network changes, and hardware reconfiguration.

> Earlier versions derived the key from hostname + first non-internal MAC, but these values are unstable in real deployments (dock/undock, VPN, virtual adapters, DHCP renames), causing key drift, ciphertext MAC verification failure, and credentials being wiped. The hardware-derived seed is now retained only as a legacy fallback for decrypting old ciphertext; once read, the value is migrated to the master key and re-encrypted.

When off (OSS default), the credential is stored in plain text.

> Threat boundary: `cred.key` and `config.json` are both readable by the same OS user, so this is compliance-oriented encryption-at-rest, not a defense against an attacker who already has that user's filesystem access — it only prevents a `config` file copied without its `cred.key` from being decrypted. Real key isolation would require an OS keychain / TPM (out of scope).

In both modes the credential plaintext is kept in process memory, the UI can still display the current PIN, and login validation uses `crypto.timingSafeEqual` against the in-memory value (anti-timing-attack).

**When to use**: classified-protection / SM-cryptography compliance requirements that mandate encrypting credentials at rest.

### `mcpCommandBlacklist`

A string array, matched **case-insensitively** against the executable basename, with `.exe` / `.com` / `.bat` / `.cmd` / `.ps1` suffixes automatically stripped.

Matching examples (blacklist contains `"cmd"`):

| Input command | Blocked? |
|---|---|
| `/usr/bin/cmd` | Yes |
| `C:\Windows\System32\cmd.exe` | Yes |
| `cmd.bat` | Yes |
| `CMD.EXE` | Yes |
| `cmd-extra` | No (basename is not equal to `cmd`) |

On a match:

- At install time: HTTP 403 / IPC error code `MCP_COMMAND_BLOCKED`, write rejected
- At runtime: `getDbMcpServers()` skips the entry when the session starts (already-landed old data is also blocked)

Only applies to stdio MCP (SSE / streamable-http have no command field).

**When to use**: block shells, package managers, and dangerous disk tools right at the MCP install layer. Typical list:

```json
"mcpCommandBlacklist": ["bash", "sh", "zsh", "powershell", "pwsh", "cmd", "rm", "dd", "mkfs", "fdisk"]
```

### Recommended combinations

**Strict intranet deployment** (typical):

```json
{
  "security": {
    "tunnelSafe": true,
    "remoteMcpSafe": true,
    "credentialAtRestSafe": true,
    "mcpCommandBlacklist": ["bash", "sh", "zsh", "powershell", "pwsh", "cmd"]
  }
}
```

**"Harden credentials + block dangerous MCP" only** (scenarios with relaxed remote-access needs):

```json
{
  "security": {
    "credentialAtRestSafe": true,
    "mcpCommandBlacklist": ["bash", "sh", "powershell", "cmd"]
  }
}
```

---

## Custom Provider

When you need to write code:

- company sign-in goes through SSO / OAuth, requiring launching a browser, a callback, and token exchange
- the auth header is a dynamic signature (timestamp + HMAC)
- the model list / billing / quota require calling a proprietary API
- the protocol is neither OpenAI nor Anthropic

### Directory structure

```
halo-local/acme/
├── product.acme.json
├── electron-builder.acme.cjs
├── scripts/build.sh
└── build/
    ├── package.json              esbuild config
    ├── tsconfig.json
    ├── providers/
    │   └── acme-sso/
    │       ├── index.ts          exports default
    │       └── types.ts          internal types
    └── dist/                     build output (packaged by electron-builder)
        └── providers/acme-sso/index.js
```

### `build/package.json`

```json
{
  "name": "acme-build",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild providers/acme-sso/index.ts --bundle --outfile=dist/providers/acme-sso/index.js --format=esm --platform=node --external:electron"
  },
  "devDependencies": { "esbuild": "^0.20.0" }
}
```

### Reference it in `product.acme.json`

```json
"authProviders": [
  {
    "type": "acme-sso",
    "displayName": { "en": "Acme SSO", "zh-CN": "Acme 单点登录" },
    "path": "./halo-local/acme/build/dist/providers/acme-sso/index.js",
    "icon": "log-in",
    "iconBgColor": "#0066cc",
    "recommended": true,
    "enabled": true
  }
]
```

The `path` field is the `OAuthAISourceProvider` module path (relative to the hello-halo root).

### Append files in `electron-builder.acme.cjs`

Add this line to the overlay:

```javascript
module.exports = {
  ...base,
  publish: null,
  files: [...(base.files ?? []), 'halo-local/acme/build/dist/**/*'],
}
```

### Append a compile step in `scripts/build.sh`

```bash
# Add before "npm run build":
( cd "$VENDOR_ROOT/build" && npm install --no-audit && npm run build )
```

### Provider interface

For the `OAuthAISourceProvider` interface, fields, and best practices, see [`custom-providers.md`](./custom-providers.md).

---

## Cross-platform Builds

Halo carries some native binaries (e.g. `cloudflared`, `better-sqlite3`, `node-pty`); cross-platform packaging requires preparing the corresponding platform's binaries under `node_modules` first.

### Prepare all platforms at once

```bash
cd hello-halo
npm run prepare:all     # mac-arm64 + mac-x64 + win-x64 + linux-x64
```

### Single platform

```bash
npm run prepare                                       # current platform (default)
npm run prepare:all                                   # all platforms
node scripts/prepare-binaries.mjs --platform mac-x64  # mac Intel
# other platforms: --platform win / --platform linux
```

### Build Windows / Linux packages on Mac

`build.sh` builds only the current platform by default. To build other platforms:

```bash
bash halo-local/acme/scripts/build.sh --mac --win --linux
```

You must have run `npm run prepare:all` on the machine first.

### How to switch the cloudflared multi-platform binary

The simplified `build.sh` does not handle cloudflared binary switching. If your vendor needs multi-platform packages, refer to the extension snippet below (replace the original `build.sh` as needed):

```bash
CLOUDFLARED_BIN_DIR="node_modules/cloudflared/bin"

# Before building mac x64:
cp "$CLOUDFLARED_BIN_DIR/cloudflared-darwin-x64" "$CLOUDFLARED_BIN_DIR/cloudflared"
# Restore afterwards:
cp "$CLOUDFLARED_BIN_DIR/cloudflared-darwin-arm64" "$CLOUDFLARED_BIN_DIR/cloudflared"
```

Similarly use `cloudflared-linux-x64` for linux; windows uses `cloudflared.exe` (already a separate filename, no switching needed).

---

## Multiple Vendors Side by Side

Place multiple vendors side by side under one `halo-local/`:

```
halo-local/
├── acme/
│   ├── product.acme.json
│   ├── electron-builder.acme.cjs
│   └── scripts/build.sh
└── globex/
    ├── product.globex.json
    ├── electron-builder.globex.cjs
    └── scripts/build.sh
```

Each vendor has its own independent git and is unaware of the others.

Switch as needed at build time:

```bash
bash halo-local/acme/scripts/build.sh --mac        # produces Halo-Acme.dmg
bash halo-local/globex/scripts/build.sh --mac      # produces Halo-Globex.dmg
```

The two builds have different `appId` (`com.acme.halo` vs `com.globex.halo`) and different `dataFolderName`, so they can coexist on the same machine.

### `halo-local/.gitignore` configuration

Exclude every vendor:

```
node_modules/
acme/
globex/
```

Or the blunt approach:

```
node_modules/
*/
!shared-tools/         # if you have a directory shared across vendors
```

---

## Upgrading hello-halo

```bash
cd hello-halo
git pull origin main
npm install
```

`halo-local/` stays untouched. Backward-compatibility promise for `product.<vendor>.json` fields:

- **New fields may be added** — fields added in a new version have no effect on old configs (missing old fields fall back to defaults)
- **New enum values may be added** — new values do not affect old values
- **Fields are not removed** — before a field is removed, a deprecation warning is issued for ≥ 1 major version

Breaking changes (if any) are recorded in the hello-halo repo's CHANGELOG / Release Notes. Take a quick look before upgrading.

If hello-halo changes the structure of `package.json#build` (e.g. adds a required `files` entry), your overlay automatically inherits the new base (because `loadBaseConfig()` reads the latest file every time). The overlay only appends to, never replaces, the base, so there is no conflict.
