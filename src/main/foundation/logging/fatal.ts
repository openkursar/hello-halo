/**
 * Logging for paths that terminate the process on the next statement.
 *
 * The file transport writes asynchronously, so an ordinary log call only
 * queues its text in memory. `app.exit()` terminates immediately without
 * draining that queue, which loses precisely the line explaining why the
 * process died. `logFatal` is written to disk before it returns.
 */

import log from 'electron-log/main.js'

/** Log at error level, synchronously. Use only where the process is about to exit. */
export function logFatal(message: string, ...args: unknown[]): void {
  const { writeAsync } = log.transports.file
  log.transports.file.writeAsync = false
  try {
    log.error(message, ...args)
  } finally {
    log.transports.file.writeAsync = writeAsync
  }
}
