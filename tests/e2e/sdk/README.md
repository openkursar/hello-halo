# Halo SDK application acceptance

This runner builds an isolated copy of Halo and its nested SDK repository, then
drives the actual Electron renderer, preload IPC, host adapter, SDK Worker and
selected provider endpoint. It does not replace model replies with fixtures.

From the Halo repository, with both repositories' dependencies installed:

```sh
node tests/e2e/sdk/run-live.mjs
# Use GLM Coding instead of the default DeepSeek endpoint.
node tests/e2e/sdk/run-live.mjs --provider glm
```

Run the harness's offline checks before using a paid credential:

```sh
node --test tests/e2e/sdk/*.test.mjs
```

These checks cover CLI failures, broker authentication, credential redaction,
provider errors and upstream cancellation. They do not count as live-model evidence.

Supply `SDK_TEST_API_KEY` in the launching environment. Alternatively, pass
`--key-stdin` and supply one line through a pipe or a terminal with echo disabled.
The runner does not read repository credential files and fails without a key.
The real key stays in the supervisor. A loopback broker substitutes a disposable
credential in the application's isolated configuration and forwards model
requests to the selected provider: DeepSeek Flash through its Anthropic endpoint,
or `glm-5.3-flash` through `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`.
The latter exercises Halo's actual Anthropic-to-OpenAI conversion as well.

The test requires:

- The active engine is Halo, with no fallback, and its Worker entry fingerprint
  matches the separately built SDK snapshot.
- A real model invokes Write, the resulting file contains the random test value,
  and both the renderer and persisted conversation contain the final answer.
- Host diagnostics report a ready Worker owning the active session.
- A renderer reload and a complete application restart retain the same
  conversation and model context. Recall prompts contain no copy of the value
  and prohibit tools, so reading it from the fixture cannot mask lost context.
- Both application exits complete normally within ten seconds.
- A real foreground command publishes its PID and a random readiness value.
  Its process ancestry must lead back to the test application. Clicking the
  renderer's Stop control must settle the turn, terminate that process, and
  allow a new model response in the same conversation.

Reports are saved under `src/sdk/halo-sdk/validation/results/app-<UTC timestamp>`.
They contain source hashes, the built Worker hash, observed upstream status and
request counts, Playwright assertions, logs, screenshots and failure traces.
Temporary source copies and profiles are retained for investigation. Build
outputs in the working repositories are not overwritten; installed dependencies
and support assets are reused read-only. Run this on a disposable development
machine with Electron support; command ancestry checks currently require POSIX
`ps`, and the current execution evidence is macOS only.

The dedicated `tests/halo-sdk-live.config.ts` has no retries or credential-based
skips. A failed assertion, skipped test, failed process, or lack of an actual
successful upstream model response fails acceptance. The regular application
test projects do not select this separately invoked paid suite.

Application acceptance complements the standalone SDK resource harness at
`src/sdk/halo-sdk/validation/README.md`. Passing one does not certify the other.
