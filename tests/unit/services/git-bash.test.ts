/**
 * Git Bash Service Unit Tests
 *
 * Covers availability resolution so skipped setup does not mask a later real install.
 */

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { resolveGitBashAvailability } from '../../../src/main/services/git-bash'

function withWindowsPlatform(test: () => void) {
  const originalEnv = { ...process.env }
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try {
    test()
  } finally {
    process.env = originalEnv
    vi.restoreAllMocks()
  }
}

describe('Git Bash Service', () => {
  describe('resolveGitBashAvailability', () => {
    it('uses a real system Git Bash even after the user previously skipped setup', () => {
      withWindowsPlatform(() => {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = path.join(globalThis.__HALO_TEST_DIR__, 'mock-bash', 'bin', 'bash.cmd')
        process.env.PROGRAMFILES = path.join(globalThis.__HALO_TEST_DIR__, 'missing-program-files')
        process.env['PROGRAMFILES(X86)'] = path.join(globalThis.__HALO_TEST_DIR__, 'missing-program-files-x86')
        process.env.LOCALAPPDATA = path.join(globalThis.__HALO_TEST_DIR__, 'local-app-data')
        process.env.PATH = ''

        const gitDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin')
        const bashPath = path.join(gitDir, 'bash.exe')
        fs.mkdirSync(gitDir, { recursive: true })
        fs.writeFileSync(bashPath, '')

        const persistConfig = vi.fn()
        const status = resolveGitBashAvailability({
          gitBash: {
            installed: false,
            path: null,
            skipped: true
          }
        }, persistConfig)

        expect(status).toMatchObject({
          available: true,
          needsSetup: false,
          mockMode: false,
          path: bashPath,
          source: 'system',
          configUpdated: true
        })
        expect(persistConfig).toHaveBeenCalledWith({
          installed: true,
          path: bashPath,
          skipped: false
        })
      })
    })

    it('keeps mock mode only when skipped setup and no real Git Bash exists', () => {
      withWindowsPlatform(() => {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = path.join(globalThis.__HALO_TEST_DIR__, 'mock-bash', 'bin', 'bash.cmd')
        process.env.PROGRAMFILES = path.join(globalThis.__HALO_TEST_DIR__, 'missing-program-files')
        process.env['PROGRAMFILES(X86)'] = path.join(globalThis.__HALO_TEST_DIR__, 'missing-program-files-x86')
        process.env.LOCALAPPDATA = path.join(globalThis.__HALO_TEST_DIR__, 'missing-local-app-data')
        process.env.PATH = ''

        const persistConfig = vi.fn()
        const status = resolveGitBashAvailability({
          gitBash: {
            installed: false,
            path: null,
            skipped: true
          }
        }, persistConfig)

        expect(status).toMatchObject({
          available: true,
          needsSetup: false,
          mockMode: true,
          path: null,
          source: 'mock'
        })
        expect(persistConfig).not.toHaveBeenCalled()
      })
    })
  })
})
