/**
 * Mock Bash Service - Fallback for Windows users who skip Git Bash installation
 *
 * When users choose to skip Git Bash installation, we create a mock bash.exe
 * that allows Claude Code CLI to start but returns errors for actual commands.
 * This enables "degraded mode" where AI can chat but cannot execute system commands.
 */

import { join } from 'path'
import { app } from 'electron'
import { existsSync, writeFileSync, mkdirSync } from 'fs'

// Marker to identify mock bash in path
const MOCK_BASH_MARKER = 'mock-bash'

/**
 * Create a mock bash.cmd that satisfies Claude Code's detection
 * and returns informative messages when commands are attempted.
 *
 * Key insight: Claude Code CLI only checks if CLAUDE_CODE_GIT_BASH_PATH exists,
 * it doesn't require .exe extension. We use .cmd directly which Windows can execute.
 *
 * The output is designed to be seen by LLM, so it will understand
 * and explain to the user why commands cannot be executed.
 *
 * @returns Path to the mock bash.cmd
 */
export function createMockBash(): string {
  const mockDir = join(app.getPath('userData'), MOCK_BASH_MARKER, 'bin')
  const mockBashPath = join(mockDir, 'bash.cmd')  // Use .cmd directly

  // Always recreate to ensure latest message format
  mkdirSync(mockDir, { recursive: true })

  // Create a batch file that outputs a clear, LLM-friendly message
  // The LLM will see this output and explain to the user
  // Use exit /b 0 (success) so the output is captured as tool result, not error
  const mockScript = `@echo off
echo.
echo ============================================================
echo [HALO SYSTEM MESSAGE - COMMAND EXECUTION UNAVAILABLE]
echo ============================================================
echo.
echo The command execution environment (Git Bash) is not installed.
echo You have chosen to skip the installation during setup.
echo.
echo WHAT THIS MEANS:
echo - I cannot execute bash commands (git, npm, pip, etc.), Bash tool is disabled.
echo - I can read/write/grep/glob/edit by other Built-in tools
echo - I can only provide code suggestions and explanations
echo.
echo TO ENABLE FULL FUNCTIONALITY:
echo Please install Git for Windows from one of these sources:
echo.
echo Official Website:
echo   https://git-scm.com/downloads/win
echo.
echo China Mirror (Recommended for faster download):
echo   https://registry.npmmirror.com/-/binary/git-for-windows/
echo.
echo After installation, restart Halo to enable command execution.
echo ============================================================
echo.
exit /b 0
`

  writeFileSync(mockBashPath, mockScript, 'utf-8')

  console.log('[MockBash] Created mock bash at:', mockBashPath)
  return mockBashPath
}

/**
 * Check if the current Git Bash path is a mock
 */
export function isMockBashMode(): boolean {
  const bashPath = process.env.CLAUDE_CODE_GIT_BASH_PATH
  if (!bashPath) return false

  return bashPath.includes(MOCK_BASH_MARKER)
}

/**
 * Get user-friendly error message for mock bash mode
 */
export function getMockBashErrorMessage(): string {
  return 'Command execution environment not installed. AI cannot execute system commands. Please install it in settings.'
}

/**
 * Get the mock bash directory path
 */
export function getMockBashDir(): string {
  return join(app.getPath('userData'), MOCK_BASH_MARKER)
}

/**
 * Clean up mock bash files (used when user installs real Git Bash)
 */
export function cleanupMockBash(): void {
  const mockDir = getMockBashDir()
  if (existsSync(mockDir)) {
    try {
      const fs = require('fs')
      fs.rmSync(mockDir, { recursive: true, force: true })
      console.log('[MockBash] Cleaned up mock bash directory')
    } catch (e) {
      console.error('[MockBash] Failed to cleanup:', e)
    }
  }
}
