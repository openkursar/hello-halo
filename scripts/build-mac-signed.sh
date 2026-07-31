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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

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

# ── 签名/公证环境: 凭据预检 + 锁定证书身份, 让 afterPack 跳过 ad-hoc ──────────
source "$SCRIPT_DIR/lib/mac-signing.sh"
halo_prepare_mac_signing

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

echo "[build:mac-signed] 架构=$ARCH  签名源=$HALO_MAC_SIGN_SRC  TeamID=$APPLE_TEAM_ID"

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
