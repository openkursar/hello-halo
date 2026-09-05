/**
 * Logging for paths that terminate the process on the next statement.
 *
 * The file transport writes asynchronously, so an ordinary log call only
 * queues its text in memory. `app.exit()` terminates immediately without
 * draining that queue, which loses precisely the line explaining why the
 * process died. `logFatal` is written to disk before it returns.
 */

import log from 'electron-log/main.js'

/**
 * Only the open file object can still be switched to synchronous writing.
 * `transports.file.sync` is read once, when the registry creates that object,
 * so changing it here would apply to nothing.
 */
type OpenLogFile = { writeAsync: boolean }

/** Log at error level, synchronously. Use only where the process is about to exit. */
export function logFatal(message: string, ...args: unknown[]): void {
  const file = log.transports.file.getFile() as unknown as OpenLogFile
  const { writeAsync } = file
  file.writeAsync = false
  try {
    log.error(message, ...args)
  } finally {
    file.writeAsync = writeAsync
  }
}
