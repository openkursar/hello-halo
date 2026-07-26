#!/bin/bash

# ============================================================================
# 临时签名+公证 Mac 包 (Developer ID)，不升版本、不碰 git、不发布
# ============================================================================
#
# 与 build:mac 的区别:
#   build:mac          -> 关闭签名 (CSC_IDENTITY_AUTO_DISCOVERY=false) + 升版本号,
#                         产物未签名未公证。
#   build:mac-signed   -> 用钥匙串里的 Developer ID 证书正式签名并公证,
#                         不改 package.json 版本号, 不 commit, --publish never。
#                         产物别人双击可直接打开。
#
# 前置 (一次性):
#   - .env.local 里配好 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (公证)
#   - 签名证书二选一:
#       a) 钥匙串里有 Developer ID Application 证书 (本机; security find-identity -v -p codesigning)
#       b) .env.local 配 CSC_LINK=<p12路径> + CSC_KEY_PASSWORD=<密码> (跨机器/跨团队, 优先)
#     p12 内证书的 Team ID 必须与 APPLE_TEAM_ID 一致。
#
# 用法:
#   ./scripts/build-mac-signed.sh            # 默认 arm64 (Apple Silicon)
#   ./scripts/build-mac-signed.sh x64        # Intel
#   多架构分发请依次构建各架构即可 (cloudflared 等平台二进制由 afterPack 自动按目标选择)。
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")/.."

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64|x64) ;;
  *) echo "[build:mac-signed] 未知架构 '$ARCH' (只支持 arm64 | x64)"; exit 1 ;;
esac

# ── 载入 .env.local (逐行 export, 已存在的系统变量优先) ────────────────────────
if [ ! -f ".env.local" ]; then
  echo "[build:mac-signed] 缺少 .env.local (需要 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)"
  exit 1
fi
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  value="${value%\"}"; value="${value#\"}"
  if [ -z "${!key:-}" ]; then export "$key=$value"; fi
done < .env.local

# ── 预检: 公证凭据必须齐全 ────────────────────────────────────────────────────
missing=""
for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  [ -z "${!v:-}" ] && missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "[build:mac-signed] 公证凭据缺失:$missing (请在 .env.local 配置)"
  exit 1
fi

# ── 预检: notarytool 必须可用 ────────────────────────────────────────────────
# 有些机器 active Xcode 里 xcrun 解析不到 notarytool, 回退到 Command Line Tools。
if ! xcrun --find notarytool >/dev/null 2>&1; then
  if [ -x /Library/Developer/CommandLineTools/usr/bin/notarytool ]; then
    export DEVELOPER_DIR=/Library/Developer/CommandLineTools
    echo "[build:mac-signed] 当前 Xcode 无 notarytool, 已切换 DEVELOPER_DIR=$DEVELOPER_DIR"
  else
    echo "[build:mac-signed] 找不到 notarytool (需 Xcode 13+ 或新版 Command Line Tools)"
    echo "    排查: xcrun --find notarytool  /  sudo xcode-select --install"
    exit 1
  fi
fi

# ── 签名/公证环境: 锁定证书身份, 让 afterPack 跳过 ad-hoc ─────────────────────
# 优先级: p12 文件 (CSC_LINK) > 本地钥匙串 Developer ID 身份。绝不静默降级为 ad-hoc。
export CSC_IDENTITY_AUTO_DISCOVERY=true
export HALO_MAC_SIGN_MODE=developer-id
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

if [ -n "${CSC_LINK:-}" ]; then
  # p12 模式: 跨机器/跨团队, 无需本地已安装证书。electron-builder 会把 p12
  # 导入临时钥匙串签名后自动清理; 身份从 p12 内取, 不设 CSC_NAME。
  if [ ! -f "$CSC_LINK" ]; then
    echo "[build:mac-signed] CSC_LINK 指向的 p12 不存在: $CSC_LINK (请检查 .env.local)"
    exit 1
  fi
  SIGN_SRC="p12:$CSC_LINK"
else
  # 钥匙串模式: 用本机已安装的 Developer ID 证书。
  if ! security find-identity -v -p codesigning | grep -q "$APPLE_TEAM_ID"; then
    echo "[build:mac-signed] 钥匙串未找到 Developer ID 身份 ($APPLE_TEAM_ID)"
    echo "    - 本机装了证书: security find-identity -v -p codesigning 排查"
    echo "    - 跨团队/无本地证书: 在 .env.local 配 CSC_LINK=<p12路径> 和 CSC_KEY_PASSWORD=<密码>"
    exit 1
  fi
  # CSC_NAME 用 electron-builder 可子串匹配的身份名 (不含 "Developer ID Application:" 前缀)
  export CSC_NAME="${CSC_NAME:-$(security find-identity -v -p codesigning \
    | grep "$APPLE_TEAM_ID" | head -1 | sed -E 's/.*Developer ID Application: (.*)"$/\1/')}"
  SIGN_SRC="keychain:$CSC_NAME"
fi

echo "[build:mac-signed] 架构=$ARCH  签名源=$SIGN_SRC  TeamID=$APPLE_TEAM_ID"

# ── 准备目标架构的平台二进制 ──────────────────────────────────────────────────
# afterPack 会校验 cloudflared / better-sqlite3 / codex 等原生二进制, 缺失即 throw
# 中断打包。build:mac / release 都在打包前跑 prepare, 签名构建同样必须。只备目标
# 架构 (mac-$ARCH) 而非 all, 与本脚本的单架构产物一致, 更快。
echo "[build:mac-signed] 准备平台二进制 (mac-$ARCH)..."
node scripts/prepare-binaries.mjs --platform "mac-$ARCH"

echo "[build:mac-signed] 编译源代码..."
npm run build

echo "[build:mac-signed] 打包 + 签名 + 公证 (--publish never)..."
# 用 target:arch 精确限定单架构 (仅 --arm64/--x64 会被 config 的 arch 数组覆盖成全架构)
npx electron-builder --mac "dmg:$ARCH" "zip:$ARCH" \
  -c.mac.hardenedRuntime=true -c.mac.notarize.teamId="$APPLE_TEAM_ID" \
  --publish never

echo "[build:mac-signed] 完成。产物在 dist/ :"
ls -1 dist/*.dmg dist/*.zip 2>/dev/null || true
echo "[build:mac-signed] 验证: spctl -a -vvv --type exec <挂载后的 Halo.app> 应显示 'source=Notarized Developer ID'"
