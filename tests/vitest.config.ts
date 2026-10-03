/**
 * Vitest Configuration
 *
 * Unit test configuration for Halo's main process services.
 * Tests run in Node.js environment with Electron APIs mocked.
 */

import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Test file patterns
    include: ['unit/**/*.test.ts'],

    // Root directory for tests
    root: __dirname,

    // Global test timeout (10 seconds)
    testTimeout: 10000,

    // Setup files to run before each test file
    setupFiles: ['./unit/setup.ts'],

    // Child processes, not worker threads: under the Electron runtime a worker
    // thread holding an open handle cannot be terminated, so the run never
    // exits; a child process can always be killed.
    pool: 'forks',

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['../src/main/services/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts'
      ]
    },

    // Reporter configuration
    reporters: ['default'],

    // Fail fast on first error in CI
    bail: process.env.CI ? 1 : 0
  },

  resolve: {
    alias: {
      // Allow importing from src
      '@main': path.resolve(__dirname, '../src/main'),
      '@renderer': path.resolve(__dirname, '../src/renderer')
    }
  }
})
