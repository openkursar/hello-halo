/**
 * AI Terminal - Platform availability gate
 *
 * Linux desktop is intentionally excluded at the packaging layer (node-pty
 * prebuilds omitted). This gate keeps the feature out of the capability index,
 * toolset menu, and transport on unsupported platforms.
 */

import { platform } from 'os'

export function isTerminalAvailable(): boolean {
  const os = platform()
  return os === 'darwin' || os === 'win32'
}
