/**
 * Git Bash module — Windows bash execution environment for Claude Code CLI.
 *
 * Claude Code on Windows runs its shell tools through Git Bash. This module
 * owns the whole provisioning story: detecting an existing install, downloading
 * a portable copy when none exists, and a mock fallback that keeps the CLI
 * usable (chat-only, degraded mode) when the user skips setup.
 *
 * On non-Windows platforms detection short-circuits to /bin/bash.
 */

export {
  detectGitBash,
  resolveGitBashAvailability,
  setGitBashPathEnv,
  getAppLocalGitBashDir,
  isAppLocalInstallation,
  type GitBashDetectionResult,
  type GitBashAvailability,
} from './detection'

export {
  downloadAndInstallGitBash,
  getEstimatedDownloadSize,
  getPortableGitVersion,
  type DownloadProgress,
  type ProgressCallback,
} from './installer'

export {
  createMockBash,
  cleanupMockBash,
  isMockBashMode,
  getMockBashErrorMessage,
  getMockBashDir,
} from './mock'
