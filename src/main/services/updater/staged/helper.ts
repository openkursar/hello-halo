/**
 * Running the Windows update helper.
 *
 * The helper is a separate native executable because the work it does —
 * moving the entire install directory aside and putting a new one in its
 * place — cannot be done by a process living inside that directory. By the
 * time the swap runs, the Electron runtime that would host this code has
 * already been moved.
 *
 * This module only starts it and interprets its exit codes. Everything about
 * how the swap is performed, and how it is reversed, lives in the helper.
 */

import { spawn } from 'child_process'
import { copyFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { bundledHelperPath, helperRunPath, type StagedLayout } from './layout'

/**
 * Helper exit codes that this side needs to distinguish.
 *
 * These mirror `win-update-helper/internal/exitcode/exitcode.go`, which is the
 * source of truth — a test asserts the two stay identical, because a silent
 * off-by-one here would report a cleanly reversed swap as an install that
 * needs reinstalling.
 *
 * Anything not listed is treated as a plain failure. The one that matters is
 * SWAP_NOT_REVERSED: it is the only outcome that leaves an install directory
 * the user cannot start from, and the only one that justifies telling them so.
 */
export const HelperExit = {
  OK: 0,
  USAGE: 1,
  BAD_HASH: 2,
  STAGE_FAILED: 3,
  STAGED_INCOMPLETE: 4,
  APP_STILL_RUNNING: 5,
  SWAP_REVERSED: 6,
  SWAP_NOT_REVERSED: 7,
  CONFIRM_TIMEOUT: 8,
  ROLLBACK_FAILED: 9,
} as const

export class HelperError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.name = 'HelperError'
    this.code = code
  }
}

/** Protocol version this build's code was written against. */
export const EXPECTED_HELPER_VERSION = 1

/**
 * Longest a helper subcommand may run before it is treated as wedged.
 *
 * Every spawn here needs one: the update path is a chain of awaits, so one
 * process that never exits (antivirus holding an unsigned binary is the usual
 * cause) silently disables updating for the whole session.
 */
const VERSION_PROBE_TIMEOUT_MS = 15_000
const STAGE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Run a helper subcommand to completion, or give up.
 *
 * Output is left to the helper's own log file; only the exit code is
 * interpreted here, so a helper that floods stdout cannot wedge this process
 * through an unread pipe.
 */
function runHelper(
  executable: string,
  args: string[],
  timeoutMs: number,
  detached = false
): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, args, { windowsHide: true, detached, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }

    if (detached) {
      // Only 'spawn' proves the process exists. An executable blocked by
      // antivirus or AppLocker surfaces as 'error' after spawn() returns; with
      // no listener that is an uncaught exception in the main process, and
      // with an early resolve the caller has already quit the app.
      child.once('spawn', () => {
        child.unref()
        resolve(0)
      })
      child.once('error', reject)
      return
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.error(
        `[Updater] Helper "${args[0]}" did not finish within ${timeoutMs}ms — killing it`
      )
      try {
        child.kill()
      } catch {
        // Already gone; the reject below is what the caller acts on.
      }
      reject(new Error(`update helper "${args[0]}" timed out`))
    }, timeoutMs)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code ?? -1)
    })
  })
}

/**
 * Ask the bundled helper which protocol version it speaks.
 *
 * @returns null when the helper cannot be run at all, with the reason logged —
 *   the caller turns that into "no staged update", and without the reason
 *   there is no way to tell a missing helper from a blocked one.
 */
export async function readHelperVersion(): Promise<number | null> {
  const executable = bundledHelperPath()

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, ['version'], { windowsHide: true })
    } catch (error) {
      console.error(`[Updater] Could not start update helper at ${executable}: ${String(error)}`)
      resolve(null)
      return
    }

    let output = ''
    let settled = false
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      // Antivirus scanning an unsigned executable can hold it here
      // indefinitely. Reporting it is what separates "blocked" from "broken".
      console.error(
        `[Updater] Update helper did not answer within ${VERSION_PROBE_TIMEOUT_MS}ms ` +
          `(${executable}) — treating staged updates as unavailable`
      )
      try {
        child.kill()
      } catch {
        // Nothing more to do; we are already giving up on it.
      }
      finish(null)
    }, VERSION_PROBE_TIMEOUT_MS)

    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', (error) => {
      console.error(`[Updater] Update helper failed to run (${executable}): ${String(error)}`)
      finish(null)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[Updater] Update helper "version" exited ${code} (${executable})`)
        finish(null)
        return
      }
      const parsed = Number.parseInt(output.trim(), 10)
      if (!Number.isInteger(parsed)) {
        console.error(`[Updater] Update helper reported an unreadable version: ${JSON.stringify(output)}`)
        finish(null)
        return
      }
      finish(parsed)
    })
  })
}

/**
 * Unpack a verified package into the staging directory.
 *
 * Runs while the app is still in use, so it must never touch anything the
 * running app has open — the helper writes only inside `stagedDir`.
 */
export async function stagePackage(
  layout: StagedLayout,
  archivePath: string,
  sha512: string,
  version: string
): Promise<void> {
  console.log(`[Updater] Unpacking ${version} into ${layout.stagedDir}`)
  const startedAt = Date.now()

  const code = await runHelper(bundledHelperPath(), [
    'stage',
    '--archive', archivePath,
    '--dest', layout.stagedDir,
    '--expect-sha512', sha512,
    '--version', version,
    '--log', layout.helperLog,
  ], STAGE_TIMEOUT_MS)

  if (code === HelperExit.OK) {
    console.log(`[Updater] Unpacked ${version} in ${Math.round((Date.now() - startedAt) / 1000)}s`)
    return
  }
  if (code === HelperExit.BAD_HASH) {
    throw new HelperError('update package failed its integrity check', code)
  }
  throw new HelperError(
    `update package could not be unpacked (helper exit ${code}, see ${layout.helperLog})`,
    code
  )
}

/**
 * Hand the swap to a detached helper and return once it is running.
 *
 * The helper is copied out of the shipped tree first, because the swap moves
 * that tree — including the copy that shipped with the app. Resolves only
 * after the process has started, so the caller can quit knowing something will
 * finish the job; a rejection means nothing was touched. The helper waits for
 * this process to exit before moving anything.
 */
export async function launchApply(
  layout: StagedLayout,
  version: string,
  confirmFile: string,
  confirmTimeoutSeconds: number
): Promise<void> {
  await mkdir(layout.workDir, { recursive: true })
  await mkdir(dirname(layout.helperLog), { recursive: true })

  const runnable = helperRunPath(layout)
  await copyFile(bundledHelperPath(), runnable)

  console.log(`[Updater] Handing over to update helper: ${runnable}`)
  await runHelper(runnable, [
    'apply',
    '--install-dir', layout.installDir,
    '--staged', layout.stagedDir,
    '--backup', layout.backupDir,
    '--wait-pid', String(process.pid),
    '--version', version,
    '--relaunch', layout.exePath,
    '--confirm-file', confirmFile,
    '--confirm-timeout', String(confirmTimeoutSeconds),
    '--state', layout.stateFile,
    '--log', layout.helperLog,
  ], VERSION_PROBE_TIMEOUT_MS, true)
}

/**
 * Undo an interrupted update, from a helper that outlives this process.
 *
 * The files being moved back include this app's own executable and resources,
 * which Windows will not rename while they are open — so the helper waits for
 * this process to exit, rolls back, and starts the app again. Resolves once the
 * helper is running; the caller must then quit.
 */
export async function launchRollback(layout: StagedLayout): Promise<void> {
  await mkdir(layout.workDir, { recursive: true })
  await mkdir(dirname(layout.helperLog), { recursive: true })

  const runnable = helperRunPath(layout)
  await copyFile(bundledHelperPath(), runnable)

  console.log(`[Updater] Handing rollback to update helper: ${runnable}`)
  await runHelper(runnable, [
    'rollback',
    '--state', layout.stateFile,
    '--wait-pid', String(process.pid),
    '--relaunch', layout.exePath,
    '--log', layout.helperLog,
  ], VERSION_PROBE_TIMEOUT_MS, true)
}
