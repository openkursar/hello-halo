# macOS 代码签名与公证

如何打出一个能在别人机器上正常打开的、可分发的 macOS 版本。

> English version: [mac-signing-and-notarization.md](./mac-signing-and-notarization.md)

## 为什么必须做

在 macOS 15+（Sequoia）和 macOS 26+（Tahoe）上，Gatekeeper 与 XProtect 会拦截**未用
Developer ID 证书签名并经 Apple 公证**的应用。Ad-hoc 签名或未签名的应用可能无法打开
（提示"已损坏"），甚至被后台扫描直接移入废纸篓。要在 Mac App Store 之外可靠分发，只有一条路：

1. 用 **Developer ID Application** 证书给每个二进制签名。
2. 让 Apple **公证**（自动化的恶意代码/签名扫描）。
3. 把公证票据 **staple（装订）** 进应用，使其可离线校验。

## 前置准备（一次性）

1. **Apple Developer Program** 会员。
2. 登录钥匙串里要有 **Developer ID Application** 证书 **及其私钥**：
   - 钥匙串访问 → 证书助理 → *从证书颁发机构请求证书* → 存储到磁盘（此步在本机生成私钥）。
   - developer.apple.com → Certificates → **Developer ID Application**（Profile Type 选
     *G2 Sub-CA*）→ 上传 CSR → 下载 `.cer` → 双击安装。
   - 若 `security find-identity -v -p codesigning` 显示 **0 valid identities**，说明缺 Apple
     中间证书，安装它：
     ```bash
     curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && open DeveloperIDG2CA.cer
     ```
3. 公证用的 **App 专用密码**：account.apple.com → 登录与安全 → App 专用密码。
4. **Team ID**（10 位字符）：developer.apple.com → 会员资格详细信息。

## 配置模型（公开 vs 私有）

被 git 跟踪的 `package.json` 保持**中立**，让开源贡献者**无需** Apple 账户也能本地打包：

```jsonc
"mac": {
  "hardenedRuntime": false,   // 默认关闭；仅正式签名构建时开启
  "notarize": false,          // 默认关闭；仓库中不含 Team ID
  "entitlements": "resources/entitlements.mac.plist",
  "entitlementsInherit": "resources/entitlements.mac.plist"
}
```

签名与公证在**构建时**通过 electron-builder 的配置覆盖开启，因此不会把任何账户相关值提交到仓库：

```bash
-c.mac.hardenedRuntime=true -c.mac.notarize=true
```

`resources/entitlements.mac.plist` 声明了 Electron 在 Hardened Runtime 下所需的权限
（JIT、未签名可执行内存、库校验）。

`scripts/afterPack.cjs` 读取 `HALO_MAC_SIGN_MODE`：当值为 `developer-id` 时，跳过其兜底的
ad-hoc 签名，交由 electron-builder 执行真正的 Developer ID 签名。

## 环境变量（切勿提交）

| 变量 | 作用 |
| --- | --- |
| `APPLE_ID` | Apple 账户邮箱，用于公证 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 公证用的 App 专用密码 |
| `APPLE_TEAM_ID` | 10 位 Team ID；electron-builder 公证时读取 |
| `CSC_NAME` | 签名身份名，如 `Your Name (TEAMID)`——选定钥匙串中的证书 |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | 钥匙串的替代方案：`.p12` 文件路径 + 其密码 |
| `HALO_MAC_SIGN_MODE` | 设为 `developer-id`，让 `afterPack.cjs` 跳过 ad-hoc 签名 |

这些只能放在 git 忽略的文件（如 `.env.local`）或 CI 的密钥库中。

## 构建生命周期

```
拷贝应用文件
  → afterPack 钩子            (HALO_MAC_SIGN_MODE=developer-id 时跳过 ad-hoc)
  → codesign                 (用 Developer ID 证书逐个签名内部二进制)
  → afterSign / 公证          (压缩 → 上传 Apple → 等待 "Accepted")
  → staple                   (把公证票据装订进 .app)
  → 打 dmg / zip             (此时应用已带票据)
```

## 打一个签名包

将凭据导出为环境变量后：

```bash
export APPLE_ID="<你的-apple-id>"
export APPLE_APP_SPECIFIC_PASSWORD="<app-专用密码>"
export APPLE_TEAM_ID="<TEAMID>"

# 方式一：使用钥匙串中的身份
export CSC_IDENTITY_AUTO_DISCOVERY=true
export CSC_NAME="<Your Name (TEAMID)>"
# 方式二：使用可移植的 .p12（推荐用于 CI / 第二台机器）
# export CSC_LINK="/绝对路径/DeveloperID.p12"
# export CSC_KEY_PASSWORD="<p12-密码>"

export HALO_MAC_SIGN_MODE=developer-id

npm run build
npx electron-builder --mac --arm64 \
  -c.mac.hardenedRuntime=true -c.mac.notarize=true \
  --publish never
```

公证会把应用上传 Apple 并等待结果。通常几分钟，但**新账户的首次提交可能明显更久**
（偶尔达数小时），这是账户建档的一次性延迟，之后的提交会很快。

## 验证（三项必须全过）

挂载生成的 `.dmg`，对里面的 `.app` 检查：

```bash
codesign --verify --deep --strict --verbose=2 "Halo.app"   # 无报错
codesign -dvv "Halo.app"                                    # 证书链 → Apple Root CA
spctl -a -vvv --type exec "Halo.app"                        # source=Notarized Developer ID
xcrun stapler validate "Halo.app"                           # The validate action worked!
```

`spctl` 出现 `source=Notarized Developer ID` 是决定性信号，说明别的机器上 Gatekeeper 会放行。

## 在第二台机器或 CI 上构建

私钥**只存在于生成 CSR 的那台机器上**。要在别处签名：

1. 导出身份为 `.p12`：钥匙串访问 → 选中 *Developer ID Application* 证书 → 右键 → **导出**
   → 选 `.p12` → 设导出密码。
2. 安全地传输该 `.p12`（切勿提交）。
3. 在目标机器上用可移植路径替代钥匙串：
   ```bash
   export CSC_LINK="/绝对路径/DeveloperID.p12"
   export CSC_KEY_PASSWORD="<p12-密码>"
   export HALO_MAC_SIGN_MODE=developer-id
   ```
   electron-builder 会把 `.p12` 导入一个临时钥匙串并签名，**不会弹出交互授权框**。这是 CI 和
   任何第二台机器的推荐做法。

同一张 Developer ID 证书可签该账户下的**任意**应用——应用名或 Bundle ID 不同都不需要新证书。

## 故障排查

| 现象 | 原因 / 解决 |
| --- | --- |
| `0 valid identities found` | 缺 Apple 中间证书 → 安装 `DeveloperIDG2CA.cer`（见前置准备） |
| `codesign` 卡在 0% CPU、无进展 | 有钥匙串授权弹窗在等待 → 点一次 **始终允许**；或用 `CSC_LINK`（`.p12`）避免弹窗；或执行 `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <登录密码> ~/Library/Keychains/login.keychain-db` |
| 公证长时间 `In Progress` | Apple 队列；新账户首次提交可能数小时。24 小时内继续等待。用 `xcrun notarytool history` / `xcrun notarytool info <id>` 查看 |
| 公证返回 `Invalid` | 执行 `xcrun notarytool log <id>` 查看是哪个二进制失败（通常是未签名或缺 Hardened Runtime）。确保每个原生二进制都被签名 |
| 应用体积异常大 / 签名很慢 | 移动端专用原生包混入了桌面构建。在 `mac` 的 `files` 中排除，例如 `"!node_modules/@capacitor/**"` |
| 老用户无法自动更新 | Squirrel.Mac 要求已安装版本与新版本签名身份一致。之前装的是未签名/ad-hoc 版的用户可能需手动重新下载一次 |

## 安全须知

- 切勿提交：Apple ID、App 专用密码、Team ID、`.p12`、证书名。
- 签名身份与公证凭据只能放在 git 忽略的文件或密钥库中。
- 被跟踪的构建配置不得强制开启 `notarize`/`hardenedRuntime`，否则没有 Apple 凭据的贡献者无法构建。
