/**
 * @module tools/bash/platform
 * Platform detection helpers.
 * @license MIT
 */

export type Platform = 'macos' | 'linux' | 'windows' | 'other';

/** Detect the current platform. */
export function getPlatform(): Platform {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    default:
      return 'other';
  }
}

/** True if running on Windows. */
export function isWindows(): boolean {
  return process.platform === 'win32';
}
