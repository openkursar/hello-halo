# SWE-Bench Eval Harness

A Node.js/TypeScript CLI that runs Halo Agent SDK on [SWE-Bench Verified](https://swe-bench.github.io/) instances and scores patches with the official `swebench` Python package.

The inference runner checks out each issue's base commit, runs the agent, and saves its patch and usage in `runs/swe-bench.db`. Scoring exports `runs/<run-id>/predictions.jsonl` and invokes Python/Docker. Reports are Markdown or JSON, not HTML.

## Prerequisites

Use a source checkout with the SDK's dependencies installed, Node.js 20 or later, Git, Python 3.10 or later, and Docker for scoring. Install the harness's separate dependencies from this directory:

```sh
npm ci
python3 -m pip install swebench datasets huggingface_hub
python3 scripts/load-dataset.py
```

Alternatively, `bash scripts/setup.sh` installs dependencies, prepares directories and may start Colima on macOS. Review the script before running it. `bash scripts/check-env.sh` checks local prerequisites; `--json` emits machine-readable results. Colima is a macOS option, not a requirement on other platforms.

## Choose the provider and model explicitly

Every inference run requires `--provider` and `--model`, including resumed runs. There is no default model or OAuth provider. The CLI reads exported environment variables; it does **not** load `.env.local` or apply `SWE_EVAL_*` defaults.

| Provider selection | Credential environment variable | Model selection |
| --- | --- | --- |
| `--provider openrouter` | `OPENROUTER_API_KEY` | A model ID available to that account |
| `--provider deepseek` or another SDK well-known provider name | `LLM_API_KEY` (legacy fallback: `OPENROUTER_API_KEY`) | The provider's model ID |
| `--provider qwen-oauth` | `QWEN_TOKEN` | The portal's model ID, for example `coder-model` |

`--api-key` overrides the environment, but exported credentials avoid placing a key in command-line history. `--api-url` overrides the selected provider's endpoint. `openai-compat` is an SDK protocol type, not a well-known provider name accepted by this harness; use a supported provider with `--api-url` for a compatible endpoint.

The explicit Qwen OAuth path remains available for existing evaluations. It uses `https://portal.qwen.ai/v1` unless overridden and accepts additional operator-supplied headers through `QWEN_OAUTH_HEADERS` as a JSON object. The harness does not obtain or refresh tokens. Use only credentials and endpoints you are authorized to use; this option does not establish permission under a third party's terms.

`.env.example` lists supported credential variables. If you choose a local environment file, export its values yourself before calling the CLI. Never commit credentials or raw run logs containing sensitive task data.

## Quick start

From the `swe-bench-eval` directory, with `OPENROUTER_API_KEY` already exported:

```sh
# Inspect selection without inference, repository checkout, or database writes.
npm run cli -- run --provider openrouter --model deepseek/deepseek-v3.2 --limit 5 --dry-run

# This command makes real model requests and can incur charges.
npm run cli -- run --provider openrouter --model deepseek/deepseek-v3.2 --limit 5

# Use the run ID printed by inference.
npm run cli -- status --run-id RUN_ID --json
npm run cli -- eval --run-id RUN_ID
npm run cli -- report --run-id RUN_ID
```

`run --dry-run` still requires a credential value and a readable dataset. It prints configuration and selected IDs, but does not validate credentials or provider availability.

## CLI reference

Run `npm run cli -- <command> --help` for the current option list. Paths are relative to the current working directory unless supplied as absolute paths.

### `run` — infer patches

| Option | Meaning |
| --- | --- |
| `--provider <type>` | Required provider selection |
| `--model <model>` | Required model selection |
| `--api-key <key>` | Override the credential environment variable |
| `--api-url <url>` | Override the provider endpoint |
| `--limit <n>` | Select the first N instances after filtering; default: all |
| `--instance <id>` | Select an instance; repeat for multiple IDs |
| `--concurrency <n>` | Concurrent agents; default: 3 |
| `--max-turns <n>` | Turn limit per instance; default: 50 |
| `--run-id <id>` | Use an existing ID to resume; otherwise generate one |
| `--dataset <path>` | JSONL input; default: `./data/swe-bench-verified.jsonl` |
| `--output <dir>` | Database and scoring-export directory; default: `./runs` |
| `--repo-cache <dir>` | Bare repository cache; default: `~/.swe-bench-eval/repos` |
| `--dry-run` | Show the selected instances without executing them |

```sh
npm run cli -- run --provider openrouter --model deepseek/deepseek-v3.2 --instance django__django-11099
npm run cli -- run --provider openrouter --model deepseek/deepseek-v3.2 --run-id RUN_ID
```

Resume skips both completed and failed instances already recorded for that run. Supply the same provider, model, dataset, limits and output directory as the original run: `--run-id` does not restore or validate those options. There is no `--resume`, `--instance-id`, or JSON progress flag for `run`.

### `eval` — score patches

`--run-id` is required. `--output` must match inference. Other options are `--max-workers` (default 4), `--dataset` (default `princeton-nlp/SWE-bench_Verified`), and `--namespace`.

```sh
npm run cli -- eval --run-id RUN_ID --max-workers 4
npm run cli -- eval --run-id RUN_ID --namespace ''
```

The evaluator detects ARM when no namespace is supplied. An explicit empty namespace is available for ARM/Apple Silicon. Scoring requires working Docker images and the Python harness; inference completion alone is not a passing score.

### `status` — inspect progress

Without `--run-id`, this command lists all runs; it does not select the latest run. `--output` defaults to `./runs`, and `--json` emits structured output.

```sh
npm run cli -- status
npm run cli -- status --run-id RUN_ID --json
```

For one run, JSON contains `runId`, `status`, `createdAt`, `progress`, `score`, and `config`. `progress` contains `total`, `completed`, `running`, `failed`, and `pending`. There is no `--all` flag.

### `report` — export results

`--run-id` is required. `--format` is `md` (default) or `json`. `--output` selects the existing database directory, while `--file` writes the report to a file instead of stdout.

```sh
npm run cli -- report --run-id RUN_ID
npm run cli -- report --run-id RUN_ID --format json --file results.json
npm --silent run cli -- report --run-id RUN_ID --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["score"])'
```

`score` is null until an evaluation result has been stored. Markdown's cost figure uses fixed illustrative rates of $0.27 per million input tokens and $1.10 per million output tokens; it is not a provider quote or measured bill and does not account for caching or provider-specific pricing.

## Convenience script

`scripts/run-eval.sh` runs inference, scoring, and reporting in sequence. Unlike the CLI, it loads its local `.env.local` when present. Supply provider and model flags explicitly; no model defaults are read from that file.

```sh
bash scripts/run-eval.sh --provider openrouter --model deepseek/deepseek-v3.2 --limit 5
bash scripts/run-eval.sh --provider openrouter --model deepseek/deepseek-v3.2 --run-id RUN_ID --skip-eval
bash scripts/run-eval.sh --provider openrouter --model deepseek/deepseek-v3.2 --limit 5 --dry-run
```

The wrapper accepts `--limit`, `--model`, `--run-id`, `--concurrency`, `--format md|json`, `--skip-eval`, `--skip-report`, and `--dry-run`. It forwards other arguments, including `--provider`, to inference only. For a custom `--output` directory, call all three CLI commands directly with the same directory. Wrapper dry-run prints commands rather than running them; it does not validate the dataset or provider selection.

## Dataset and files

The dataset and run outputs are not bundled. Download the public dataset with `python3 scripts/load-dataset.py`; use `--force` to replace a cached download, `--split` to select a split, or `--output` for another path.

```text
swe-bench-eval/
  src/cli/                    Commands
  scripts/                    Setup, dataset download, environment checks
  data/                       Local JSONL dataset cache
  runs/swe-bench.db            Run configuration, patches, usage and scores
  runs/<run-id>/predictions.jsonl
  evaluation_results/<run-id>/ Python scoring output expected by the evaluator
```

Actual task-solving performance depends on the model, endpoint, task selection and budget. Compare runs using the same settings; a dry-run, typecheck or offline CLI test does not establish a SWE-bench score.

## Development

```sh
npm run typecheck
# Run the harness's offline tests using the SDK's test runner:
npm --prefix .. test -- swe-bench-eval
```

## References

- [SWE-Bench paper](https://arxiv.org/abs/2310.06770)
- [SWE-Bench Verified](https://openai.com/index/introducing-swe-bench-verified/)
- [Official swebench repo](https://github.com/princeton-nlp/SWE-bench)
- [HuggingFace dataset](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)
