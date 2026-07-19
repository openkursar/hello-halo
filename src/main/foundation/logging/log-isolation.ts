/**
 * Per-instance log path isolation.
 *
 * electron-log keys its file path on the app name, which is identical across
 * every running instance — without intervention a dev run, per-variant builds,
 * and every node of a local multi-node cluster all interleave into the SAME
 * main.log, making cross-node diagnosis unreadable.
 *
 * Isolation rules (first match wins):
 *   1. HALO_DATA_DIR set (cluster node / custom home) → <dataDir>/logs, so a
 *      node's state + logs live self-contained in one folder. Note macOS
 *      Electron does not derive its logs path from the HOME env var, so a
 *      launcher overriding HOME alone does NOT isolate logs — this rule does.
 *   2. Dev run or non-default product variant → ~/Library/Logs/<variant[-dev]>.
 *   3. Packaged default variant → electron-log's default path, untouched.
 *
 * Must run in early bootstrap, before app.whenReady() and before the first
 * file-transport write creates a log file at the default location.
 */

import { join } from 'path'
import { homedir } from 'os'
import type { App } from 'electron'
import log from 'electron-log/main.js'
import { getDataFolderName, DEFAULT_DATA_FOLDER_NAME } from '../product-config'

export function isolateLogPath(app: App): void {
  const customDataDir = process.env.HALO_DATA_DIR
  if (customDataDir) {
    // Expand ~ the same way config.service getHaloDir does (shells don't
    // expand inside env vars).
    const expanded = customDataDir.startsWith('~')
      ? join(homedir(), customDataDir.slice(1))
      : customDataDir
    applyLogsPath(app, join(expanded, 'logs'), 'instance data dir')
  } else {
    const dataFolderName = getDataFolderName()
    const logFolderName = !app.isPackaged ? `${dataFolderName}-dev` : dataFolderName
    if (logFolderName !== DEFAULT_DATA_FOLDER_NAME) {
      applyLogsPath(app, join(app.getPath('logs'), '..', logFolderName), 'variant')
    }
  }

  // Attribution banner: the first line of every log file names its instance,
  // so even copied/concatenated logs stay attributable to a node.
  log.info(`[Main] instance dataDir=${customDataDir ?? 'default'} pid=${process.pid}`)
}

function applyLogsPath(app: App, logsPath: string, reason: string): void {
  app.setPath('logs', logsPath)
  log.transports.file.resolvePathFn = (variables) =>
    join(logsPath, variables.fileName ?? 'main.log')
  console.log(`[Main] logs isolated (${reason}): ${logsPath}`)
}
