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
  | 'downloaded'
  | 'manual-download'
  | 'error'

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
  installMode?: 'installer' | 'restart'
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
