#!/usr/bin/env bash
# SWE-Bench Eval — One-time setup script
# Idempotent: safe to run multiple times
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Colors ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
err()  { echo -e "${RED}  ✗ ERROR:${NC} $*" >&2; }
warn() { echo -e "${YELLOW}  ⚠ WARN:${NC} $*"; }
info() { echo -e "${CYAN}  →${NC} $*"; }
header() { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}"; }

fatal() {
  err "$*"
  exit 1
}

# ── Header ─────────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   SWE-Bench Eval — Setup             ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"
info "Eval directory: $DIR"

# ── 1. System Requirements ─────────────────────────────────────────────────────
header "System Requirements"

# Python 3.10+ (3.11 preferred for swebench compatibility)
# Prefer python3.11, fall back to python3
if command -v python3.11 &>/dev/null; then
  PYTHON_BIN="python3.11"
elif command -v python3 &>/dev/null; then
  PYTHON_BIN="python3"
else
  fatal "Python 3 not found. Install via: brew install python@3.11"
fi
PY_VERSION=$("$PYTHON_BIN" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$("$PYTHON_BIN" -c "import sys; print(sys.version_info.major)")
PY_MINOR=$("$PYTHON_BIN" -c "import sys; print(sys.version_info.minor)")
if [[ "$PY_MAJOR" -lt 3 ]] || [[ "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 10 ]]; then
  fatal "Python 3.10+ required for swebench (use python3.11), found $PY_VERSION"
fi
ok "Python $PY_VERSION ($PYTHON_BIN)"

# Git
if ! command -v git &>/dev/null; then
  fatal "Git not found. Install via: brew install git"
fi
ok "Git $(git --version | awk '{print $3}')"

# Node.js 18+
if ! command -v node &>/dev/null; then
  fatal "Node.js not found. Install via: brew install node@18 or use nvm"
fi
NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fatal "Node.js 18+ required, found v$NODE_VERSION"
fi
ok "Node.js v$NODE_VERSION"

# Docker
DOCKER_BIN="${DOCKER_BIN:-/opt/homebrew/bin/docker}"
if [[ ! -x "$DOCKER_BIN" ]]; then
  # Fallback to PATH
  DOCKER_BIN=$(command -v docker 2>/dev/null || echo "")
fi
if [[ -z "$DOCKER_BIN" ]]; then
  warn "Docker not found at /opt/homebrew/bin/docker or in PATH. Docker is required for swebench evaluation."
else
  ok "Docker found at $DOCKER_BIN"
fi

# ── 2. Python Packages ─────────────────────────────────────────────────────────
header "Python Packages"

install_py_pkg() {
  local pkg="$1"
  local import_name="${2:-$1}"
  if "$PYTHON_BIN" -c "import $import_name" &>/dev/null; then
    ok "$pkg already installed"
  else
    info "Installing $pkg..."
    if "$PYTHON_BIN" -m pip install "$pkg" --quiet; then
      ok "$pkg installed"
    else
      fatal "Failed to install $pkg. Try: $PYTHON_BIN -m pip install $pkg"
    fi
  fi
}

install_py_pkg "swebench" "swebench"
install_py_pkg "datasets" "datasets"
install_py_pkg "huggingface_hub" "huggingface_hub"

# ── 3. Colima / Docker Backend ─────────────────────────────────────────────────
header "Docker Backend (Colima)"

if command -v colima &>/dev/null; then
  COLIMA_STATUS=$(colima status 2>&1 || true)
  if echo "$COLIMA_STATUS" | grep -q "running"; then
    ok "Colima is running"
  else
    warn "Colima is not running. Starting colima..."
    info "Running: colima start --cpu 4 --memory 8 --disk 120"
    if colima start --cpu 4 --memory 8 --disk 120; then
      ok "Colima started successfully"
    else
      warn "Failed to start colima automatically. Run manually: colima start --cpu 4 --memory 8 --disk 120"
    fi
  fi

  # Verify docker is accessible via colima
  if [[ -n "$DOCKER_BIN" ]]; then
    if "$DOCKER_BIN" info &>/dev/null 2>&1; then
      ok "Docker daemon is accessible"
    else
      warn "Docker daemon not accessible. Ensure colima is running: colima start"
    fi
  fi
else
  warn "colima not found. Install via: brew install colima"
  warn "Colima is required to run swebench Docker containers on macOS."
  if [[ -n "$DOCKER_BIN" ]]; then
    if "$DOCKER_BIN" info &>/dev/null 2>&1; then
      ok "Docker daemon is accessible (via alternative backend)"
    else
      warn "Docker daemon not accessible. Start colima: brew install colima && colima start"
    fi
  fi
fi

# ── 4. Create Required Directories ────────────────────────────────────────────
header "Directories"

DIRS=(
  "$DIR/data"
  "$DIR/runs"
  "$DIR/logs"
  "$HOME/.swe-bench-eval/repos"
)

for d in "${DIRS[@]}"; do
  if [[ -d "$d" ]]; then
    ok "Exists: $d"
  else
    mkdir -p "$d"
    ok "Created: $d"
  fi
done

# Ensure .gitkeep files exist for tracked empty dirs
for tracked in "$DIR/data" "$DIR/runs" "$DIR/logs"; do
  touch "$tracked/.gitkeep"
done

# ── 5. npm install ─────────────────────────────────────────────────────────────
header "Node.js Dependencies"

if [[ -f "$DIR/package.json" ]]; then
  info "Running npm install in $DIR..."
  cd "$DIR"
  if npm install --silent; then
    ok "npm install complete"
  else
    fatal "npm install failed. Check package.json and network connectivity."
  fi
else
  warn "No package.json found in $DIR — skipping npm install"
  warn "Initialize with: cd $DIR && npm init -y"
fi

# ── 6. Copy .env if needed ────────────────────────────────────────────────────
header "Environment Configuration"

if [[ -f "$DIR/.env.local" ]]; then
  ok ".env.local already exists"
else
  if [[ -f "$DIR/.env.example" ]]; then
    cp "$DIR/.env.example" "$DIR/.env.local"
    warn "Created .env.local from .env.example — EDIT IT to add your API keys"
  else
    warn "No .env.example found — create .env.local with your API keys"
  fi
fi

# ── 7. Verify check-env ────────────────────────────────────────────────────────
header "Final Verification"

if [[ -x "$DIR/scripts/check-env.sh" ]]; then
  info "Running environment check..."
  "$DIR/scripts/check-env.sh" || true
else
  warn "check-env.sh not found or not executable"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  Setup complete!${NC}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Edit .env.local and set OPENROUTER_API_KEY"
echo "  2. Download dataset:"
echo "       python3 $DIR/scripts/load-dataset.py"
echo "  3. Run a quick test (5 instances):"
echo "       tsx $DIR/src/cli/index.ts run --provider openrouter --model deepseek/deepseek-v3.2 --limit 5"
echo "  4. Or use the convenience script:"
echo "       bash $DIR/scripts/run-eval.sh --provider openrouter --model deepseek/deepseek-v3.2 --limit 5"
echo ""
