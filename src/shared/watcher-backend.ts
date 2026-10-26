/**
 * The @parcel/watcher backend every subscription names. On Windows the default
 * backend first probes for Watchman through `_popen`, a cmd.exe launch without
 * CREATE_NO_WINDOW, so a process without a console (the main process, the
 * file-watcher worker) flashes a console window each time it starts watching
 * again after its last watch stopped.
 *
 * Pure function — no Node/Electron imports (shared-module constraint).
 */
export function watcherBackend(platform: string): 'windows' | undefined {
  return platform === 'win32' ? 'windows' : undefined
}
