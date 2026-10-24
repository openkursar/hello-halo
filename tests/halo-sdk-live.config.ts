import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/specs',
  testMatch: 'halo-sdk-live.spec.ts',
  timeout: 240000,
  expect: { timeout: 20000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: process.env.HALO_LIVE_RESULT_JSON }]],
  outputDir: process.env.HALO_LIVE_ARTIFACT_DIR || 'e2e/results/halo-sdk-live',
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
})
