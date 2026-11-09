#!/usr/bin/env bash
# SWE-Bench Eval — End-to-end convenience script
# Usage: ./scripts/run-eval.sh --provider PROVIDER --model MODEL [--limit N] [--run-id ID] [--concurrency N] [--dry-run]
#
# Runs the full pipeline:
#   1. inference  (tsx src/cli/index.ts run ...)
#   2. evaluation (tsx src/cli/index.ts eval ...)
#   3. report     (tsx src/cli/index.ts report ...)
#
# On ARM (Apple Silicon), --namespace '' is automatically passed to the eval step.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/src/cli/index.ts"

# ── Colors ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()     { echo -e "${GREEN}  ✓${NC} $*"; }
err()    { echo -e "${RED}  ✗ ERROR:${NC} $*" >&2; }
warn()   { echo -e "${YELLOW}  ⚠${NC} $*"; }
info()   { echo -e "${CYAN}  →${NC} $*"; }
header() { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}"; }
fatal()  { err "$*"; exit 1; }

# ── Detect ARM ────────────────────────────────────────────────────────────────
ARCH=$(uname -m)
IS_ARM=false
if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
  IS_ARM=true
fi

# ── Parse Arguments ────────────────────────────────────────────────────────────
LIMIT=""
MODEL=""
RUN_ID=""
CONCURRENCY=""
DRY_RUN=false
REPORT_FORMAT="md"
SKIP_EVAL=false
SKIP_REPORT=false
EXTRA_ARGS=()

usage() {
  cat <<EOF
${BOLD}Usage:${NC} $(basename "$0") [OPTIONS]

End-to-end SWE-Bench eval: run inference → score → generate report.

${BOLD}Options:${NC}
  --limit N          Number of instances to evaluate (default: all)
  --provider TYPE    Required provider selection (forwarded to inference)
  --model MODEL      Required model identifier
  --run-id ID        Run ID to use/resume (default: auto-generated timestamp)
  --concurrency N    Number of parallel agents (default: 3)
  --format FORMAT    Report format: md|json (default: md)
  --skip-eval        Skip the scoring step (inference only)
  --skip-report      Skip the report generation step
  --dry-run          Print commands without executing them
  --help             Show this help

${BOLD}Examples:${NC}
  # Quick test: run 5 instances
  $(basename "$0") --provider openrouter --model deepseek/deepseek-v3.2 --limit 5

  # Full run with specific model
  $(basename "$0") --provider openrouter --model deepseek/deepseek-v3.2 --limit 500 --concurrency 3

  # Resume a previous run
  $(basename "$0") --provider openrouter --model deepseek/deepseek-v3.2 --run-id RUN_ID --skip-eval

  # Dry run to see what would execute
  $(basename "$0") --provider openrouter --model deepseek/deepseek-v3.2 --limit 10 --dry-run

${BOLD}ARM Note:${NC}
  Running on $ARCH — namespace flag is $([ "$IS_ARM" = "true" ] && echo "AUTO-APPLIED" || echo "not needed")
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)       LIMIT="$2";       shift 2 ;;
    --model)       MODEL="$2";       shift 2 ;;
    --run-id)      RUN_ID="$2";      shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --format)      REPORT_FORMAT="$2"; shift 2 ;;
    --skip-eval)   SKIP_EVAL=true;   shift ;;
    --skip-report) SKIP_REPORT=true; shift ;;
    --dry-run)     DRY_RUN=true;     shift ;;
    --help|-h)     usage; exit 0 ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

# ── Validate Environment ───────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   SWE-Bench Eval — Full Pipeline     ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

if [[ "$IS_ARM" = "true" ]]; then
  info "Architecture: $ARCH (ARM — will use --namespace '' for eval)"
else
  info "Architecture: $ARCH"
fi

# Check CLI exists
if [[ ! -f "$CLI" ]]; then
  fatal "CLI not found at $CLI. Run setup first: bash scripts/setup.sh"
fi

# Check tsx is available
if ! command -v tsx &>/dev/null && ! npx tsx --version &>/dev/null 2>&1; then
  fatal "tsx not found. Install: npm install -g tsx"
fi
TSX_CMD=$(command -v tsx 2>/dev/null || echo "npx tsx")

# Load .env.local if present
if [[ -f "$DIR/.env.local" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$DIR/.env.local" | grep -v '^$' | xargs) 2>/dev/null || true
  info "Loaded environment from .env.local"
fi

# Ensure DOCKER_HOST is set for colima (macOS ARM)
if [[ -z "${DOCKER_HOST:-}" ]]; then
  COLIMA_SOCK="$HOME/.colima/default/docker.sock"
  if [[ -S "$COLIMA_SOCK" ]]; then
    export DOCKER_HOST="unix://$COLIMA_SOCK"
    info "Set DOCKER_HOST=$DOCKER_HOST (colima socket)"
  fi
fi

# Auto-generate run ID if not provided
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="run-$(date +%Y%m%d-%H%M%S)"
fi

# ── Build CLI Arguments ────────────────────────────────────────────────────────
RUN_ARGS=("--run-id" "$RUN_ID")
[[ -n "$LIMIT" ]]       && RUN_ARGS+=("--limit" "$LIMIT")
[[ -n "$MODEL" ]]       && RUN_ARGS+=("--model" "$MODEL")
[[ -n "$CONCURRENCY" ]] && RUN_ARGS+=("--concurrency" "$CONCURRENCY")
RUN_ARGS+=("${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}")

EVAL_ARGS=("--run-id" "$RUN_ID")
if [[ "$IS_ARM" = "true" ]]; then
  EVAL_ARGS+=("--namespace" "")
fi

REPORT_ARGS=("--run-id" "$RUN_ID" "--format" "$REPORT_FORMAT")

# ── Runner ─────────────────────────────────────────────────────────────────────
run_cmd() {
  local label="$1"
  shift
  info "$label"
  echo -e "    ${CYAN}CMD:${NC} $*"
  if [[ "$DRY_RUN" = "true" ]]; then
    warn "DRY RUN — skipping execution"
    return 0
  fi
  "$@"
}

# ── Step 1: Run Inference ──────────────────────────────────────────────────────
header "Step 1/3: Inference"
info "Run ID: $RUN_ID"
if [[ -n "$LIMIT" ]]; then
  info "Instances: $LIMIT"
fi

START_TIME=$(date +%s)

run_cmd "Running inference..." \
  $TSX_CMD "$CLI" run "${RUN_ARGS[@]}"

END_INFERENCE=$(date +%s)
INFERENCE_SECS=$((END_INFERENCE - START_TIME))
ok "Inference complete in ${INFERENCE_SECS}s"

# ── Step 2: Evaluate ───────────────────────────────────────────────────────────
if [[ "$SKIP_EVAL" = "true" ]]; then
  warn "Skipping evaluation step (--skip-eval)"
else
  header "Step 2/3: Evaluation (Scoring)"
  run_cmd "Running swebench evaluation..." \
    $TSX_CMD "$CLI" eval "${EVAL_ARGS[@]}"

  END_EVAL=$(date +%s)
  EVAL_SECS=$((END_EVAL - END_INFERENCE))
  ok "Evaluation complete in ${EVAL_SECS}s"
fi

# ── Step 3: Report ─────────────────────────────────────────────────────────────
if [[ "$SKIP_REPORT" = "true" ]]; then
  warn "Skipping report step (--skip-report)"
else
  header "Step 3/3: Report"
  run_cmd "Generating report..." \
    $TSX_CMD "$CLI" report "${REPORT_ARGS[@]}"

  ok "Report generated"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
header "Done"
TOTAL_SECS=$(( $(date +%s) - START_TIME ))
ok "Pipeline complete in ${TOTAL_SECS}s"
echo ""
echo -e "  ${BOLD}Run ID:${NC}   $RUN_ID"
echo -e "  ${BOLD}Results:${NC}  $DIR/runs/$RUN_ID/"
echo -e "  ${BOLD}Logs:${NC}     $DIR/logs/$RUN_ID.log"
echo ""
echo -e "  Check status anytime:"
echo -e "  ${CYAN}  $TSX_CMD $CLI status --run-id $RUN_ID --json${NC}"
echo ""
