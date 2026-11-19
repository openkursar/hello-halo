/**
 * AI Terminal - Platform availability gate
 *
 * Keeps the feature out of the capability index, toolset menu, and transport on
 * platforms whose node-pty prebuild is not packaged.
 */

import { platform } from 'os'

export function isTerminalAvailable(): boolean {
  const os = platform()
  return os === 'darwin' || os === 'win32' || os === 'linux'
}
