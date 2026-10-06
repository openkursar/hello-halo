import { api } from '../api'
import i18n from '../i18n'
import { useNotificationStore } from '../stores/notification.store'

/**
 * Download an artifact from the remote page or the mobile app (the desktop
 * opens it instead), saying so in the app when the server cannot provide it.
 * The server's own wording goes to the log; the user gets a translated reason.
 */
export async function downloadArtifact(filePath: string): Promise<void> {
  const result = await api.downloadArtifact(filePath)
  if (result.success) return
  console.warn('[ArtifactDownload] Download refused', { error: result.error })
  useNotificationStore.getState().show({
    title: i18n.t('Could not download this file'),
    body: i18n.t('It may have been moved or deleted, or the connection to Halo was interrupted. Please try again.'),
    variant: 'error',
    duration: 5000,
  })
}
