#!/bin/bash

# ============================================================================
# Halo 本地部署脚本 (M4 Mac 专用)
# ============================================================================
#
# 背景:
#   这是一个临时的本地构建方案，专为 @imwangfu 的 M4 Mac 设计。
#   该机器已预先缓存了所有构建依赖，可以快速构建 Mac + Windows 全平台。
#   未来会迁移到 GitHub Actions 云端构建 (deploy_github.sh)。
#
# 已预先准备的依赖 (无需重复执行):
#   1. Electron 运行时缓存:
#      - darwin-arm64 (Mac Apple Silicon)
#      - darwin-x64 (Mac Intel)
#      - win32-x64 (Windows)
#      缓存位置: ~/Library/Caches/electron/
#
#   2. cloudflared 二进制 (打包时会自动检查):
#      - Mac:     node_modules/cloudflared/bin/cloudflared     (npm install 时 postinstall 下载)
#      - Windows: node_modules/cloudflared/bin/cloudflared.exe (npm run prepare:win-x64 下载)
#
#   3. npm 依赖:
#      通过 `npm install` 安装
#
# 如果在新机器上运行，需要先执行:
#   npm install
#   npm run prepare:win-x64
#   npm run build:mac      # 缓存 Mac Electron
#   npm run build:win-x64  # 缓存 Windows Electron
#
# ============================================================================
#
# 用法: ./scripts/deploy_local_M4.sh [patch|minor|major]
#
#   patch - 修订版本 (1.0.1 → 1.0.2) 用于 bug 修复、小改动
#   minor - 次版本   (1.0.x → 1.1.0) 用于新功能
#   major - 主版本   (1.x.x → 2.0.0) 用于重大更新
#
# 示例:
#   GH_TOKEN=xxx ./scripts/deploy_local_M4.sh patch
#   ./scripts/deploy_local_M4.sh minor  # 如果已设置 GH_TOKEN 环境变量
#
# 构建产物:
#   - Halo-x.x.x-arm64.dmg     (Mac Apple Silicon)
#   - Halo-x.x.x-arm64-mac.zip (Mac Apple Silicon, 用于自动更新)
#   - Halo-x.x.x-Setup.exe     (Windows x64)
#   - latest-mac.yml           (Mac 自动更新配置)
#   - latest.yml               (Windows 自动更新配置)
#
# 执行流程:
#   0. Pre-build 测试 (二进制检查 + 单元测试)
#   1. 检查并提交未保存的更改
#   2. 升级版本号 (package.json)
#   3. 编译源代码 (electron-vite build)
#   4. E2E 冒烟测试 (可选，失败会阻止发布)
#   5. 打包并发布到 GitHub Releases (electron-builder --publish always)
#   6. 推送代码和 tag 到 Git 仓库
#
# 环境变量:
#   SKIP_UNIT_TESTS=1  - 跳过单元测试
#   SKIP_E2E_TESTS=1   - 跳过 E2E 测试
#
# ============================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================================================
# 回滚机制 (失败时自动恢复文件)
# ============================================================================
BACKUP_DIR=""
ROLLBACK_ENABLED=false

# 创建备份
create_backup() {
  BACKUP_DIR=$(mktemp -d)
  log_info "创建备份: $BACKUP_DIR"

  # 备份会被修改的文件
  cp package.json "$BACKUP_DIR/"
  [ -f package-lock.json ] && cp package-lock.json "$BACKUP_DIR/"
  [ -f RELEASE_NOTES.md ] && cp RELEASE_NOTES.md "$BACKUP_DIR/"

  ROLLBACK_ENABLED=true
}

# 恢复备份
rollback() {
  if [ "$ROLLBACK_ENABLED" = true ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    echo ""
    log_warn "检测到错误，正在回滚文件..."

    cp "$BACKUP_DIR/package.json" ./
    [ -f "$BACKUP_DIR/package-lock.json" ] && cp "$BACKUP_DIR/package-lock.json" ./
    [ -f "$BACKUP_DIR/RELEASE_NOTES.md" ] && cp "$BACKUP_DIR/RELEASE_NOTES.md" ./

    # 清理临时文件
    rm -f .release-notes-current.md
    rm -rf "$BACKUP_DIR"

    log_success "已回滚到发布前状态"
  fi
}

# 清理备份（成功时调用）
cleanup_backup() {
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR"
  fi
  ROLLBACK_ENABLED=false
}

# 捕获错误并回滚
trap 'rollback; exit 1' ERR

# 进入项目目录 (先进入才能找到 .env.local)
cd "$(dirname "$0")/.."

# 加载本地环境变量 (.env.local)
if [ -f ".env.local" ]; then
  log_info "加载本地环境变量 (.env.local)..."
  echo "  .env.local 文件内容:"
  cat .env.local | sed 's/^/    /'
  echo ""

  # 使用 export 逐行加载，忽略注释和空行
  while IFS='=' read -r key value; do
    # 跳过注释和空行
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # 去掉可能的引号
    value="${value%\"}"
    value="${value#\"}"
    # 只导出未设置的变量（允许命令行覆盖）
    if [ -z "${!key}" ]; then
      export "$key=$value"
      echo "  ✓ 已加载: $key=$value"
    else
      echo "  - 跳过 (已存在): $key=${!key}"
    fi
  done < .env.local

  echo ""
  log_info "最终环境变量状态:"
  echo "  GH_TOKEN=${GH_TOKEN:0:8}... (${#GH_TOKEN} 字符)"
  echo "  NODE_ENV=${NODE_ENV:-未设置}"
  echo "  HALO_TEST_API_KEY=${HALO_TEST_API_KEY:0:8}... (${#HALO_TEST_API_KEY} 字符)"
  echo "  HALO_TEST_API_URL=${HALO_TEST_API_URL:-未设置}"
  echo "  HALO_TEST_MODEL=${HALO_TEST_MODEL:-未设置}"
  echo ""
  echo "  Analytics (build-time injected):"
  if [ -n "$HALO_GA_MEASUREMENT_ID" ]; then
    echo "    HALO_GA_MEASUREMENT_ID=${HALO_GA_MEASUREMENT_ID}"
    echo "    HALO_GA_API_SECRET=${HALO_GA_API_SECRET:0:8}..."
  else
    echo "    HALO_GA_MEASUREMENT_ID=未设置 (GA4 disabled)"
  fi
  if [ -n "$HALO_BAIDU_SITE_ID" ]; then
    echo "    HALO_BAIDU_SITE_ID=${HALO_BAIDU_SITE_ID:0:8}..."
  else
    echo "    HALO_BAIDU_SITE_ID=未设置 (Baidu disabled)"
  fi
  echo ""

  log_success "环境变量已加载"
else
  log_warn ".env.local 不存在，使用系统环境变量"
  exit 1
fi

# 检查 GH_TOKEN
if [ -z "$GH_TOKEN" ]; then
  log_error "GH_TOKEN 环境变量未设置"
  echo ""
  echo "用法: GH_TOKEN=your_token ./scripts/deploy_local_M4.sh [patch|minor|major]"
  echo ""
  echo "获取 token: https://github.com/settings/tokens"
  echo "需要权限: repo (Full control of private repositories)"
  exit 1
fi

export GH_TOKEN

# ============================================================================
# Pre-build Tests (防止打包出有问题的产品)
# ============================================================================

# Step 0a: Binary dependency check
log_info "[0/6] 检查二进制依赖..."
npm run test:check
log_success "二进制检查通过"
echo ""

# Step 0b: Unit tests (optional, can be skipped with SKIP_UNIT_TESTS=1)
if [ "$SKIP_UNIT_TESTS" != "1" ]; then
  log_info "[0/6] 运行单元测试..."
  if npm run test:unit; then
    log_success "单元测试通过"
  else
    log_error "单元测试失败！请先修复测试再打包。"
    log_info "提示: 设置 SKIP_UNIT_TESTS=1 可跳过单元测试"
    exit 1
  fi
  echo ""
else
  log_warn "跳过单元测试 (SKIP_UNIT_TESTS=1)"
  echo ""
fi

# 参数检查
VERSION_TYPE=${1:-patch}
if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
  log_error "无效的版本类型: $VERSION_TYPE"
  echo "用法: ./scripts/deploy_local_M4.sh [patch|minor|major]"
  exit 1
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")

echo ""
echo "========================================"
echo "    Halo 本地部署脚本 (M4 Mac)"
echo "========================================"
echo ""
log_info "当前版本: v$CURRENT_VERSION"
log_info "版本类型: $VERSION_TYPE"
log_info "构建平台: Mac (arm64) + Windows (x64)"
echo ""

# Step 1: 检查并提交未保存的更改
log_info "[1/6] 检查 Git 状态..."

if [[ -n $(git status --porcelain) ]]; then
  log_warn "检测到未提交的更改，自动提交..."
  git status --short
  git add -A
  git commit -m "chore: pre-release changes"
  log_success "更改已提交"
else
  log_success "工作目录干净"
fi

# Step 2: 升级版本号
log_info "[2/6] 升级版本号 ($VERSION_TYPE)..."

# 创建备份（从这里开始修改文件，失败需要回滚）
create_backup

NEW_VERSION=$(npm version $VERSION_TYPE --no-git-tag-version)
NEW_VERSION=${NEW_VERSION#v}  # 移除 v 前缀

log_success "版本已升级: v$CURRENT_VERSION → v$NEW_VERSION"

# 处理 RELEASE_NOTES.md
RELEASE_NOTES_FILE="RELEASE_NOTES.md"
CURRENT_NOTES_FILE=".release-notes-current.md"

if [ -f "$RELEASE_NOTES_FILE" ]; then
  log_info "处理更新说明..."

  # 提取 ## Next 到下一个 ## v 之间的内容（不包含标题行）
  NOTES_CONTENT=$(awk '/^## Next$/,/^## v/' "$RELEASE_NOTES_FILE" | grep -v '^## Next$' | grep -v '^## v' | sed '/^$/d')

  if [ -n "$NOTES_CONTENT" ]; then
    # 将当前版本的说明写入临时文件（给 electron-builder 用）
    echo "$NOTES_CONTENT" > "$CURRENT_NOTES_FILE"

    # 更新 RELEASE_NOTES.md：把 ## Next 替换成新版本号，并在顶部添加新的 ## Next
    sed -i '' "s/^## Next$/## v$NEW_VERSION/" "$RELEASE_NOTES_FILE"
    # 在文件顶部添加新的 ## Next
    echo -e "## Next\n\n$(cat "$RELEASE_NOTES_FILE")" > "$RELEASE_NOTES_FILE"

    log_success "更新说明已处理"
  else
    log_warn "## Next 下没有内容，跳过更新说明"
    echo "" > "$CURRENT_NOTES_FILE"
  fi
else
  log_warn "RELEASE_NOTES.md 不存在，跳过更新说明"
  echo "" > "$CURRENT_NOTES_FILE"
fi

# Step 3: 构建应用
log_info "[3/6] 编译源代码..."
npm run build
log_success "编译完成"

# Step 4: E2E Smoke Tests (optional, can be skipped with SKIP_E2E_TESTS=1)
if [ "$SKIP_E2E_TESTS" != "1" ]; then
  log_info "[4/6] 运行 E2E 冒烟测试..."
  if npm run test:e2e:smoke 2>/dev/null; then
    log_success "E2E 冒烟测试通过"
  else
    log_error "E2E 冒烟测试失败！请先修复问题再发布。"
    log_info "提示: 运行 npx playwright install 安装浏览器"
    log_info "提示: 设置 SKIP_E2E_TESTS=1 可跳过 E2E 测试"
    exit 1
  fi
  echo ""
else
  log_warn "跳过 E2E 测试 (SKIP_E2E_TESTS=1)"
  echo ""
fi

# Step 5: 打包并发布到 GitHub
log_info "[5/6] 打包并发布到 GitHub Releases..."
echo "  构建 Mac (arm64) + Windows (x64)"
echo "  (这可能需要几分钟)"
echo ""

# 使用国内镜像加速 Electron 下载
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

# 禁用自动证书发现，让 ARM 构建使用 ad-hoc 签名
export CSC_IDENTITY_AUTO_DISCOVERY=false

# 构建 Mac 和 Windows 全平台并发布
npx electron-builder --mac --win --publish always

log_success "已发布到 GitHub Releases"

# Step 6: 提交版本更改并推送
log_info "[6/6] 提交并推送到 Git..."

git add -A
git commit -m "release: v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
git push
git push origin "v$NEW_VERSION"

log_success "代码和 tag 已推送"

# 清理备份（发布成功，不再需要回滚）
cleanup_backup

echo ""
echo "========================================"
echo "          部署完成!"
echo "========================================"
echo ""
log_success "版本: v$NEW_VERSION"
log_success "GitHub Release: https://github.com/imwangfu/halo-release/releases/tag/v$NEW_VERSION"
log_success "官网会自动显示最新版本"
echo ""
echo "构建产物:"
echo "  - Halo-$NEW_VERSION-arm64.dmg (Mac Apple Silicon)"
echo "  - Halo Setup $NEW_VERSION.exe (Windows x64)"
echo ""
