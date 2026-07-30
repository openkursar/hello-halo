#!/bin/bash

# ============================================================================
# Mac Developer ID 签名 + 公证的环境准备 (被 source，不要直接执行)
# ============================================================================
#
# source 后调用 halo_prepare_mac_signing，它会:
#   - 断言公证凭据 (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)
#   - 断言 notarytool 可用 (必要时把 DEVELOPER_DIR 切到 Command Line Tools)
#   - 解析签名身份: CSC_LINK 的 p12 优先, 否则用钥匙串里匹配 APPLE_TEAM_ID 的
#     Developer ID Application 身份
#   - export CSC_IDENTITY_AUTO_DISCOVERY / CSC_NAME / HALO_MAC_SIGN_MODE
#   - 把签名源写入 HALO_MAC_SIGN_SRC 供调用方打印
#
# 任一条件不满足即 exit 1 —— 绝不静默降级为 ad-hoc: ad-hoc 包会被 macOS 26.5+
# 的 Gatekeeper/XProtect 拦下 (见 docs/mac-signing-and-notarization.md)。
#
# 调用方仍需给 electron-builder 传:
#   -c.mac.hardenedRuntime=true -c.mac.notarize.teamId="$APPLE_TEAM_ID"
# package.json 里这两项默认关闭，以便没有 Apple 凭据的贡献者也能构建。
# ============================================================================

halo_prepare_mac_signing() {
  local missing="" v
  for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
    [ -z "${!v:-}" ] && missing="$missing $v"
  done
  if [ -n "$missing" ]; then
    echo "[mac-signing] 公证凭据缺失:$missing (请在 .env.local 配置)"
    exit 1
  fi

  # 有些机器 active Xcode 里 xcrun 解析不到 notarytool, 回退到 Command Line Tools。
  if ! xcrun --find notarytool >/dev/null 2>&1; then
    if [ -x /Library/Developer/CommandLineTools/usr/bin/notarytool ]; then
      export DEVELOPER_DIR=/Library/Developer/CommandLineTools
      echo "[mac-signing] 当前 Xcode 无 notarytool, 已切换 DEVELOPER_DIR=$DEVELOPER_DIR"
    else
      echo "[mac-signing] 找不到 notarytool (需 Xcode 13+ 或新版 Command Line Tools)"
      echo "    排查: xcrun --find notarytool  /  sudo xcode-select --install"
      exit 1
    fi
  fi

  export CSC_IDENTITY_AUTO_DISCOVERY=true
  export HALO_MAC_SIGN_MODE=developer-id

  if [ -n "${CSC_LINK:-}" ]; then
    # p12 模式: 跨机器/跨团队, 无需本地已安装证书。electron-builder 把 p12 导入
    # 临时钥匙串签名后自动清理; 身份从 p12 内取, 不设 CSC_NAME。
    if [ ! -f "$CSC_LINK" ]; then
      echo "[mac-signing] CSC_LINK 指向的 p12 不存在: $CSC_LINK (请检查 .env.local)"
      exit 1
    fi
    export HALO_MAC_SIGN_SRC="p12:$CSC_LINK"
  else
    if ! security find-identity -v -p codesigning | grep -q "$APPLE_TEAM_ID"; then
      echo "[mac-signing] 钥匙串未找到 Developer ID 身份 ($APPLE_TEAM_ID)"
      echo "    - 本机装了证书: security find-identity -v -p codesigning 排查"
      echo "    - 跨团队/无本地证书: 在 .env.local 配 CSC_LINK=<p12路径> 和 CSC_KEY_PASSWORD=<密码>"
      exit 1
    fi
    # CSC_NAME 用 electron-builder 可子串匹配的身份名 (不含 "Developer ID Application:" 前缀)
    export CSC_NAME="${CSC_NAME:-$(security find-identity -v -p codesigning \
      | grep "$APPLE_TEAM_ID" | head -1 | sed -E 's/.*Developer ID Application: (.*)"$/\1/')}"
    export HALO_MAC_SIGN_SRC="keychain:$CSC_NAME"
  fi
}
