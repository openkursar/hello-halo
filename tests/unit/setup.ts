/**
 * Vitest Setup File
 *
 * Runs before each test file to set up the test environment.
 * Mocks Electron APIs that are not available in Node.js.
 */

import { vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'

// Use global variable to store current test directory
// This allows the mock to access the current test directory
declare global {
  var __HALO_TEST_DIR__: string
}

globalThis.__HALO_TEST_DIR__ = ''

// Create a unique temporary directory for each test
function createTestDir(): string {
  const dir = path.join(
    os.tmpdir(),
    'halo-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  globalThis.__HALO_TEST_DIR__ = dir
  return dir
}

// Mock os.homedir() to return test directory
// This is needed because config.service.ts uses os.homedir() for HOME path
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: () => globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
  }
})

// Mock Electron's app module
vi.mock('electron', () => {
  return {
    app: {
      getPath: (name: string) => {
        const dir = globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
        if (name === 'home') return dir
        if (name === 'userData') return path.join(dir, '.halo')
        return dir
      },
      setLoginItemSettings: vi.fn(),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      getName: vi.fn(() => 'Halo'),
      getVersion: vi.fn(() => '1.0.0-test')
    },
    BrowserWindow: vi.fn(() => ({
      webContents: {
        send: vi.fn()
      }
    })),
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn()
    },
    shell: {
      openPath: vi.fn(),
      showItemInFolder: vi.fn()
    }
  }
})

// Set up test data directory before each test
beforeEach(() => {
  // Create fresh unique test directory for this test
  const testDir = createTestDir()

  // Create .halo directory structure
  const haloDir = path.join(testDir, '.halo')
  const tempDir = path.join(haloDir, 'temp')
  const spacesDir = path.join(haloDir, 'spaces')

  fs.mkdirSync(testDir, { recursive: true })
  fs.mkdirSync(haloDir, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })
  fs.mkdirSync(spacesDir, { recursive: true })
  fs.mkdirSync(path.join(tempDir, 'artifacts'), { recursive: true })
  fs.mkdirSync(path.join(tempDir, 'conversations'), { recursive: true })
})

// Clean up test data directory after each test
afterEach(() => {
  const testDir = globalThis.__HALO_TEST_DIR__

  // Remove test directory with force option
  try {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3 })
    }
  } catch {
    // Ignore cleanup errors - temp directory will be cleaned by OS
  }

  // Reset test directory
  globalThis.__HALO_TEST_DIR__ = ''

  // Clear all mocks
  vi.clearAllMocks()
})

// Export for use in tests if needed
export function getTestDir(): string {
  return globalThis.__HALO_TEST_DIR__
}
