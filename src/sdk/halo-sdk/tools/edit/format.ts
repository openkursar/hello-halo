/**
 * @module tools/edit/format
 * Optional auto-formatting after edits.
 * Placeholder — the host application can provide a real formatter.
 * @license MIT
 */

/**
 * Attempt to auto-format a file after editing.
 * This is a no-op placeholder. The host application can supply
 * a real formatter through the tool context or configuration.
 */
export async function tryFormatFile(_filePath: string): Promise<void> {
  // No-op: formatting is delegated to the host application.
}
