/**
 * Perf Electron Fixture
 *
 * Reuses `tests/e2e/fixtures/electron.ts` as-is for launch + env prep
 * (isolated HOME/HALO_DATA_DIR, product.json path rewrite, OAuth source
 * loading, SDK symlink). Baselines measure
 * the `out/main` entry (electron-vite's production build, same optimized
 * JS as the packaged app) rather than the packaged `.app`, because:
 *   - the e2e fixture already has real auth working end-to-end; launching
 *     the packaged binary directly bypasses all of it, so AI calls in
 *     S2/S6/S8 would fail and any accidental config resolution could touch
 *     the user's real ~/.halo data
 *   - rebuild loop is `npm run build` (~1min) vs a full electron-builder
 *     pack (minutes) — this weekend needs many after-N reruns
 *   - the only thing not measured is asar packing + code signing overhead,
 *     noted as a caveat in the report, not in the numbers
 *
 * This file only re-exports the e2e fixture; the four collector layers are
 * attached by each scenario spec (see specs/s1-cold-start.spec.ts).
 */

export { test, expect, hasApiKey, testConfig } from '../../e2e/fixtures/electron'
