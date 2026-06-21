# Enterprise Deployment Guide

This document is for IT and engineering teams that need to distribute Halo as an internal company AI client.

Halo supports enterprise customization through `product.json` configuration + an electron-builder overlay. All customization happens inside the enterprise's own private repository; the hello-halo main repo stays untouched, which keeps it easy to follow upstream upgrades. Common customizations:

- **Branding** — app name, Bundle ID, app icon, data directory, version number, About-page info
- **AI access** — preset an internal company AI gateway URL (compatible with OpenAI Chat Completions / Responses / Anthropic protocols) so employees can use it right after install without configuring anything
- **Sign-in** — integrate company SSO / OAuth, or a preset API-key-based entry
- **Security policy** — disable Cloudflare Tunnel, restrict remote MCP installation, encrypt remote-access credentials at rest with SM4 (China SM cryptography), built-in browser domain allowlist
- **Update source** — point auto-update at a company intranet static server or artifact repository

Most enterprises only need single-file `product.json` configuration; for scenarios that require a custom sign-in flow or a proprietary-protocol Provider, see [`enterprise-deployment-reference.md`](./enterprise-deployment-reference.md).

> 中文: [`enterprise-deployment.zh.md`](./enterprise-deployment.zh.md)

---

## 1. Artifact Layout

```
hello-halo/                              Main repo (kept as-is, not modified)
└── halo-local/                          Private workspace (independent git repo)
    └── acme/                            Enterprise overlay (independent git repo)
        ├── product.acme.json            Branding, AI gateway, sign-in, security config
        ├── electron-builder.acme.cjs    Packaging config overlay
        ├── scripts/build.sh             Build script
        └── README.md
```

Build artifact: `dist/Halo-Acme-x.x.x-arm64.dmg`, containing the enterprise branding, the preset AI gateway URL, and the security policy.

> This document uses `acme` as a placeholder company name; replace it with your actual name (e.g. `tencent`, `yourcompany`).

---

## 2. Prerequisites

Run once; no need to repeat afterwards.

```bash
# 1. Clone the hello-halo main repo
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install

# 2. Create the private workspace under hello-halo/
#    halo-local/ is an independent git repo with no reference relationship to the hello-halo main repo
mkdir halo-local && cd halo-local
git init
printf "node_modules/\nacme/\n" > .gitignore   # exclude the enterprise overlay layer
cd ..
```

Verify: run `git status` in the `hello-halo/` root; `halo-local/` should NOT appear in the result — confirming the main repo's `.gitignore` excludes it correctly.

---

## 3. Create the Enterprise Overlay

Two equivalent approaches are provided; pick either one.

### Approach A — Use the scaffolding command

```bash
node scripts/init-enterprise.mjs acme
```

Generates 4 files under `halo-local/acme/` (contents identical to Approach B), automatically runs `git init`, and prints the next-step instructions.

### Approach B — Create manually

```bash
mkdir -p halo-local/acme/scripts
cd halo-local/acme
git init
```

Create 4 files from the templates below; each file is followed by its main config items and editing guidance.

#### File 1: `product.acme.json`

```json
{
  "$schema": "../../../product.schema.json",
  "name": "Halo Acme",
  "dataFolderName": "halo-acme",
  "version": "1.0.0",

  "updateConfig": {
    "provider": "generic",
    "url": "https://release.acme.intra/halo/"
  },

  "authProviders": [
    {
      "type": "preset-api",
      "displayName": { "en": "Acme AI", "zh-CN": "Acme AI 网关" },
      "description": { "en": "Internal AI gateway, just enter your API key", "zh-CN": "公司内部 AI 网关，输入 API Key 即可" },
      "icon": "key-round",
      "iconBgColor": "#6366f1",
      "recommended": true,
      "enabled": true,
      "preset": {
        "baseUrl": "https://ai-gateway.acme.intra/v1",
        "apiType": "chat_completions",
        "modelsPath": "/models",
        "fallbackModels": [
          { "id": "gpt-4", "name": "GPT-4" },
          { "id": "claude-sonnet", "name": "Claude Sonnet" }
        ],
        "docs": {
          "url": "https://wiki.acme.intra/ai-gateway",
          "label": { "en": "How to apply for an API key?", "zh-CN": "如何申请 API Key？" }
        }
      }
    }
  ],

  "security": {
    "tunnelSafe": true,
    "credentialAtRestSafe": true,
    "remoteMcpSafe": true,
    "mcpCommandBlacklist": ["bash", "sh", "zsh", "powershell", "cmd"]
  },

  "browserPolicy": {
    "mode": "allowlist",
    "allowlist": [
      "*.acme.com",
      "*.acme.intra",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16"
    ]
  }
}
```

**Main config items:**

| Field | Description |
|---|---|
| `name` | App display name, used on the About page, menu bar, installer name |
| `dataFolderName` | User data directory name (produces `~/.halo-acme/`). Each enterprise build must use a unique value to avoid colliding with the open-source build's data directory |
| `updateConfig.url` | Enterprise intranet update server URL. Delete the whole `updateConfig` block when auto-update is not used |
| `authProviders[].preset.baseUrl` | Enterprise AI gateway URL; must be OpenAI-protocol compatible |
| `authProviders[].preset.fallbackModels` | Fallback model list used when the gateway's `/models` endpoint is unreachable |
| `security.*` | Enterprise security policy switches, see Section 5 |
| `browserPolicy.allowlist` | Domain / IP CIDR list the built-in AI browser is allowed to access |

To integrate SSO / OAuth, or for auth scenarios `preset-api` cannot satisfy, see [Reference — Custom Provider](./enterprise-deployment-reference.md#custom-provider).

#### File 2: `electron-builder.acme.cjs`

```javascript
/**
 * Acme enterprise electron-builder overlay.
 *
 * Reads the hello-halo public package.json build config as base,
 * does not modify it, only appends what Acme needs.
 *
 * Usage (run from the hello-halo/ root):
 *   electron-builder --mac --config halo-local/acme/electron-builder.acme.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

function loadBaseConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
  if (!pkg.build) throw new Error('[acme] hello-halo package.json has no "build" section')
  return JSON.parse(JSON.stringify(pkg.build))
}

const base = loadBaseConfig()

module.exports = {
  ...base,
  // Not published to the public internet; enterprise artifacts are distributed manually to the intranet
  publish: null,
  // If private Provider build output is added in the future, append a glob here:
  //   files: [...(base.files ?? []), 'halo-local/acme/build/dist/**/*'],
}
```

**Config items:**

Usually no changes needed. Only when introducing private Provider build output, uncomment `files:` per the comment and append the corresponding glob.

#### File 3: `scripts/build.sh`

```bash
#!/bin/bash
# Acme enterprise build script
#
# Usage (run from the hello-halo/ root):
#   bash halo-local/acme/scripts/build.sh [--mac] [--win] [--linux]
#
# No platform argument = current platform.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELLO_HALO_ROOT="$(cd "$VENDOR_ROOT/../.." && pwd)"
VENDOR_NAME="$(basename "$VENDOR_ROOT")"
CONFIG_PATH="halo-local/${VENDOR_NAME}/electron-builder.${VENDOR_NAME}.cjs"
PRODUCT_PATH="halo-local/${VENDOR_NAME}/product.${VENDOR_NAME}.json"

cd "$HELLO_HALO_ROOT"

# 1. Switch the enterprise product.json into place as the active config (auto-restored when the build finishes)
[ -f product.json ] && cp product.json product.json.bak
cp "$PRODUCT_PATH" product.json
trap '[ -f product.json.bak ] && mv product.json.bak product.json || rm -f product.json' EXIT

# 2. Compile the app
npm run build

# 3. Package (no publish)
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/  # China mirror for speed
export CSC_IDENTITY_AUTO_DISCOVERY=false                        # skip signing

PRODUCT_NAME="Halo-Acme"
APP_ID="com.acme.halo"

PLATFORMS="$@"
[ -z "$PLATFORMS" ] && PLATFORMS="--mac"   # default to current platform

npx electron-builder $PLATFORMS \
  --config "$CONFIG_PATH" \
  -c.productName="$PRODUCT_NAME" \
  -c.appId="$APP_ID"

echo "Build complete, artifacts in $HELLO_HALO_ROOT/dist/"
ls -la dist/ | grep -i acme || true
```

**Config items:**

- `PRODUCT_NAME`: app artifact name
- `APP_ID`: reverse-domain Bundle ID, must differ from the open-source build (`com.openkursar.halo`), otherwise macOS treats them as the same app

#### File 4: `README.md`

```markdown
# Halo Acme

Acme's internal Halo enterprise build repository.

## Build

```bash
cd <hello-halo main repo root>
bash halo-local/acme/scripts/build.sh --mac
```

Artifact location: `hello-halo/dist/Halo-Acme-*.dmg`

## Configuration

- Branding, AI gateway, sign-in, security policy: edit `product.acme.json`
- Packaging rules: edit `electron-builder.acme.cjs`
```

---

## 4. Build and Verify

```bash
cd hello-halo
bash halo-local/acme/scripts/build.sh --mac
```

Expected artifacts:

```
hello-halo/dist/
├── Halo-Acme-1.0.0-arm64.dmg
└── Halo-Acme-1.0.0-arm64-mac.zip
```

After installing and launching, verify the following:

1. **Branding**: the menu bar shows "Halo Acme", the About page shows version 1.0.0
2. **Sign-in entry**: the sign-in screen's preferred option is "Acme AI 网关", with its baseUrl pointing at the enterprise intranet gateway
3. **Data isolation**: the `~/.halo-acme/` directory is created, fully isolated from the open-source build's `~/.halo/`

---

## 5. Security Policy

`product.acme.json#security` provides 4 switches. The open-source build keeps them all off by default; enterprise builds enable them per compliance needs:

| Switch | Behavior when enabled | Typical use case |
|---|---|---|
| `tunnelSafe` | Disables Cloudflare Quick Tunnel, preventing local services from being exposed to the public internet via tunnel | General baseline for intranet deployment |
| `remoteMcpSafe` | Remote HTTP API refuses to write MCP server config; local desktop UI operations are unaffected | Deployments with remote access enabled |
| `credentialAtRestSafe` | Remote-access credentials are encrypted at rest with SM4-CBC + HMAC-SM3 (China SM cryptography) | Classified-protection / SM-cryptography compliance requirements |
| `mcpCommandBlacklist` | String array; blocks MCP installation and execution by executable basename | Prevent users from invoking shells or dangerous tools through MCP |

The `security` block in the Section 3 template is the recommended combination for typical intranet deployment.

For each switch's interception points, underlying implementation, and field constraints, see [Reference — Security Policy in Detail](./enterprise-deployment-reference.md#security-policy-in-detail).

---

## 6. Distribution

The template's `electron-builder.acme.cjs` explicitly sets `publish: null`, and the build command includes no `--publish` argument, so build artifacts are never pushed to any remote. Do not run `electron-builder --publish always`.

**Manual distribution**: upload `dist/Halo-Acme-*.dmg` to the company's internal OA, file server, or artifact repository.

**Auto-update**: deploy a static HTTP service on the intranet (nginx is enough), and place metadata files such as `latest-mac.yml` per the [electron-updater generic provider spec](https://www.electron.build/configuration/publish.html#genericserveroptions). Pointing `product.acme.json#updateConfig.url` at that service is enough to take effect.

---

## 7. Advanced Topics

| Topic | Document location |
|---|---|
| Integrating enterprise SSO / OAuth sign-in | [Reference — Custom Provider](./enterprise-deployment-reference.md#custom-provider) |
| Full `product.json` field reference | `product.schema.json` or [Reference — Field Reference](./enterprise-deployment-reference.md#productjson-field-reference) |
| Cross-building Windows / Linux packages on macOS | [Reference — Cross-platform Builds](./enterprise-deployment-reference.md#cross-platform-builds) |
| Maintaining multiple enterprise builds at once | [Reference — Multiple Vendors Side by Side](./enterprise-deployment-reference.md#multiple-vendors-side-by-side) |
| Three-layer architecture rationale | [Reference — Architecture Rationale](./enterprise-deployment-reference.md#architecture-rationale) |
| Provider interface development spec | [custom-providers.md](./custom-providers.md) |

---

## 8. FAQ

**Q: Is the `init-enterprise.mjs` scaffolding mandatory?**

No. Section 3's Approach B already provides the complete 4-file templates; copy-pasting them by hand produces a result identical to the scaffolding. The scaffolding only reduces repetitive work.

**Q: Can I directly modify the hello-halo main repo's `package.json` or source code?**

Not recommended. Any requirement achievable through `product.json` configuration + electron-builder overlay should avoid modifying main-repo code, otherwise you have to manually merge conflicts when upgrading hello-halo. If the existing extension points cannot meet your needs, please report via a [GitHub Issue](https://github.com/openkursar/hello-halo/issues).

**Q: Could the enterprise overlay repo be accidentally pushed to the public internet?**

No. Three layers of `.gitignore` isolate each other:

- `hello-halo/.gitignore` excludes `halo-local/`, so the main repo is unaware of the private workspace
- `halo-local/.gitignore` excludes `acme/`, so the workspace is unaware of the enterprise overlay
- `acme/` is an independent git repo whose remote points only to the enterprise intranet git

`git status` at every layer leaks nothing from the layer below.

**Q: The build errors out saying it can't find the cloudflared binary.**

Cross-platform builds (e.g. building a Windows installer on macOS) require pre-downloading the corresponding platform's cloudflared binary. Run `npm run prepare:all` once in the hello-halo root. See [Reference — Cross-platform Builds](./enterprise-deployment-reference.md#cross-platform-builds).
