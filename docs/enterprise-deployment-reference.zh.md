# 企业部署 — 参考手册

进阶参考手册。读这份的前置：你已经按 [`enterprise-deployment.zh.md`](./enterprise-deployment.zh.md) 跑出过第一个企业版 dmg。

本文按需查阅，不必从头读。

> English: [`enterprise-deployment-reference.md`](./enterprise-deployment-reference.md)

---

## 目录

- [架构原理](#架构原理)
- [`product.json` 字段参考](#productjson-字段参考)
- [安全策略详解](#安全策略详解)
- [自定义 Provider](#自定义-provider)
- [跨平台构建](#跨平台构建)
- [多 vendor 并存](#多-vendor-并存)
- [升级 hello-halo](#升级-hello-halo)

---

## 架构原理

### 三层模型

```
Layer 1 — hello-halo/                  公开 OSS
└── halo-local/                        Layer 2 — 个人私有工作区
    └── <vendor>/                      Layer 3 — 企业 overlay
```

每一层只感知自己和它的父层，**不感知子层、不感知兄弟层**。

| 层级 | 谁拥有 | 提交到哪 | 包含什么 |
|---|---|---|---|
| 1 | Halo 开源社区 | github.com/openkursar/hello-halo | UI、Agent SDK、所有通用能力 |
| 2 | 你（个人 / 团队） | 你自己的私有 git（如 GitHub Private、私有 Gitea） | 跨企业共享的工具、个人开发脚手架 |
| 3 | 某个企业团队 | 该企业内网 git | 这家企业专属的品牌、Provider、安全策略 |

### 为什么是嵌套目录而不是 Git submodule

submodule 会把"子模块的 commit 指针"写进父仓库的版本控制。这意味着：

- hello-halo 的提交记录里会出现 `halo-local @ <sha>` — 公开仓库泄漏了私有仓库存在的事实
- 添加新 vendor 需要修改父仓库的 `.gitmodules` — 父层被迫感知子层

嵌套目录 + `.gitignore` 的方案下，每一层都是完全独立的 git 仓库，父仓库的 `git status` 看不到子仓库的存在。

### `.gitignore` 链怎么生效

```
hello-halo/.gitignore               包含  halo-local/
hello-halo/halo-local/.gitignore    包含  <vendor>/
```

每一层自己排除下一层。`git status` 走到 `halo-local/` 时被父层 `.gitignore` 拦下，根本不会下钻；走到 `<vendor>/` 时被中间层 `.gitignore` 拦下。**没有任何一层能"看见"或"误提交"下一层的内容**。

### 三层各自做什么

**Layer 1 (hello-halo)**：保持开源默认，**绝不为任何特定企业留口子**。所有 vendor 差异化都通过 `product.json` 配置或 overlay 注入，源码里不会出现任何企业名。

**Layer 2 (halo-local)**：你的私有工作台。常见放在这里的东西：

- 跨多个 vendor 共享的 Provider 代码（如果你给 N 家企业做集成）
- 个人开发用的小工具脚本
- 你的本地实验产物
- `node_modules/`（每个 vendor 不必各自装一遍）

如果你只服务一家企业，Layer 2 可以几乎是空的，只起一个"容器"作用。

**Layer 3 (`<vendor>/`)**：完全围绕这一家企业的内容。品牌、配置、内网 URL、SSO 凭据样例（不是真凭据）、私有 Provider 源码、构建脚本、运维脚本、内部文档。

---

## `product.json` 字段参考

权威 schema：`product.schema.json`（IDE 配 `$schema` 后有完整提示）。

下面按使用场景分组说明。

### 基础元信息

```json
{
  "name": "Halo Acme",
  "dataFolderName": "halo-acme",
  "version": "1.0.0"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 关于页、菜单栏、Dock 名 |
| `dataFolderName` | 否 | 用户数据目录名，决定 `~/.{dataFolderName}/` 和 Electron `userData` 路径。**不同 vendor 必须不同**，否则数据混淆。校验：`^[a-z][a-z0-9-]*$` |
| `version` | 是 | 产品版本号（跟 `package.json#version` 独立） |

### 更新源

```json
"updateConfig": {
  "provider": "generic",
  "url": "https://release.acme.intra/halo/"
}
```

| `provider` | 必填字段 | 说明 |
|---|---|---|
| `github` | `owner`, `repo` | 从 GitHub Release 拉更新，公开版用 |
| `generic` | `url` | 从任意 HTTP 静态服务拉更新，企业内网用 |

不需要自动更新就**整个删掉 `updateConfig` 块**。

### 登录方式 — 三种形态

`authProviders` 数组每一项可以是三种形态之一：

**形态 1 — 内置 Provider**：

```json
{ "type": "claude", "builtin": true, "enabled": true, ... }
```

直接启用 hello-halo 已实现的 Provider（如 `claude`、`custom`、`github-copilot`）。

**形态 2 — Preset API（90% 企业用这种）**：

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

企业 AI 网关只要兼容 OpenAI Chat Completions（或 Responses / Anthropic 协议），就用这种。**零代码**，配 baseUrl 即可。

`apiType` 可选：`chat_completions`（最常用）/ `responses` / `anthropic_passthrough` / `kiro`。

**形态 3 — 自定义 Provider**：

```json
{
  "type": "acme-sso",
  "path": "./halo-local/acme/build/dist/providers/acme/index.js",
  ...
}
```

需要 SSO / OAuth 流、特殊鉴权、自定义协议时用。详见 [自定义 Provider](#自定义-provider)。

### 浏览器策略

```json
"browserPolicy": {
  "mode": "allowlist",
  "allowlist": ["*.acme.com", "10.0.0.0/8"],
  "homepage": "https://intranet.acme.com"
}
```

| `mode` | 行为 |
|---|---|
| `unrestricted` | 无限制（OSS 默认） |
| `allowlist` | 只允许列出的目标 |
| `blocklist` | 禁止列出的目标，其余放行 |

条目支持：

- 精确域名：`intranet.acme.com`
- 通配符：`*.acme.com`
- IPv4 CIDR：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`

`homepage` 是策略生效时新标签页的默认地址，省略则用 `about:blank`。

### 安全策略

见 [安全策略详解](#安全策略详解)。

### 遥测

```json
"telemetry": {
  "allowedSensitiveFields": ["modelName", "sourceName", "errorCode"]
}
```

OSS 默认所有"敏感字段"全部丢弃。企业自建遥测后端时，按需放行。可放行的键名详见 schema。

---

## 安全策略详解

`product.json#security` 下 4 个开关，权威定义在 [`src/main/services/security-policy.ts`](../src/main/services/security-policy.ts)。

### `tunnelSafe`

打开后，Cloudflare Quick Tunnel 在三层全部禁用：

- 服务层：`startTunnel()` 短路，不再启动 `cloudflared` 子进程
- IPC 层：`remote:tunnel:enable` 直接拒绝（`remote:tunnel:disable` 不拦截，用于清理策略开启前已在运行的隧道）
- UI 层：远程访问设置里的 "Internet Access" 子节、系统诊断里的 Cloudflared 行都不渲染

**适用**：任何内网部署。Cloudflare Tunnel 会绕过公司代理把本机 HTTP 服务直接暴露到公网，几乎所有合规要求都不允许。

### `remoteMcpSafe`

打开后，所有远程 HTTP 入口拒绝任何可能落地 MCP 服务器配置的写入：

| 端点 | 拦截条件 |
|---|---|
| `POST /api/apps/install` | AppSpec 中 `type === 'mcp'` |
| `POST /api/apps/import-spec` | YAML 解析后 `type === 'mcp'` |
| `PATCH /api/apps/:id/spec` | patch 触及 `mcp_server` 字段，或目标 app 已经是 mcp |
| `POST /api/config` | body 触及 `mcpServers` 映射 |
| `POST /api/store/install` 等 | 解析出的 spec `type === 'mcp'` |

返回 HTTP 403，错误码 `MCP_REMOTE_INSTALL_FORBIDDEN`。

**本地桌面 UI 不受影响** — 用户从设置面板装 MCP 时还是能看到完整命令并人工确认。

**适用**：开了远程访问的场景，防止远程调用方在用户机器上落地任意原生命令。

### `credentialAtRestSafe`

打开后，远程访问凭证使用 **SM4-CBC + HMAC-SM3 (encrypt-then-MAC)** 加密存盘。加密密钥由一个持久化的随机主密钥（`userData/cred.key`，首次运行时随机生成、`0o600` 权限）经 **HKDF-SHA-256** 派生，跨重启、网络变化、硬件重配置保持稳定。

> 早期版本曾用主机名 + 首个非内部 MAC 派生密钥，但这些值在真实部署中不稳定（dock/undock、VPN、虚拟网卡、DHCP 改名）会导致密钥漂移、密文 MAC 校验失败、凭证被清空。现在硬件派生种子仅作为解密旧密文的 legacy 回退，读到后会自动迁移到主密钥重新加密。

不打开时（OSS 默认）凭证以明文存储。

> 威胁边界：`cred.key` 与 `config.json` 由同一 OS 用户可读，因此这是面向合规的"静态加密"，并非防御已取得该用户文件系统权限的攻击者——它只能阻止"脱离 `cred.key` 单独拷贝的 config 文件"被解密。真正的密钥隔离需要 OS keychain / TPM（不在范围内）。

两种模式下凭证明文都保留在进程内存中，UI 仍能显示当前 PIN，登录校验走 `crypto.timingSafeEqual` 比对内存值（防 timing attack）。

**适用**：等保 / 国密合规要求凭据加密存盘的场景。

### `mcpCommandBlacklist`

字符串数组，按可执行文件 basename **大小写不敏感**匹配，自动剥离 `.exe` / `.com` / `.bat` / `.cmd` / `.ps1` 后缀。

匹配规则示例（blacklist 含 `"cmd"`）：

| 输入 command | 是否拦截 |
|---|---|
| `/usr/bin/cmd` | 是 |
| `C:\Windows\System32\cmd.exe` | 是 |
| `cmd.bat` | 是 |
| `CMD.EXE` | 是 |
| `cmd-extra` | 否（basename 不等于 `cmd`） |

命中后：

- 安装时：HTTP 403 / IPC 错误码 `MCP_COMMAND_BLOCKED`，拒绝写入
- 运行时：`getDbMcpServers()` 在 session 启动时跳过该条目（已落地的旧数据也会被拦）

仅对 stdio MCP 生效（SSE / streamable-http 没有 command 字段）。

**适用**：在 MCP 安装这一层直接拦截 shell、包管理器、危险磁盘工具。典型清单：

```json
"mcpCommandBlacklist": ["bash", "sh", "zsh", "powershell", "pwsh", "cmd", "rm", "dd", "mkfs", "fdisk"]
```

### 推荐组合

**严格内网部署**（典型）：

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

**仅"加固凭据 + 拦截危险 MCP"**（远程访问需求宽松的场景）：

```json
{
  "security": {
    "credentialAtRestSafe": true,
    "mcpCommandBlacklist": ["bash", "sh", "powershell", "cmd"]
  }
}
```

---

## 自定义 Provider

什么时候需要写代码：

- 公司登录走 SSO / OAuth，需要拉起浏览器、回调、token 交换
- 鉴权头是动态签名（时间戳 + HMAC）
- 模型列表 / 计费 / 配额需要调专有 API
- 协议既不是 OpenAI 也不是 Anthropic

### 目录结构

```
halo-local/acme/
├── product.acme.json
├── electron-builder.acme.cjs
├── scripts/build.sh
└── build/
    ├── package.json              esbuild 配置
    ├── tsconfig.json
    ├── providers/
    │   └── acme-sso/
    │       ├── index.ts          导出 default
    │       └── types.ts          内部类型
    └── dist/                     编译产物（被 electron-builder 打包）
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

### `product.acme.json` 里引用

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

`path` 字段是 `OAuthAISourceProvider` 模块路径（相对 hello-halo 根目录）。

### `electron-builder.acme.cjs` 里追加 files

把这一行加进 overlay：

```javascript
module.exports = {
  ...base,
  publish: null,
  files: [...(base.files ?? []), 'halo-local/acme/build/dist/**/*'],
}
```

### `scripts/build.sh` 里追加编译步骤

```bash
# 在 "npm run build" 之前加：
( cd "$VENDOR_ROOT/build" && npm install --no-audit && npm run build )
```

### Provider 接口

`OAuthAISourceProvider` 接口、字段、最佳实践详见 [`custom-providers.md`](./custom-providers.md)。

---

## 跨平台构建

Halo 携带一些原生二进制（如 `cloudflared`、`better-sqlite3`、`node-pty`），跨平台打包时需要先把对应平台的二进制准备到 `node_modules` 下。

### 一次性准备所有平台

```bash
cd hello-halo
npm run prepare:all     # mac-arm64 + mac-x64 + win-x64 + linux-x64
```

### 单平台

```bash
npm run prepare                                       # 当前平台（默认）
npm run prepare:all                                   # 所有平台
node scripts/prepare-binaries.mjs --platform mac-x64  # mac Intel
# 其它平台：--platform win / --platform linux
```

### Mac 上打 Windows / Linux 包

`build.sh` 默认只构建当前平台。要打其它平台：

```bash
bash halo-local/acme/scripts/build.sh --mac --win --linux
```

电脑上必须先 `npm run prepare:all` 过。

### cloudflared 多平台二进制怎么换

`build.sh` 的简化版没处理 cloudflared 二进制切换。如果你的 vendor 需要打多平台包，参考下面的扩展片段（按需替换原 `build.sh`）：

```bash
CLOUDFLARED_BIN_DIR="node_modules/cloudflared/bin"

# 打 mac x64 之前：
cp "$CLOUDFLARED_BIN_DIR/cloudflared-darwin-x64" "$CLOUDFLARED_BIN_DIR/cloudflared"
# 打完之后恢复：
cp "$CLOUDFLARED_BIN_DIR/cloudflared-darwin-arm64" "$CLOUDFLARED_BIN_DIR/cloudflared"
```

同理 linux 用 `cloudflared-linux-x64`、windows 用 `cloudflared.exe`（已经独立文件名，无需切换）。

---

## 多 vendor 并存

一个 `halo-local/` 下并列放多个 vendor：

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

每个 vendor 各自独立 git，互不感知。

构建时按需切换：

```bash
bash halo-local/acme/scripts/build.sh --mac        # 出 Halo-Acme.dmg
bash halo-local/globex/scripts/build.sh --mac      # 出 Halo-Globex.dmg
```

两次构建产物 `appId` 不同（`com.acme.halo` vs `com.globex.halo`），`dataFolderName` 不同，可以在同一台机器上共存。

### `halo-local/.gitignore` 配置

排除每一个 vendor：

```
node_modules/
acme/
globex/
```

或简单粗暴：

```
node_modules/
*/
!shared-tools/         # 如果你有跨 vendor 共享的目录
```

---

## 升级 hello-halo

```bash
cd hello-halo
git pull origin main
npm install
```

`halo-local/` 不动。`product.<vendor>.json` 字段向后兼容承诺：

- **可加新字段** — 新版本新增的字段对老配置无影响（旧字段缺失走默认值）
- **可加新枚举值** — 新值不影响旧值
- **不会删字段** — 字段删除前会先发 deprecation warning ≥ 1 个主版本

破坏性变更（如有）记录在 hello-halo 仓库的 CHANGELOG / Release Notes 中。升级前看一眼即可。

如果 hello-halo 改动了 `package.json#build` 的结构（如新增了必须的 `files` 条目），你的 overlay 会自动继承新 base（因为 `loadBaseConfig()` 每次读最新文件）。OVERLAY_FILES 只追加，不替换 base，所以不会冲突。
