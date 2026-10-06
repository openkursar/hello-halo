/**
 * A download the server cannot provide (file moved or deleted, access refused,
 * no connection) is reported in the app instead of failing silently, in
 * translated words; the server's own message goes to the log.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const downloadArtifact = vi.fn()
vi.mock('../../../src/renderer/api', () => ({ api: { downloadArtifact: (path: string) => downloadArtifact(path) } }))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))

const { downloadArtifact: download } = await import('../../../src/renderer/services/artifact-download')
const { useNotificationStore } = await import('../../../src/renderer/stores/notification.store')

beforeEach(() => {
  useNotificationStore.getState().clear()
  downloadArtifact.mockReset()
})

describe('downloading an artifact', () => {
  it('says so in translated words when the server cannot provide the file, logging the server\'s own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    downloadArtifact.mockResolvedValue({ success: false, error: 'File not found' })
    await download('/space/gone.docx')
    expect(downloadArtifact).toHaveBeenCalledWith('/space/gone.docx')
    expect(useNotificationStore.getState().toasts).toMatchObject([{
      title: 'Could not download this file',
      body: 'It may have been moved or deleted, or the connection to Halo was interrupted. Please try again.',
      variant: 'error',
    }])
    expect(warn).toHaveBeenCalledWith('[ArtifactDownload] Download refused', { error: 'File not found' })
    warn.mockRestore()
  })

  it('stays quiet when the download started', async () => {
    downloadArtifact.mockResolvedValue({ success: true })
    await download('/space/report.docx')
    expect(useNotificationStore.getState().toasts).toEqual([])
  })
})
