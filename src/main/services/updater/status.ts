/**
 * What the renderer is currently being told about an update, and why.
 *
 * Both platform paths report through here so the prompt the user sees cannot
 * depend on which one produced it. It also holds the one piece of state that
 * decides whether a failure still needs rescuing: an update announced but not
 * yet applied leaves someone waiting on something that will never arrive,
 * while an update already staged on disk survives a later network blip.
 */

import { getMainWindow } from '../../foundation/window.service'
import { getUpdateChannel } from '../../foundation/product-config'
import type {
  UpdaterReleaseNotes,
  UpdaterStatusPayload,
  UpdaterStatusPhase,
} from '../../../shared/types/updater'

/** How far an announced update got, which decides how a failure is handled. */
export type AnnouncedPhase = 'downloading' | 'staging' | 'ready' | 'applying'

export interface AnnouncedUpdate {
  version: string
  releaseNotes: UpdaterReleaseNotes
  mandatory: boolean
  phase: AnnouncedPhase
}

let announced: AnnouncedUpdate | null = null

export function getAnnounced(): AnnouncedUpdate | null {
  return announced
}

export function setAnnounced(update: AnnouncedUpdate | null): void {
  announced = update
}

export function setAnnouncedPhase(phase: AnnouncedPhase): void {
  if (announced) announced.phase = phase
}

/**
 * Push a status to the renderer.
 *
 * The channel is attached to every message rather than asked for separately,
 * so a UI that shows "you are on the preview channel" cannot disagree with the
 * update it is showing.
 */
export function sendUpdateStatus(
  status: UpdaterStatusPhase,
  data?: Omit<UpdaterStatusPayload, 'status' | 'channel'>
): void {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return

  const payload: UpdaterStatusPayload = { status, channel: getUpdateChannel(), ...data }
  mainWindow.webContents.send('updater:status', payload)
}

/**
 * Offer the download page when an announced update can no longer be applied.
 *
 * Only meaningful before the update is on disk — a staged or downloaded update
 * that hits an error afterwards is still installable, so the user is left with
 * the working prompt instead of being sent to a browser.
 *
 * @returns true when the failure was converted into a download prompt.
 */
export function offerManualDownload(downloadUrl: string): boolean {
  if (!announced || announced.phase === 'ready') return false

  const { version, releaseNotes, mandatory } = announced
  announced = null
  sendUpdateStatus('manual-download', { version, releaseNotes, mandatory, downloadUrl })
  return true
}
