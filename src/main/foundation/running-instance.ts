/**
 * Which build currently holds the single-instance lock.
 *
 * The lock is scoped to the data directory, so a stable install and a preview
 * install that deliberately share one data directory also share one lock —
 * which is what keeps two processes from writing the same database at once.
 *
 * The cost is that the second launch dies silently: a user who has the stable
 * build running and double-clicks the preview build sees the stable window
 * come forward and concludes the preview build is broken. Electron gives the
 * losing process no way to ask the winner who it is, so the winner leaves a
 * note here and the loser reads it.
 */

import { app, dialog } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Note left by whichever process holds the lock. */
export interface RunningInstance {
  /** Release feed of the running build ('stable' | 'experience'). */
  channel: string
  /** Product name as the user sees it, for a message that names the right app. */
  productName: string
  pid: number
}

const MARKER_FILENAME = 'running-instance.json'

function markerPath(): string {
  return join(app.getPath('userData'), MARKER_FILENAME)
}

/**
 * Record this process as the lock holder.
 *
 * Called only after the single-instance lock was actually acquired, so the
 * file always describes a process that really is running — modulo a crash,
 * which `readRunningInstance` handles by checking liveness.
 */
export function markRunningInstance(channel: string, productName: string): void {
  try {
    writeFileSync(
      markerPath(),
      JSON.stringify({ channel, productName, pid: process.pid } satisfies RunningInstance),
      'utf8'
    )
  } catch (error) {
    // The marker only improves a message; failing to write it must not affect startup.
    console.warn('[Instance] Could not record running instance:', error)
  }
}

/** Remove this process's note. Safe to call when no note was written. */
export function clearRunningInstance(): void {
  try {
    rmSync(markerPath(), { force: true })
  } catch {
    // A stale marker is handled on read; failing to clean it is not worth a louder failure.
  }
}

/**
 * Read the lock holder's note, or null when there is no live holder.
 *
 * A crashed process leaves its note behind, so the recorded pid is probed
 * before the note is trusted — otherwise the next launch would explain that an
 * app which is not running must be closed first.
 */
export function readRunningInstance(): RunningInstance | null {
  const path = markerPath()
  if (!existsSync(path)) return null

  let parsed: RunningInstance
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as RunningInstance
  } catch {
    return null
  }
  if (!parsed || typeof parsed.pid !== 'number') return null

  try {
    // Signal 0 performs the permission/existence check without delivering anything.
    process.kill(parsed.pid, 0)
  } catch {
    return null
  }

  return parsed
}

/**
 * Tell the user why this launch is about to disappear, when the app that took
 * the lock is a *different* build of the same product.
 *
 * Launching a second copy of the same build is an ordinary double-click and
 * stays silent — the running window comes forward, which is the expected
 * outcome. Only a cross-build collision is surprising enough to interrupt for.
 *
 * `showErrorBox` is used rather than a message box because this runs before
 * the app is ready, which is the only moment the information is still useful.
 */
export function explainLostSingleInstanceLock(thisChannel: string): void {
  const holder = readRunningInstance()

  // Same build launched twice is an ordinary double-click: the running window
  // comes forward, which is what the user expects. Stay silent.
  if (holder && holder.channel === thisChannel) return

  // No note at all means the lock is held by a build that predates this
  // mechanism — in practice the previously-installed one. That is exactly the
  // case worth interrupting for, and the earlier version of this check stayed
  // silent for it, so launching the new build looked like it did nothing while
  // the old build's window surfaced instead.
  const other = holder?.productName
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  const title = zh ? '已有另一个版本在运行' : 'Another version is already running'
  const named = other ?? (zh ? '另一个已安装的 Halo' : 'Another installed copy of Halo')

  const body = zh
    ? `${named} 正在运行，并且和当前版本共用同一份数据。\n\n` +
      '为避免两个版本同时写入造成数据损坏，同一时间只能打开一个。\n\n' +
      `请先完全退出 ${named}（注意检查系统托盘，它可能只是关了窗口仍在后台运行），` +
      '然后重新打开当前版本。'
    : `${named} is running and shares this version's data.\n\n` +
      'Only one may run at a time, so the two cannot write to it at once.\n\n' +
      `Quit ${named} completely first — check the system tray, closing its ` +
      'window may only have hidden it — then open this version again.'

  dialog.showErrorBox(title, body)
}
