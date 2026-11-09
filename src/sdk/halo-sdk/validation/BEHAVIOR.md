# Behavioral comparison

`behavior.mjs` compares a built SDK against the same fixed tasks through its
public `query`, `createSession`, tool and provider interfaces. It does not build
the SDK and does not depend on new options unless `--prompt-profile` is supplied.

```sh
node validation/behavior.mjs \
  --sdk-root=/absolute/path/to/sdk/dist \
  --base-url=http://127.0.0.1:8080/v1 \
  --model=your-model \
  --output-dir=/absolute/path/to/results
```

Run this command for both baseline and candidate builds with the same model and
proxy settings. `--prompt-profile=default` or `explicit` optionally compares the
candidate's wording profiles. The fixture adds a common preset append; it never
replaces the SDK's default system instructions. `--scenario=NAME` reruns one of:

- `file-task`: exact Read/Edit/Write task, including UTF-8 and CRLF preservation;
- `commit-request`: a natural-language commit request, using simulated Git;
- `no-commit`: an actual file edit with an explicit prohibition on staging and committing;
- `skill-override`: a project commit skill requires a prerequisite read and a specific artifact;
- `permission-denial`: the host denies a write and subsequent mutation or shell attempts fail the check;
- `compaction-correction`: two real turns, with seeded historical observations between them, followed by a latest correction and an actual file write after compaction.

The last case is a bounded recovery fixture, not a long-duration agent run. It
closes the first session, appends explicitly synthetic tool-call/result records
to that temporary session's documented JSONL store, then resumes through the
public API. The report records the synthetic history size. A run that never
emits a compaction boundary is `not-exercised`, never a pass.

Every case uses fresh temporary files and an isolated home/state directory.
Submitted Bash strings are parsed by a small fake repository service and never
sent to a shell. It supports inspection, scoped staging and one simulated commit;
pushes, review-request creation and other side-effecting commands are rejected
and fail the behavioral assertion. Unsupported read-only commands return an
error, preserving preceding output, without being classified as mutations.
The fixture's repository metadata and skill definitions
cannot be modified by the model. No real commit, push, external message or PR/MR
is created. The SDK may run its own read-only repository metadata probes.

Only a loopback HTTP provider is accepted. The runner normally sends a dummy key;
an external in-memory proxy can hold the real credential. If needed, a runner
credential comes from `SDK_TEST_API_KEY` or `--key-stdin`, never a command-line
value. Reports redact it; arguments and request headers are not logged. Network
requests outside the configured proxy are blocked and redirects are refused.

Limits are ten model/provider requests per scenario, 60 for the suite and
2,048 output tokens per request, including summaries. HTTP retries share the
same per-case and suite limits. There are at most six cases; a separate proxy
may enforce stricter spending limits. Each case also has a three-minute deadline.
The live provider requests adaptive thinking with low effort; a model may still
enforce its own thinking policy. Baseline and candidate use the same settings.

`behavior.json` records terminal status, actual tool traces, skill load count and
selected body hashes, file evidence, failed assertions, duration, model steps,
HTTP requests, and provider-reported input/output tokens. Failed requests may
incur usage that the provider does not report. Ordinary commit correctness does
not require a Skill call: the baseline may have no bundled commit skill. Project
override selection is checked explicitly in its own case. Text saying "done"
cannot satisfy a missing artifact or an incorrect file.

Offline runner checks use a scripted provider with an existing built SDK:

```sh
SDK_BEHAVIOR_TEST_ROOT=/absolute/path/to/sdk/dist \
  node --test validation/behavior.test.mjs
```

Without that environment variable, only the standalone runner tests execute;
the SDK integration cases are reported as skipped. Scripted-provider reports
are labeled as such and are not evidence of a real model's behavior.
