# Streaming tool overlap benchmark

Build the SDK, then run this offline benchmark from the SDK repository:

```sh
npm run build
node validation/streaming.mjs
node validation/streaming.mjs --warmup 1 --repetitions 5 --output /tmp/halo-streaming-report.json
```

The script imports the compiled public entry point. It uses a local scripted
provider and custom tools: no network, model tokens or credentials. Every sample
gets a fresh temporary working directory, uses the query loop without session
persistence, and removes its directory in `finally`. The output includes the
Node/platform details, a fingerprint of the native manifest, library and public JavaScript boundary, every
sample, timing events and median wall time. An existing output file is never
overwritten.

Four independent tools each take 220 ms. Complete calls arrive at approximately
0, 40, 80 and 120 ms; the model stream continues for another 160 ms. The ordinary
host permission callback is enabled and allows each call. This catches accidental
serialization caused by merely configuring permissions.

The streaming run dispatches completed calls immediately. The buffered control
uses **the same compiled SDK, tools and events**, withholding the events until
the scripted response finishes. This isolates the benefit of overlapping tool
work with model output; it is not a comparison against an old SDK build, a real
model, or Terminal-Bench. The expected schedule is roughly 340 ms versus 500 ms,
plus local overhead. Timing is reported rather than asserted, because machine
load affects it.

One warmup pair and three measured pairs run by default, alternating which mode
runs first. The script asserts two model requests, four permission checks, exactly
one execution per tool, ordered tool results, a correct final response, and actual
safe-tool concurrency. Separate short checks cover read/write/read barriers and
cancellation while two tools are active. Any failed correctness check exits
nonzero; a speed improvement cannot substitute for correctness.

The benchmark is deliberately small. Production latency also includes actual
model generation, tool durations, permissions requiring a person, transport,
checkpoint writes and model-selected extra steps. These results cannot predict
an end-to-end benchmark speedup or explain latency differences between complete
agent runtimes.
