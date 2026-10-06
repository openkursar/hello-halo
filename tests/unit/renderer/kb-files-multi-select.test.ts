/**
 * Removing many knowledge base files at once: pick them, confirm once with the
 * count, and see the ones that could not be removed listed. Only the KB's own
 * copies can be picked; files from a watched folder stay out of it.
 */

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RawFileStatus } from '../../../src/shared/types/tlon'

const { translate, storeState } = vi.hoisted(() => ({
  translate: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')),
  storeState: { rawFiles: {} as Record<string, unknown[]>, ingestProgress: {} as Record<string, unknown> },
}))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate }) }))
vi.mock('../../../src/renderer/api', () => ({ api: { isRemoteMode: () => false, getPathForFile: () => '' } }))
vi.mock('../../../src/renderer/stores/tlon.store', () => ({
  useTlonStore: (select: (state: typeof storeState) => unknown) => select(storeState),
}))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ showConfirm: vi.fn(), DialogComponent: null }),
}))
vi.mock('../../../src/renderer/components/tlon/IngestProgress', () => ({ IngestProgress: () => null }))
vi.mock('../../../src/renderer/hooks/useCanvasLifecycle', () => ({ useCanvasActions: () => ({ openFile: vi.fn() }) }))

import {
  FileGroup,
  RawFilesTab,
  removeSelectedFiles,
  type RowSelection,
} from '../../../src/renderer/components/tlon/RawFilesTab'

function file(name: string, overrides: Partial<RawFileStatus> = {}): RawFileStatus {
  return {
    name,
    path: name,
    openPath: `/kb/raw/${name}`,
    size: 1024,
    learned: true,
    state: 'learned',
    source: 'raw',
    ...overrides,
  }
}

const OWN_A = file('a.md')
const OWN_B = file('b.pdf')
const WATCHED = file('c.txt', { path: '/watched/c.txt', source: 'linked', dirLabel: 'Notes' })

describe('removing the selected files', () => {
  it('asks once with the count, removes them, and reports none left over', async () => {
    const confirm = vi.fn(async () => true)
    const remove = vi.fn(async () => ({ failed: [] }))

    await expect(removeSelectedFiles([OWN_A, OWN_B], { confirm, remove })).resolves.toEqual([])

    expect(confirm).toHaveBeenCalledWith(2)
    expect(remove).toHaveBeenCalledWith(['a.md', 'b.pdf'])
  })

  it('hands back the files that could not be removed, by name', async () => {
    const remove = vi.fn(async () => ({ failed: ['b.pdf'] }))

    const left = await removeSelectedFiles([OWN_A, OWN_B], { confirm: async () => true, remove })

    expect(left?.map(f => f.name)).toEqual(['b.pdf'])
  })

  it('removes nothing when the user cancels, or when nothing is selected', async () => {
    const remove = vi.fn(async () => ({ failed: [] }))
    const confirm = vi.fn(async () => false)

    await expect(removeSelectedFiles([OWN_A], { confirm, remove })).resolves.toBeNull()
    await expect(removeSelectedFiles([], { confirm, remove })).resolves.toBeNull()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('the files tab', () => {
  it('offers selection next to the single remove buttons, which stay', () => {
    storeState.rawFiles = { kb1: [OWN_A, file('d.md', { state: 'pending', learned: false }), WATCHED] }

    const html = renderToStaticMarkup(createElement(RawFilesTab, { kb: { id: 'kb1' } as never }))

    expect(html).toContain('Select files')
    expect(html.match(/title="Remove"/g)).toHaveLength(2)
    expect(html).not.toContain('type="checkbox"')
  })

  it('offers no selection when every file comes from a watched folder', () => {
    storeState.rawFiles = { kb1: [WATCHED] }

    const html = renderToStaticMarkup(createElement(RawFilesTab, { kb: { id: 'kb1' } as never }))

    expect(html).not.toContain('Select files')
  })
})

describe('a file group while selecting', () => {
  const selection: RowSelection = {
    isSelected: (f) => f.path === OWN_A.path,
    toggle: vi.fn(),
    setMany: vi.fn(),
  }

  function render(files: RawFileStatus[]) {
    return renderToStaticMarkup(createElement(FileGroup, {
      title: 'Learned',
      files,
      onRemove: vi.fn(),
      formatSize: () => '1 KB',
      selection,
    }))
  }

  it('puts a checkbox on each row and one for the whole group, with no single remove buttons', () => {
    const html = render([OWN_A, OWN_B, WATCHED])
    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []

    expect(boxes).toHaveLength(4)
    expect(boxes[0]).toContain('aria-label="Select all in &quot;Learned&quot;"')
    expect(html).not.toContain('title="Remove"')
  })

  it('marks the picked file and keeps the watched-folder file out of reach', () => {
    const html = render([OWN_A, OWN_B, WATCHED])
    const row = (name: string) => (html.match(new RegExp(`<input[^>]*aria-label="Select &quot;${name.replace('.', '\\.')}&quot;"[^>]*>`)) ?? [''])[0]

    expect(row('a.md')).toContain('checked')
    expect(row('b.pdf')).not.toContain('checked')
    expect(row('c.txt')).toContain('disabled')
    expect(row('c.txt')).toContain('From a watched folder')
  })

  it('has no group checkbox when nothing in it can be removed', () => {
    const html = render([WATCHED])

    expect(html).not.toContain('Select all in')
  })
})
