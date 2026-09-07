/**
 * Playwright Configuration for Electron E2E Tests
 *
 * Configures Playwright to test the Halo Electron application.
 * Uses the _electron module for native Electron testing.
 */

import { defineConfig } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

// Load .env.local from project root (same pattern as translate-i18n.mjs / deploy_local_M4.sh)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') })

// Determine the app path based on platform
function getAppPath(): string {
  const platform = process.platform
  const projectRoot = path.resolve(__dirname, '..')

  if (platform === 'darwin') {
    // macOS: Check for arm64 first, then x64
    const arm64Path = path.join(projectRoot, 'dist/mac-arm64/Halo.app/Contents/MacOS/Halo')
    const x64Path = path.join(projectRoot, 'dist/mac/Halo.app/Contents/MacOS/Halo')

    // Prefer arm64 on Apple Silicon
    if (process.arch === 'arm64') {
      return arm64Path
    }
    return x64Path
  } else if (platform === 'win32') {
    return path.join(projectRoot, 'dist/win-unpacked/Halo.exe')
  } else {
    // Linux
    return path.join(projectRoot, 'dist/linux-unpacked/halo')
  }
}

export default defineConfig({
  // Test directory
  testDir: './e2e/specs',

  // Test file pattern
  testMatch: '**/*.spec.ts',

  // Timeout for each test (30 seconds for E2E)
  timeout: 30000,

  // Timeout for expect assertions
  expect: {
    timeout: 10000
  },

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Parallel tests - disabled for Electron (one app instance at a time)
  workers: 1,

  // Reporter to use
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'e2e/report' }],
    // Records perf scenarios that died before writing a result. It acts only on
    // markers the current run created, so the e2e projects are unaffected.
    ['./perf/reporter/in-flight.ts']
  ],

  // Global setup/teardown
  globalSetup: undefined,
  globalTeardown: undefined,

  // Projects - different test configurations
  projects: [
    {
      name: 'smoke',
      testMatch: '**/smoke.spec.ts',
      use: {
        // Smoke tests have shorter timeout
        actionTimeout: 5000
      }
    },
    {
      name: 'navigation',
      testMatch: '**/navigation.spec.ts',
      use: {
        actionTimeout: 10000
      }
    },
    {
      name: 'spaces',
      testMatch: '**/spaces.spec.ts',
      use: {
        actionTimeout: 10000
      }
    },
    {
      name: 'settings',
      testMatch: '**/settings.spec.ts',
      use: {
        actionTimeout: 10000
      }
    },
    {
      name: 'apps',
      testMatch: '**/apps.spec.ts',
      use: {
        actionTimeout: 10000
      }
    },
    {
      name: 'automation-run',
      testMatch: '**/automation-run.spec.ts',
      use: {
        // Live trigger + mid-run injection may wait on a real automation run
        actionTimeout: 30000
      }
    },
    {
      name: 'digital-human-lifecycle',
      testMatch: '**/digital-human-lifecycle.spec.ts',
      // Each test seeds a fresh app + boots a full Electron instance + waits
      // on a real automation run; occasional tab-render/API timing flakes are
      // environmental, not product bugs (mirrors codex-mcp's own rationale).
      retries: 1,
      use: {
        // Seeded live runs: trigger, multi-turn chat, and completion all wait
        // on real automation execution.
        actionTimeout: 30000
      }
    },
    {
      name: 'chat',
      testMatch: '**/chat.spec.ts',
      use: {
        // Chat tests may need longer for API responses
        actionTimeout: 30000
      }
    },
    {
      name: 'remote',
      testMatch: '**/remote.spec.ts',
      use: {
        actionTimeout: 10000
      }
    },
    {
      name: 'skillhub-store',
      testMatch: '**/skillhub-store.spec.ts',
      use: {
        // SkillHub tests make real network requests to api.skillhub.cn
        actionTimeout: 20000
      }
    },
    {
      name: 'team-render',
      testMatch: '**/team-render.spec.ts',
      use: {
        actionTimeout: 15000
      }
    },
    {
      // Everything except the soaks. Bounded on purpose: a suite nobody can
      // afford to run is a suite nobody runs, and this one has to be runnable
      // from a release script.
      name: 'perf',
      testDir: './perf/specs',
      testMatch: '**/*.spec.ts',
      testIgnore: ['**/s9-*.spec.ts', '**/leak-*.spec.ts'],
      // Perf scenarios launch the app themselves, stream real API replies
      // (S2+), and some intentionally wait out a load timeout up to 90s
      // (S5 csv extreme) before a 60s idle-CPU sample — give real headroom
      // instead of the 30s default so a slow-but-succeeding measurement
      // never gets killed by test-runner teardown before it can write out.
      timeout: 240000,
      use: {
        actionTimeout: 30000
      }
    },
    {
      // What a release blocks on: the scenarios `RELEASE_GATE_SCENARIOS` in
      // scripts/perf-gate/thresholds.mjs has a ceiling for, plus the crash
      // observation. Deliberately narrower than `perf` — a release gate has to
      // be short enough that nobody is tempted to skip it, and the scenarios
      // left out (cold start, terminal, browser view, streaming) have no
      // threshold that can be gated at any number.
      name: 'perf-release',
      testDir: './perf/specs',
      testMatch: /s(4|5|10)-.*\.spec\.ts$/,
      timeout: 240000,
      use: {
        actionTimeout: 30000
      }
    },
    {
      // Opt-in. The soaks measure growth per open/close cycle, so their cost is
      // duration and their result is a rate — see S9_DURATION_MS in the specs
      // for what a shorter run does and does not still tell you.
      name: 'perf-soak',
      testDir: './perf/specs',
      testMatch: '**/s9-*.spec.ts',
      timeout: 4200000,
      use: {
        actionTimeout: 30000
      }
    },
    {
      // Investigation, not measurement: these produce evidence about where a
      // leak comes from and have no threshold, so they are kept out of `perf`
      // rather than adding minutes to every run that only needs numbers.
      name: 'perf-leak',
      testDir: './perf/specs',
      testMatch: '**/leak-*.spec.ts',
      timeout: 1500000,
      use: {
        actionTimeout: 30000
      }
    },
    {
      name: 'codex-mcp',
      testMatch: '**/codex-mcp.spec.ts',
      // Upstream LLM providers occasionally return 429 / transient stream
      // failures that fire codex's reconnect loop ("Reconnecting... 1/5"),
      // and the test must not regress on those. Two local retries gives the
      // upstream a chance to recover without hiding genuine MCP regressions —
      // a real bridge bug fails all attempts.
      retries: 2,
      use: {
        // Codex turn + MCP tool call needs a generous action timeout.
        actionTimeout: 60000
      }
    }
  ],

  // Shared settings for all projects
  use: {
    // Trace on failure
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video recording
    video: 'on-first-retry'
  },

  // Output directory for test artifacts
  outputDir: 'e2e/results'
})

// Export app path for use in fixtures
export { getAppPath }
