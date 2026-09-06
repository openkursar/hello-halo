# Perf fixtures

Two kinds of fixture live here, and they are tracked differently on purpose.

| Directory | Tracked? | Used by |
|---|---|---|
| `regression/` | yes | markdown-chunking correctness guards (small enough to commit) |
| `generated/` | no — reproduced from `generate.py` | S4/S5/S6/S7b/S9/S10 file-preview scenarios (~25 MB) |

## generated/

```
npx tsx tests/perf/fixtures/ensure.ts      # generate if needed, then verify
python3 tests/perf/fixtures/generate.py --manifest   # after changing a writer
```

`manifest.json` holds the expected SHA-256 and byte size of every generated
fixture and **is** tracked. `lib/fixture-store.ts` verifies each fixture against
it before handing its path to a scenario; a missing, truncated, or altered
fixture throws. It never falls back to a skip — a scenario measured against the
wrong bytes yields a number that looks ordinary and means nothing.

`generate.py` is deterministic: no RNG, no clock, no external tool, no
filesystem ordering. Verified by generating twice and comparing hashes. If you
add a writer, hold that property — otherwise every run on every other machine
becomes a hard failure.

Two writers were changed when this moved out of a private directory, so their
bytes differ from the ones the first measurement round used:

- `json-*` — `value` was an unseeded `random.random()`, i.e. different on every
  single run, including the original one.
- `image-*` — was shelled out to macOS `sips`; now encoded in-process. Same
  dimensions (800×600 / 6000×4000), so the same decode load, but a larger file
  (3.0 MB vs 1.1 MB for the 6000×4000).

The other 17 are byte-identical to the originals, so their historical numbers
remain directly comparable.

`csv-extreme-tall.csv` was added later and has no historical counterpart. It is
the same 5 MB as `csv-extreme-large.csv` but 268,776 short rows instead of 66,992
wide ones, because row count — not file size — is what the viewer's per-row
spread argument blew up on. S10 opens it; nothing else does.
