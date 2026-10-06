/**
 * A watched folder whose files are not being learned says so: in the knowledge
 * base settings next to the folder (over the file limit, too large to scan, or
 * unavailable with a Retry), and in the knowledge base's header next to the
 * learned count, which would otherwise look complete.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  }),
}))
vi.mock('../../../src/renderer/components/tlon/ChatTab', () => ({ ChatTab: () => null }))
vi.mock('../../../src/renderer/components/tlon/RawFilesTab', () => ({ RawFilesTab: () => null }))
vi.mock('../../../src/renderer/components/tlon/SettingsTab', () => ({ SettingsTab: () => null }))

import { WatchedFolderRow } from '../../../src/renderer/components/tlon/WatchedFolderRow'
import { KBDetail } from '../../../src/renderer/components/tlon/KBDetail'
import type { KnowledgeBaseEntry, LinkedDirectory } from '../../../src/shared/types/tlon'

const folder = (overrides: Partial<LinkedDirectory> = {}): LinkedDirectory => ({
  id: 'l1',
  path: '/Volumes/Docs/product',
  label: 'product',
  watching: true,
  ...overrides,
})

const row = (dir: LinkedDirectory) =>
  renderToStaticMarkup(createElement(WatchedFolderRow, { dir, retrying: false, onRetry: () => {}, onRemove: () => {} }))

const header = (linkedDirs: LinkedDirectory[]) => {
  const kb: KnowledgeBaseEntry = {
    id: 'kb1',
    name: 'Docs',
    icon: '',
    description: '',
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    path: '/kb',
    linkedDirs,
    spaceIds: [],
    appIds: [],
    stats: { rawFileCount: 40, indexedCount: 40, rawSizeBytes: 0 },
  }
  return renderToStaticMarkup(createElement(KBDetail, { kb, onDeleted: () => {} }))
}

describe('a watched folder that is not being learned', () => {
  it('says the folder is over the file limit and learning is paused', () => {
    const html = row(folder({ learningPaused: { reason: 'too-many-files', count: 620, limit: 500 } }))

    expect(html).toContain('620 files, over the 500-file limit: learning paused.')
    expect(html).not.toContain('Unavailable')
  })

  it('says a folder too large to scan is paused', () => {
    expect(row(folder({ learningPaused: { reason: 'too-large' } }))).toContain('Too many files and subfolders to scan: learning paused.')
  })

  it('offers a Retry on an unavailable folder, without a stale pause reason', () => {
    const html = row(folder({ watching: false, learningPaused: { reason: 'too-large' } }))

    expect(html).toContain('Unavailable')
    expect(html).toContain('Retry')
    expect(html).not.toContain('learning paused')
  })

  it('shows nothing extra for a folder being learned', () => {
    const html = row(folder())

    expect(html).not.toContain('Unavailable')
    expect(html).not.toContain('Retry')
    expect(html).not.toContain('learning paused')
  })

  it('is counted next to the learned count in the knowledge base header', () => {
    const html = header([
      folder({ id: 'a', watching: false }),
      folder({ id: 'b', learningPaused: { reason: 'too-many-files', count: 620, limit: 500 } }),
      folder({ id: 'c' }),
    ])

    expect(html).toContain('40/40 learned')
    expect(html).toContain('2 watched folder(s) not learning')
    expect(header([folder()])).not.toContain('not learning')
  })
})
