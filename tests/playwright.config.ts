/**
 * Playwright Configuration for Electron E2E Tests
 *
 * Configures Playwright to test the Halo Electron application.
 * Uses the _electron module for native Electron testing.
 */

import { defineConfig } from '@playwright/test'
import path from 'path'

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
    ['html', { open: 'never', outputFolder: 'e2e/report' }]
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
