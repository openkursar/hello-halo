/**
 * platform/background/taskbar-theme -- Windows taskbar light/dark detection
 *
 * The taskbar follows the "Windows mode" (SystemUsesLightTheme), which is set
 * separately from the app mode that nativeTheme reports, and Electron has no
 * API for it, so it is read from the registry.
 */

import { execFile } from 'child_process'
import { join } from 'path'

const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

/**
 * Parses the output of a successful `reg query` on the Personalize key. A key
 * without the value is a Windows version that has no light taskbar.
 */
export function parseTaskbarIsDark(regOutput: string): boolean {
  const match = /^\s*SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(regOutput)
  return match ? parseInt(match[1], 16) === 0 : true
}

let warnedReadFailure = false

/** Null when the registry cannot be read (reg exits 1 for every failure, so none is assumed). */
export function readWindowsTaskbarIsDark(): Promise<boolean | null> {
  // Absolute path: a bare name is searched in the working directory first.
  const regExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  return new Promise((resolve) => {
    execFile(regExe, ['query', PERSONALIZE_KEY], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (!err) {
        resolve(parseTaskbarIsDark(stdout))
        return
      }
      if (!warnedReadFailure) {
        warnedReadFailure = true
        console.warn('[Tray] Could not read taskbar theme, keeping current icon:', err.message)
      }
      resolve(null)
    })
  })
}
