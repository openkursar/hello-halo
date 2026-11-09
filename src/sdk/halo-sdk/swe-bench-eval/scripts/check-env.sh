#!/usr/bin/env bash
# SWE-Bench Eval — Environment Check
# Usage: ./scripts/check-env.sh [--json]
# Exits 0 if all checks pass, 1 if any fail.
# Compatible with bash 3.2+ (macOS default shell).

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=true; shift ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--json]"
      echo ""
      echo "Checks all dependencies required for SWE-Bench eval."
      echo "Exits 0 if all pass, 1 if any fail."
      echo ""
      echo "Options:"
      echo "  --json   Output machine-readable JSON"
      exit 0
      ;;
    *) shift ;;
  esac
done

# ── Colors (disabled in JSON mode) ────────────────────────────────────────────
if [[ "$JSON_MODE" = "false" ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

ok()   { [[ "$JSON_MODE" = "false" ]] && echo -e "${GREEN}  ✓${NC} $*" || true; }
fail() { [[ "$JSON_MODE" = "false" ]] && echo -e "${RED}  ✗${NC} $*" >&2 || true; }
warn() { [[ "$JSON_MODE" = "false" ]] && echo -e "${YELLOW}  ⚠${NC} $*" || true; }

# ── Per-check result storage (bash 3.2-compatible: flat variables) ─────────────
OVERALL_OK=true

# Python version check result
PYTHON_OK=false; PYTHON_VERSION=""; PYTHON_ERROR=""
SWEBENCH_OK=false; SWEBENCH_VERSION=""; SWEBENCH_ERROR=""
DATASETS_OK=false; DATASETS_VERSION=""; DATASETS_ERROR=""
NODEJS_OK=false; NODEJS_VERSION=""; NODEJS_ERROR=""
DOCKER_OK=false; DOCKER_VERSION=""; DOCKER_ERROR=""
COLIMA_OK=false; COLIMA_VERSION=""; COLIMA_ERROR=""
DATASET_OK=false; DATASET_VERSION=""; DATASET_ERROR=""; DATASET_PATH=""
REPOS_OK=false; REPOS_VERSION=""; REPOS_ERROR=""

# ── Python ─────────────────────────────────────────────────────────────────────
# Prefer python3.11 (where swebench is installed), fall back to python3
PYTHON_BIN=""
if command -v python3.11 &>/dev/null; then
  PYTHON_BIN="python3.11"
elif command -v python3 &>/dev/null; then
  PYTHON_BIN="python3"
fi

if [[ -n "$PYTHON_BIN" ]]; then
  PY_VERSION=$("$PYTHON_BIN" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')" 2>/dev/null || echo "unknown")
  PY_MAJOR=$("$PYTHON_BIN" -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo "0")
  PY_MINOR=$("$PYTHON_BIN" -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo "0")
  if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 10 ]]; then
    PYTHON_OK=true; PYTHON_VERSION="$PY_VERSION ($PYTHON_BIN)"
    ok "Python $PY_VERSION ($PYTHON_BIN)"
  else
    PYTHON_OK=false; PYTHON_VERSION="$PY_VERSION"
    PYTHON_ERROR="Python 3.10+ required for swebench, found $PY_VERSION (use python3.11)"
    fail "Python $PY_VERSION (need 3.10+ for swebench; install: brew install python@3.11)"
    OVERALL_OK=false
  fi
else
  PYTHON_OK=false
  PYTHON_ERROR="python3 not found"
  fail "Python 3 not found (install: brew install python@3.11)"
  OVERALL_OK=false
fi

# ── swebench package ───────────────────────────────────────────────────────────
if [[ -n "$PYTHON_BIN" ]] && "$PYTHON_BIN" -c "import swebench" &>/dev/null 2>&1; then
  SW_VERSION=$("$PYTHON_BIN" -c "import importlib.metadata; print(importlib.metadata.version('swebench'))" 2>/dev/null || echo "installed")
  SWEBENCH_OK=true; SWEBENCH_VERSION="$SW_VERSION"
  ok "swebench package ($SW_VERSION)"
else
  SWEBENCH_OK=false
  SWEBENCH_ERROR="not installed — run: python3.11 -m pip install swebench"
  fail "swebench not installed (run: python3.11 -m pip install swebench)"
  OVERALL_OK=false
fi

# ── datasets package ───────────────────────────────────────────────────────────
if [[ -n "$PYTHON_BIN" ]] && "$PYTHON_BIN" -c "import datasets" &>/dev/null 2>&1; then
  DS_VERSION=$("$PYTHON_BIN" -c "import importlib.metadata; print(importlib.metadata.version('datasets'))" 2>/dev/null || echo "installed")
  DATASETS_OK=true; DATASETS_VERSION="$DS_VERSION"
  ok "datasets package ($DS_VERSION)"
else
  DATASETS_OK=false
  DATASETS_ERROR="not installed — run: python3.11 -m pip install datasets"
  fail "datasets not installed (run: python3.11 -m pip install datasets)"
  OVERALL_OK=false
fi

# ── Node.js ────────────────────────────────────────────────────────────────────
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    NODEJS_OK=true; NODEJS_VERSION="$NODE_VERSION"
    ok "Node.js v$NODE_VERSION"
  else
    NODEJS_OK=false; NODEJS_VERSION="$NODE_VERSION"
    NODEJS_ERROR="Node.js 18+ required, found $NODE_VERSION"
    fail "Node.js v$NODE_VERSION (need 18+)"
    OVERALL_OK=false
  fi
else
  NODEJS_OK=false
  NODEJS_ERROR="node not found"
  fail "Node.js not found"
  OVERALL_OK=false
fi

# ── Docker ─────────────────────────────────────────────────────────────────────
DOCKER_BIN="${DOCKER_BIN:-/opt/homebrew/bin/docker}"
if [[ ! -x "$DOCKER_BIN" ]]; then
  DOCKER_BIN=$(command -v docker 2>/dev/null || echo "")
fi

if [[ -n "$DOCKER_BIN" ]]; then
  DOCKER_INFO_OUTPUT=$("$DOCKER_BIN" info 2>&1 || true)
  if echo "$DOCKER_INFO_OUTPUT" | grep -qi "server version"; then
    DOCKER_VER=$(echo "$DOCKER_INFO_OUTPUT" | grep -i "Server Version" | head -1 | awk '{print $NF}' || echo "running")
    DOCKER_OK=true; DOCKER_VERSION="$DOCKER_VER"
    ok "Docker daemon running (v$DOCKER_VER)"
  else
    DOCKER_OK=false
    DOCKER_ERROR="daemon not running — start colima: colima start"
    fail "Docker daemon not accessible (start colima: colima start)"
    OVERALL_OK=false
  fi
else
  DOCKER_OK=false
  DOCKER_ERROR="docker binary not found"
  fail "Docker not found (install: brew install docker)"
  OVERALL_OK=false
fi

# ── Colima ─────────────────────────────────────────────────────────────────────
if command -v colima &>/dev/null; then
  COLIMA_STATUS=$(colima status 2>&1 || true)
  if echo "$COLIMA_STATUS" | grep -q "running"; then
    COLIMA_VER=$(colima version 2>/dev/null | head -1 | awk '{print $NF}' || echo "running")
    COLIMA_OK=true; COLIMA_VERSION="$COLIMA_VER"
    ok "Colima running ($COLIMA_VER)"
  else
    COLIMA_OK=false
    COLIMA_ERROR="not running — run: colima start --cpu 4 --memory 8 --disk 120"
    warn "Colima not running (run: colima start)"
    # Warning only — docker check above covers the hard failure
  fi
else
  COLIMA_OK=false
  COLIMA_ERROR="not installed — brew install colima"
  warn "colima not installed (brew install colima)"
fi

# ── Dataset file ───────────────────────────────────────────────────────────────
DATASET_FILE="$DIR/data/swe-bench-verified.jsonl"
DATASET_PATH="$DATASET_FILE"
if [[ -f "$DATASET_FILE" ]]; then
  DATASET_SIZE=$(wc -l < "$DATASET_FILE" 2>/dev/null | tr -d ' ' || echo "0")
  DATASET_MB=$(python3 -c "import os; print(f'{os.path.getsize(\"$DATASET_FILE\")/1024/1024:.1f}')" 2>/dev/null || echo "?")
  DATASET_OK=true; DATASET_VERSION="${DATASET_SIZE} instances"
  ok "Dataset: $DATASET_SIZE instances at $DATASET_FILE (${DATASET_MB} MB)"
else
  DATASET_OK=false
  DATASET_ERROR="not found — run: python3 scripts/load-dataset.py"
  warn "Dataset not found at $DATASET_FILE"
  warn "  Download with: python3 $DIR/scripts/load-dataset.py"
  # Not a hard failure
fi

# ── Repos cache dir ─────────────────────────────────────────────────────────────
REPOS_DIR="$HOME/.swe-bench-eval/repos"
if [[ -d "$REPOS_DIR" ]]; then
  REPO_COUNT=$(ls -1 "$REPOS_DIR" 2>/dev/null | wc -l | tr -d ' ')
  REPOS_OK=true; REPOS_VERSION="$REPO_COUNT repos cached"
  ok "Repos cache: $REPOS_DIR ($REPO_COUNT repos)"
else
  REPOS_OK=false
  REPOS_ERROR="directory not found — run: mkdir -p $REPOS_DIR"
  warn "Repos cache dir not found: $REPOS_DIR"
  warn "  Create with: mkdir -p $REPOS_DIR"
fi

# ── JSON Output ────────────────────────────────────────────────────────────────
if [[ "$JSON_MODE" = "true" ]]; then
  # Use the same python binary we detected above; fall back to python3
  JSON_PYTHON="${PYTHON_BIN:-python3}"
  "$JSON_PYTHON" - \
    "$PYTHON_OK"   "$PYTHON_VERSION"   "$PYTHON_ERROR" \
    "$SWEBENCH_OK" "$SWEBENCH_VERSION" "$SWEBENCH_ERROR" \
    "$DATASETS_OK" "$DATASETS_VERSION" "$DATASETS_ERROR" \
    "$NODEJS_OK"   "$NODEJS_VERSION"   "$NODEJS_ERROR" \
    "$DOCKER_OK"   "$DOCKER_VERSION"   "$DOCKER_ERROR" \
    "$COLIMA_OK"   "$COLIMA_VERSION"   "$COLIMA_ERROR" \
    "$DATASET_OK"  "$DATASET_VERSION"  "$DATASET_ERROR" "$DATASET_PATH" \
    "$REPOS_OK"    "$REPOS_VERSION"    "$REPOS_ERROR" \
<<'PYEOF'
import json, sys

args = sys.argv[1:]

def parse(ok_str): return ok_str == "true"

def entry(ok_s, ver, err, extra=None):
    d = {"ok": parse(ok_s)}
    if ver: d["version"] = ver
    if err: d["error"]   = err
    if extra is not None: d.update(extra)
    return d

checks = {
    "python":   entry(args[0],  args[1],  args[2]),
    "swebench": entry(args[3],  args[4],  args[5]),
    "datasets": entry(args[6],  args[7],  args[8]),
    "nodejs":   entry(args[9],  args[10], args[11]),
    "docker":   entry(args[12], args[13], args[14]),
    "colima":   entry(args[15], args[16], args[17]),
    "dataset":  entry(args[18], args[19], args[20], {"path": args[21], "exists": parse(args[18])}),
    "repos_dir":entry(args[22], args[23], args[24]),
}

# Overall: required checks only (colima + dataset are warnings)
required = ["python", "swebench", "datasets", "nodejs", "docker"]
overall  = all(checks[k]["ok"] for k in required)
print(json.dumps({"ok": overall, "checks": checks}, indent=2))
PYEOF
fi

# ── Final result ───────────────────────────────────────────────────────────────
if [[ "$JSON_MODE" = "false" ]]; then
  echo ""
  if [[ "$OVERALL_OK" = "true" ]]; then
    echo -e "${GREEN}${BOLD}  All required checks passed.${NC}"
    echo ""
  else
    echo -e "${RED}${BOLD}  Some checks failed. See errors above.${NC}"
    echo ""
    echo "  Fix issues then re-run: bash scripts/setup.sh"
    echo ""
  fi
fi

if [[ "$OVERALL_OK" = "true" ]]; then
  exit 0
else
  exit 1
fi
