/**
 * A folder dropped on "New Workspace" opens the create form already pointed
 * at it — the folder as the custom location and its name as the space name —
 * so making a workspace from a project folder takes one confirmation.
 */

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
vi.mock('../../../src/renderer/api', () => ({
  api: {
    isRemoteMode: () => false,
    getDefaultSpacePath: async () => ({ success: true, data: '/home/u/.halo/spaces' }),
    selectFolder: async () => ({ success: false }),
    getPathForFile: () => '',
  },
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({
  useSpaceStore: (select: (state: { createSpace: () => void }) => unknown) => select({ createSpace: vi.fn() }),
}))

import { NewSpaceCard, readFolderDrop } from '../../../src/renderer/components/space/NewSpaceCard'
import { CreateSpaceForm } from '../../../src/renderer/components/space/CreateSpaceForm'

/** The parts of a DataTransfer that readFolderDrop looks at. */
function drop(kind: 'directory' | 'file' | 'none') {
  const file = { name: 'payments' } as File
  const entry = kind === 'none' ? null : { isDirectory: kind === 'directory' }
  return {
    items: [{ webkitGetAsEntry: () => entry }] as unknown as DataTransferItemList,
    files: (kind === 'none' ? [] : [file]) as unknown as FileList,
  }
}

describe('reading a drop on the new-workspace card', () => {
  it('takes a folder, with its local path', () => {
    expect(readFolderDrop(drop('directory'), () => '/projects/payments')).toEqual({ path: '/projects/payments' })
  })

  it('tells a file apart from a folder', () => {
    expect(readFolderDrop(drop('file'), () => '/projects/notes.txt')).toBe('not-a-folder')
  })

  it('ignores a drop with nothing usable in it', () => {
    expect(readFolderDrop(drop('none'), () => '/x')).toBeNull()
    // No local path behind it (e.g. a browser without the desktop bridge).
    expect(readFolderDrop(drop('directory'), () => '')).toBeNull()
  })
})

describe('the create form started from a folder', () => {
  it('names the space after the folder and selects it as the custom location', () => {
    const html = renderToStaticMarkup(createElement(CreateSpaceForm, {
      onCreated: () => undefined,
      onCancel: () => undefined,
      initialFolder: '/projects/payments',
    }))

    expect(html).toContain('value="payments"')
    expect(html).toContain('/projects/payments')
    // Two radios: default location, then custom folder — the custom one is chosen.
    const radios = html.match(/<input type="radio"[^>]*>/g) ?? []
    expect(radios).toHaveLength(2)
    expect(radios[0]).not.toContain('checked')
    expect(radios[1]).toContain('checked')
  })

  it('starts empty on the default location without one', () => {
    const html = renderToStaticMarkup(createElement(CreateSpaceForm, {
      onCreated: () => undefined,
      onCancel: () => undefined,
    }))

    expect(html).toContain('value=""')
    const radios = html.match(/<input type="radio"[^>]*>/g) ?? []
    expect(radios[0]).toContain('checked')
  })
})

describe('the new-workspace card', () => {
  it('invites a folder drop only where drops are accepted', () => {
    const withDrop = renderToStaticMarkup(createElement(NewSpaceCard, { onClick: () => undefined, onFolderDrop: () => undefined }))
    const without = renderToStaticMarkup(createElement(NewSpaceCard, { onClick: () => undefined }))

    expect(withDrop).toContain('or drop a project folder here')
    expect(without).not.toContain('drop')
  })
})
