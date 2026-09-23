/**
 * What the user sees when this build is older than its own data.
 *
 * Two installs of the same product (stable and preview) share one data
 * directory on purpose, so the preview build can upgrade the database and the
 * stable build can then be asked to open it. platform/store detects that and
 * refuses; this module is the part that has to make the refusal make sense,
 * because "database error" would send the user to reinstall — the one action
 * that loses the data a snapshot was just taken of.
 *
 * Lives in bootstrap rather than in the store module because platform/* stays
 * free of Electron and UI; the store reports the condition, the app decides
 * what to do about it.
 */

import { app, dialog, shell } from 'electron'
import type { SchemaAheadError } from '../platform/store'
import { getHaloDir } from '../foundation/config.service'

/** Chinese copy is shown to zh-* locales; every other locale gets English. */
function isChineseLocale(): boolean {
  return app.getLocale().toLowerCase().startsWith('zh')
}

/**
 * Show a terminal, explanatory dialog and quit.
 *
 * Deliberately modal and terminal: the process has already proven it cannot
 * understand the data, and anything it writes from here on compounds the
 * problem rather than recovering from it.
 */
export function refuseNewerData(error: SchemaAheadError): void {
  const dataDir = getHaloDir()
  const zh = isChineseLocale()

  const title = zh ? '数据来自更新的版本' : 'Data is from a newer version'
  const message = zh
    ? '无法打开本地数据'
    : 'This data cannot be opened'
  const detail = zh
    ? [
        '这份数据已经被一个更新的 Halo 版本升级过，当前版本无法读取它。',
        '继续运行会损坏数据，因此已停止启动。',
        '',
        '请改用较新的那个版本打开（例如体验版），或从数据目录中的 .premigrate.bak 快照恢复。',
        '',
        `数据目录：${dataDir}`,
        `（${error.namespace}: 数据 v${error.storedVersion}，本版本支持到 v${error.supportedVersion}）`,
      ].join('\n')
    : [
        'This data was upgraded by a newer version of Halo, which this version cannot read.',
        'Continuing would damage it, so startup has been stopped.',
        '',
        'Open it with the newer build instead, or restore a .premigrate.bak snapshot from the data directory.',
        '',
        `Data directory: ${dataDir}`,
        `(${error.namespace}: data v${error.storedVersion}, this build supports up to v${error.supportedVersion})`,
      ].join('\n')

  const openLabel = zh ? '打开数据目录' : 'Open data folder'
  const quitLabel = zh ? '退出' : 'Quit'

  console.error(`[Bootstrap] ${error.message}`)

  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title,
    message,
    detail,
    buttons: [openLabel, quitLabel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })

  if (choice === 0) {
    // Best-effort: the point of the button is to put the snapshots in front of
    // the user, and failing to open a file manager must not block the exit.
    shell.openPath(dataDir).catch(() => undefined)
  }

  app.exit(1)
}
