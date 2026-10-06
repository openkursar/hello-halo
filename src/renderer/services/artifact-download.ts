import { api } from '../api'
import i18n from '../i18n'
import { useNotificationStore } from '../stores/notification.store'

/**
 * Download an artifact from the remote page or the mobile app (the desktop
 * opens it instead), saying so in the app when the server cannot provide it.
 */
export async function downloadArtifact(filePath: string): Promise<void> {
  const result = await api.downloadArtifact(filePath)
  if (result.success) return
  useNotificationStore.getState().show({
    title: i18n.t('Could not download this file'),
    body: result.error,
    variant: 'error',
    duration: 5000,
  })
}
