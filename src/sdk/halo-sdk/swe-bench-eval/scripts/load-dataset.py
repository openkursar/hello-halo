#!/usr/bin/env python3.11
"""Download SWE-Bench Verified dataset and cache as JSONL."""
import sys
import os
import json
import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        description="Download SWE-Bench Verified dataset and cache as JSONL",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Download to default location (data/swe-bench-verified.jsonl)
  python3 scripts/load-dataset.py

  # Download a specific split
  python3 scripts/load-dataset.py --split test

  # Download to a custom path
  python3 scripts/load-dataset.py --output /tmp/swe-bench.jsonl

  # Download the full (non-verified) dataset
  python3 scripts/load-dataset.py --dataset princeton-nlp/SWE-bench
        """,
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output JSONL path (default: data/swe-bench-verified.jsonl)",
    )
    parser.add_argument("--split", default="test", help="Dataset split (default: test)")
    parser.add_argument(
        "--dataset",
        default="princeton-nlp/SWE-bench_Verified",
        help="HuggingFace dataset name (default: princeton-nlp/SWE-bench_Verified)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download even if output file already exists",
    )
    args = parser.parse_args()

    # Determine output path relative to script's parent dir
    script_dir = Path(__file__).parent
    eval_dir = script_dir.parent
    output = (
        Path(args.output)
        if args.output
        else eval_dir / "data" / "swe-bench-verified.jsonl"
    )
    output.parent.mkdir(parents=True, exist_ok=True)

    # Check if already downloaded
    if output.exists() and not args.force:
        size_mb = output.stat().st_size / (1024 * 1024)
        print(f"Dataset already cached at {output} ({size_mb:.1f} MB)")
        print("Use --force to re-download.")
        # Still print summary
        _print_summary(output)
        return

    print(f"Downloading {args.dataset} ({args.split} split)...")
    print(f"Output: {output}")

    try:
        from datasets import load_dataset
    except ImportError:
        print(
            "ERROR: 'datasets' not installed. Run: pip3 install datasets",
            file=sys.stderr,
        )
        sys.exit(1)

    # HuggingFace token (optional, for private datasets)
    hf_token = os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN")
    if hf_token:
        print("Using HuggingFace token from environment")

    try:
        ds = load_dataset(
            args.dataset,
            split=args.split,
            token=hf_token,
        )
    except Exception as e:
        print(f"ERROR: Failed to load dataset: {e}", file=sys.stderr)
        print(
            "\nTroubleshooting:", file=sys.stderr
        )
        print(
            "  • Ensure you have internet access", file=sys.stderr
        )
        print(
            "  • Try: pip3 install --upgrade datasets huggingface_hub", file=sys.stderr
        )
        print(
            "  • For private datasets, set HUGGINGFACE_TOKEN env var", file=sys.stderr
        )
        sys.exit(1)

    print(f"Dataset loaded: {len(ds)} instances")
    print("Writing to disk...")

    count = 0
    with open(output, "w") as f:
        for instance in ds:
            f.write(json.dumps(instance) + "\n")
            count += 1
            if count % 50 == 0:
                print(f"  Saved {count}/{len(ds)} instances...", end="\r", flush=True)

    print(f"\nSaved {count} instances to {output}")
    size_mb = output.stat().st_size / (1024 * 1024)
    print(f"File size: {size_mb:.1f} MB")

    _print_summary(output)


def _print_summary(path: Path) -> None:
    """Print a quick summary of the cached dataset."""
    ids = []
    repos: set = set()
    versions: dict = {}

    try:
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                d = json.loads(line)
                ids.append(d.get("instance_id", "?"))
                repo = d.get("repo", "unknown")
                repos.add(repo)
                versions[repo] = versions.get(repo, 0) + 1
    except Exception as e:
        print(f"Warning: could not read summary: {e}")
        return

    print(f"\nDataset summary:")
    print(f"  Total instances : {len(ids)}")
    print(f"  Unique repos    : {len(repos)}")
    print(f"  Sample IDs      : {ids[:3]}")
    if repos:
        top_repos = sorted(versions.items(), key=lambda x: -x[1])[:5]
        print(f"  Top repos       :")
        for repo, count in top_repos:
            print(f"    {repo}: {count} instances")


if __name__ == "__main__":
    main()
