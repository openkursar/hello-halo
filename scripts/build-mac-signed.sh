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
#   - 钥匙串里有 Developer ID Application 证书 (security find-identity -v -p codesigning)
#   - .env.local 里配好 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
#
# 用法:
#   ./scripts/build-mac-signed.sh            # 默认 arm64 (Apple Silicon)
#   ./scripts/build-mac-signed.sh x64        # Intel
#   多架构分发请用 deploy_local_M4.sh (它会处理 x64 的 cloudflared 替换)。
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

# ── 预检: 签名身份必须存在, 绝不静默降级为 ad-hoc ─────────────────────────────
if ! security find-identity -v -p codesigning | grep -q "$APPLE_TEAM_ID"; then
  echo "[build:mac-signed] 钥匙串未找到 Developer ID 身份 ($APPLE_TEAM_ID)"
  echo "    排查: security find-identity -v -p codesigning"
  exit 1
fi

# ── 签名/公证环境: 锁定证书身份, 让 afterPack 跳过 ad-hoc ─────────────────────
export CSC_IDENTITY_AUTO_DISCOVERY=true
# CSC_NAME 用 electron-builder 可子串匹配的身份名 (不含 "Developer ID Application:" 前缀)
export CSC_NAME="${CSC_NAME:-$(security find-identity -v -p codesigning \
  | grep "$APPLE_TEAM_ID" | head -1 | sed -E 's/.*Developer ID Application: (.*)"$/\1/')}"
export HALO_MAC_SIGN_MODE=developer-id
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

echo "[build:mac-signed] 架构=$ARCH  身份=$CSC_NAME  TeamID=$APPLE_TEAM_ID"
echo "[build:mac-signed] 编译源代码..."
npm run build

echo "[build:mac-signed] 打包 + 签名 + 公证 (--publish never)..."
npx electron-builder --mac "--$ARCH" \
  -c.mac.hardenedRuntime=true -c.mac.notarize=true \
  --publish never

echo "[build:mac-signed] 完成。产物在 dist/ :"
ls -1 dist/*.dmg dist/*.zip 2>/dev/null || true
echo "[build:mac-signed] 验证: spctl -a -vvv --type exec <挂载后的 Halo.app> 应显示 'source=Notarized Developer ID'"
