/**
 * Updater status contract (main -> renderer, over the `updater:status` channel).
 *
 * Declared once here because the payload crosses main, preload and renderer:
 * an inline re-declaration per surface is how a field silently drifts out of
 * sync with the sender.
 */

export type UpdaterStatusPhase =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  /** Unpacking the update beside the running version (Windows staged path only). */
  | 'staging'
  | 'downloaded'
  | 'manual-download'
  | 'error'

/**
 * Which release feed a build follows.
 *
 * Decided at build time and never at runtime: a build that could pick its own
 * channel could walk a user from the stable feed onto prereleases (or back)
 * without anyone publishing a thing.
 */
export type UpdaterChannel = 'stable' | 'experience'

/**
 * How a downloaded update gets applied, which is what the restart prompt has
 * to describe honestly.
 *
 * - 'installer': Windows runs the NSIS installer, which takes visible time.
 * - 'restart':   macOS/Linux swap an already-staged build and relaunch.
 * - 'swap':      Windows staged path — unpacking already happened, so this is
 *                a quit and relaunch like the other platforms.
 */
export type UpdaterInstallMode = 'installer' | 'restart' | 'swap'

/** Per-version note as the update feed reports it; `note` is absent for some feeds. */
export interface UpdaterReleaseNote {
  version: string
  note: string | null
}

/** Mirrors electron-updater's `UpdateInfo.releaseNotes`, which is passed through as-is. */
export type UpdaterReleaseNotes = string | UpdaterReleaseNote[] | null

export interface UpdaterStatusPayload {
  status: UpdaterStatusPhase
  version?: string
  message?: string
  releaseNotes?: UpdaterReleaseNotes
  releaseDate?: string
  /** How the downloaded update is applied — decided by the main process. */
  installMode?: UpdaterInstallMode
  /** Feed this build follows, so the UI can show which one the user is on. */
  channel?: UpdaterChannel
  /** Download page to fall back to when the update cannot be applied. */
  downloadUrl?: string
  /** Release marked unskippable by the feed — the prompt offers no way out but updating. */
  mandatory?: boolean

  // Download progress, sent only with status 'downloading'.
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
}
