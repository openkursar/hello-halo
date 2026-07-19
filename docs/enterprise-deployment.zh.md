# 企业部署指南

本文档面向需要将 Halo 作为公司内部 AI 客户端发行的 IT 与研发团队。

Halo 通过 `product.json` 配置 + electron-builder overlay 支持企业定制。所有定制都在企业自己的私有仓库内完成，hello-halo 主仓库代码保持原样，便于后续跟随上游升级。常见定制项：

- **品牌标识** — 应用名称、Bundle ID、应用图标、数据目录、版本号、关于页信息
- **AI 接入** — 预置公司内部 AI 网关地址（兼容 OpenAI Chat Completions / Responses / Anthropic 协议），员工安装后无需自行配置即可使用
- **登录方式** — 接入公司 SSO / OAuth，或基于 API Key 的预置入口
- **安全策略** — 禁用 Cloudflare Tunnel、限制远程 MCP 安装、远程访问凭据国密 SM4 加密落盘、内置浏览器域名白名单
- **更新源** — 自动更新指向公司内网静态服务器或制品库

多数企业的定制仅涉及 `product.json` 单文件配置；需要自研登录流程或私有协议 Provider 的场景见 [`enterprise-deployment-reference.zh.md`](./enterprise-deployment-reference.zh.md)。

> English: [`enterprise-deployment.md`](./enterprise-deployment.md)

---

## 1. 产出物结构

```
hello-halo/                              主仓库（保持原样，不修改）
└── halo-local/                          私有工作区（独立 git 仓库）
    └── acme/                            企业 overlay（独立 git 仓库）
        ├── product.acme.json            品牌、AI 网关、登录、安全策略配置
        ├── electron-builder.acme.cjs    打包配置 overlay
        ├── scripts/build.sh             构建脚本
        └── README.md
```

构建产物：`dist/Halo-Acme-x.x.x-arm64.dmg`，包含企业品牌信息、预置的 AI 网关地址与安全策略。

> 本文档以 `acme` 作为占位公司名，请按实际情况替换（如 `tencent`、`yourcompany`）。

---

## 2. 前置准备

执行一次即可，后续无需重复。

```bash
# 1. 克隆 hello-halo 主仓库
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install

# 2. 在 hello-halo/ 下创建私有工作区
#    halo-local/ 是独立 git 仓库，与 hello-halo 主仓库无引用关系
mkdir halo-local && cd halo-local
git init
printf "node_modules/\nacme/\n" > .gitignore   # 排除企业 overlay 层
cd ..
```

验证：在 `hello-halo/` 根目录执行 `git status`，结果中不应出现 `halo-local/` —— 表明主仓库 `.gitignore` 已正确排除。

---

## 3. 创建企业 overlay

提供两种等价方式，任选其一。

### 方式 A — 使用脚手架命令

```bash
node scripts/init-enterprise.mjs acme
```

在 `halo-local/acme/` 下生成 4 个文件（内容与方式 B 完全一致），自动执行 `git init`，并输出后续操作指引。

### 方式 B — 手动创建

```bash
mkdir -p halo-local/acme/scripts
cd halo-local/acme
git init
```

按下列模板创建 4 个文件，每个文件后方列出主要配置项与修改指引。

#### 文件 1：`product.acme.json`

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

**主要配置项**：

| 字段 | 说明 |
|---|---|
| `name` | 应用显示名，用于关于页、菜单栏、安装包名 |
| `dataFolderName` | 用户数据目录名（生成 `~/.halo-acme/`）。每个企业版必须使用唯一值，避免与开源版数据目录冲突 |
| `updateConfig.url` | 企业内网更新服务器地址。不启用自动更新时删除整个 `updateConfig` 块 |
| `authProviders[].preset.baseUrl` | 企业 AI 网关地址，需兼容 OpenAI 协议 |
| `authProviders[].preset.fallbackModels` | 网关 `/models` 接口不可达时的降级模型列表 |
| `security.*` | 企业安全策略开关，详见第 5 节 |
| `browserPolicy.allowlist` | 内置 AI 浏览器允许访问的域名 / IP CIDR 列表 |

如需对接 SSO / OAuth，或 `preset-api` 无法满足的鉴权场景，参见 [参考手册 - 自定义 Provider](./enterprise-deployment-reference.zh.md#自定义-provider)。

#### 文件 2：`electron-builder.acme.cjs`

```javascript
/**
 * Acme 企业版 electron-builder overlay。
 *
 * 读取 hello-halo 公开 package.json 的 build 配置作为 base，
 * 不修改它，只追加 Acme 自己需要的内容。
 *
 * 用法（从 hello-halo/ 根目录运行）：
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
  // 不发布到公网，企业产物手动分发到内网
  publish: null,
  // 如果未来添加私有 Provider 编译产物，在这里追加 glob：
  //   files: [...(base.files ?? []), 'halo-local/acme/build/dist/**/*'],
}
```

**配置项**：

通常无需修改。仅当引入私有 Provider 编译产物时，按注释取消 `files:` 的注释并追加对应 glob。

#### 文件 3：`scripts/build.sh`

```bash
#!/bin/bash
# Acme 企业版构建脚本
#
# 用法（从 hello-halo/ 根目录运行）：
#   bash halo-local/acme/scripts/build.sh [--mac] [--win] [--linux]
#
# 不带平台参数 = 当前平台。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELLO_HALO_ROOT="$(cd "$VENDOR_ROOT/../.." && pwd)"
VENDOR_NAME="$(basename "$VENDOR_ROOT")"
CONFIG_PATH="halo-local/${VENDOR_NAME}/electron-builder.${VENDOR_NAME}.cjs"
PRODUCT_PATH="halo-local/${VENDOR_NAME}/product.${VENDOR_NAME}.json"

cd "$HELLO_HALO_ROOT"

# 1. 把企业 product.json 切换为运行配置（构建结束自动恢复）
[ -f product.json ] && cp product.json product.json.bak
cp "$PRODUCT_PATH" product.json
trap '[ -f product.json.bak ] && mv product.json.bak product.json || rm -f product.json' EXIT

# 2. 编译应用
npm run build

# 3. 打包（不发布）
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/  # 国内镜像加速
export CSC_IDENTITY_AUTO_DISCOVERY=false                        # 跳过签名

PRODUCT_NAME="Halo-Acme"
APP_ID="com.acme.halo"

PLATFORMS="$@"
[ -z "$PLATFORMS" ] && PLATFORMS="--mac"   # 默认当前平台

npx electron-builder $PLATFORMS \
  --config "$CONFIG_PATH" \
  -c.productName="$PRODUCT_NAME" \
  -c.appId="$APP_ID"

echo "构建完成，产物在 $HELLO_HALO_ROOT/dist/"
ls -la dist/ | grep -i acme || true
```

**配置项**：

- `PRODUCT_NAME`：应用产物名称
- `APP_ID`：反向域名格式的 Bundle ID，必须与开源版（`com.openkursar.halo`）不同，否则 macOS 会识别为同一应用

#### 文件 4：`README.md`

```markdown
# Halo Acme

Acme 公司内部的 Halo 企业版构建仓库。

## 构建

```bash
cd <hello-halo 主仓库根目录>
bash halo-local/acme/scripts/build.sh --mac
```

产物位置：`hello-halo/dist/Halo-Acme-*.dmg`

## 配置

- 品牌、AI 网关、登录、安全策略：编辑 `product.acme.json`
- 打包规则：编辑 `electron-builder.acme.cjs`
```

---

## 4. 构建与验证

```bash
cd hello-halo
bash halo-local/acme/scripts/build.sh --mac
```

预期产物：

```
hello-halo/dist/
├── Halo-Acme-1.0.0-arm64.dmg
└── Halo-Acme-1.0.0-arm64-mac.zip
```

安装后启动，验证下列项：

1. **品牌信息**：菜单栏显示 "Halo Acme"，关于页显示版本 1.0.0
2. **登录入口**：登录界面首选项为 "Acme AI 网关"，对应 baseUrl 为企业内网网关地址
3. **数据隔离**：`~/.halo-acme/` 目录已创建，与开源版 `~/.halo/` 完全隔离

---

## 5. 安全策略

`product.acme.json#security` 提供 4 个开关，开源版默认全部关闭，企业版按合规需求启用：

| 开关 | 启用后的行为 | 典型适用场景 |
|---|---|---|
| `tunnelSafe` | 禁用 Cloudflare Quick Tunnel，阻止本机服务通过公网隧道暴露 | 内网部署的通用基线 |
| `remoteMcpSafe` | 远程 HTTP API 拒绝写入 MCP 服务器配置；本地桌面 UI 操作不受影响 | 启用远程访问的部署 |
| `credentialAtRestSafe` | 远程访问凭据采用国密 SM4-CBC + HMAC-SM3 加密落盘 | 等保 / 国密合规要求 |
| `mcpCommandBlacklist` | 字符串数组，按可执行文件 basename 拦截 MCP 安装与运行 | 禁止用户通过 MCP 调用 shell 或危险工具 |

第 3 节模板中的 `security` 块即为典型内网部署的推荐组合。

各开关的拦截点、底层实现与字段约束详见 [参考手册 - 安全策略详解](./enterprise-deployment-reference.zh.md#安全策略详解)。

---

## 6. 分发

模板中的 `electron-builder.acme.cjs` 已显式设置 `publish: null`，且构建命令未包含 `--publish` 参数，构建产物不会被推送到任何远端。禁止执行 `electron-builder --publish always`。

**手动分发**：将 `dist/Halo-Acme-*.dmg` 上传至企业内部 OA、文件服务器或制品库。

**自动更新**：在内网部署静态 HTTP 服务（nginx 即可），按 [electron-updater generic provider 规范](https://www.electron.build/configuration/publish.html#genericserveroptions) 放置 `latest-mac.yml` 等元数据文件。`product.acme.json#updateConfig.url` 指向该服务即可生效。

---

## 7. 进阶主题

| 主题 | 文档位置 |
|---|---|
| 对接企业 SSO / OAuth 登录 | [参考手册 - 自定义 Provider](./enterprise-deployment-reference.zh.md#自定义-provider) |
| `product.json` 全字段说明 | `product.schema.json` 或 [参考手册 - 字段参考](./enterprise-deployment-reference.zh.md#productjson-字段参考) |
| 在 macOS 上交叉构建 Windows / Linux 包 | [参考手册 - 跨平台构建](./enterprise-deployment-reference.zh.md#跨平台构建) |
| 同时维护多个企业版本 | [参考手册 - 多 vendor 并存](./enterprise-deployment-reference.zh.md#多-vendor-并存) |
| 三层架构设计原理 | [参考手册 - 架构原理](./enterprise-deployment-reference.zh.md#架构原理) |
| Provider 接口开发规范 | [custom-providers.md](./custom-providers.md) |

---

## 8. 常见问题

**Q：是否必须使用 `init-enterprise.mjs` 脚手架？**

否。本文第 3 节方式 B 已提供完整的 4 个文件模板，手动复制粘贴可达到与脚手架完全一致的结果。脚手架仅用于减少重复操作。

**Q：能否直接修改 hello-halo 主仓库的 `package.json` 或源码？**

不推荐。所有能通过 `product.json` 配置 + electron-builder overlay 实现的需求，应避免修改主仓库代码，否则升级 hello-halo 时需手动合并冲突。若现有扩展点无法满足需求，请通过 [GitHub Issue](https://github.com/openkursar/hello-halo/issues) 反馈。

**Q：企业 overlay 仓库是否会被误推送到公网？**

不会。三层 `.gitignore` 互相隔离：

- `hello-halo/.gitignore` 排除 `halo-local/`，主仓库不感知私有工作区
- `halo-local/.gitignore` 排除 `acme/`，工作区不感知企业 overlay
- `acme/` 为独立 git 仓库，remote 仅指向企业内网 git

每一层 `git status` 均不会泄漏下层内容。

**Q：构建报错找不到 cloudflared 二进制。**

跨平台构建（如 macOS 上构建 Windows 安装包）需要预先下载对应平台的 cloudflared 二进制。在 hello-halo 根目录执行 `npm run prepare:all` 一次即可。详见 [参考手册 - 跨平台构建](./enterprise-deployment-reference.zh.md#跨平台构建)。
