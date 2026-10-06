/**
 * What the user reads about an author's upgrade that kept fields at their
 * version: the activity note and the store's update dialog. The wording says
 * the fields differ from the author's new version, never that the user changed
 * them — after an upgrade with no earlier author's version that is not known.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/stores/apps.store', () => {
  const state = { apps: [] }
  const useAppsStore = (select: (value: typeof state) => unknown) => select(state)
  useAppsStore.getState = () => state
  return { useAppsStore }
})
vi.mock('react-dom', async original => ({
  ...await original<typeof import('react-dom')>(),
  createPortal: (node: unknown) => node,
}))

import { UpgradeNote } from '../../../src/renderer/components/apps/UpgradeNote'
import { StoreUpdateDialog } from '../../../src/renderer/components/store/StoreUpdateDialog'
import { upgradedMessage } from '../../../src/renderer/components/apps/spec-field-label'

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(component, props))
}

const note = { fromVersion: '1.2.0', toVersion: '1.3.0', kept: ['system_prompt', 'subscriptions'], editsKnown: true }

describe('UpgradeNote', () => {
  it('names what kept the user’s version without claiming the user changed it', () => {
    const html = render(UpgradeNote, { appId: 'app-1', entryId: 'entry-1', note })

    expect(html).toContain('Upgraded from v1.2.0 to v1.3.0.')
    expect(html).toContain('These differ from the author’s new version, so your current version was kept:')
    expect(html).toContain('System Prompt')
    expect(html).toContain('Run times')
    expect(html).not.toMatch(/you changed/i)
    expect(html).toContain('Use the author’s version for all')
  })

  it('says when Halo cannot tell what the user changed, and that the author’s new run times were left out', () => {
    const html = render(UpgradeNote, { appId: 'app-1', entryId: 'entry-1', note: { ...note, editsKnown: false } })

    expect(html).toContain('Halo cannot tell which of them you changed.')
    expect(html).toContain('Run times the author added were not added; use the author’s version to get them.')
  })

  it('lists connections and skills among what can be kept', () => {
    const html = render(UpgradeNote, { appId: 'app-1', entryId: 'entry-1', note: { ...note, kept: ['requires'] } })

    expect(html).toContain('Connections and skills')
    expect(html).toContain('Use the author’s version')
  })

  it('offers no switch once every kept item uses the author’s version', () => {
    const html = render(UpgradeNote, {
      appId: 'app-1',
      entryId: 'entry-1',
      note: { ...note, adopted: ['system_prompt', 'subscriptions'] },
    })

    expect(html).not.toContain('Use the author’s version')
    expect(html).toContain('View the author’s version')
  })
})

describe('upgradedMessage', () => {
  const t = translate as unknown as Parameters<typeof upgradedMessage>[2]

  it('says only the version when the update applied in full', () => {
    expect(upgradedMessage('1.3.0', { kept: [], editsKnown: true }, t, 'en')).toBe('Upgraded to v1.3.0')
  })

  it('names what kept the user’s version', () => {
    const message = upgradedMessage('1.3.0', { kept: ['system_prompt', 'subscriptions'], editsKnown: true }, t, 'en')

    expect(message).toBe('Upgraded to v1.3.0. These differ from the author’s new version and kept your current version: System Prompt and Run times')
  })

  it('adds that Halo cannot tell which of them the user changed when there was no earlier author’s version', () => {
    const message = upgradedMessage('1.3.0', { kept: ['system_prompt'], editsKnown: false }, t, 'en')

    expect(message).toMatch(/kept your current version: System Prompt Halo cannot tell which of them you changed\.$/)
  })
})

describe('StoreUpdateDialog', () => {
  // The portal is rendered inline above; only its target is read.
  beforeEach(() => {
    vi.stubGlobal('document', { body: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const base = {
    fromVersion: '1.2.0',
    toVersion: '1.3.0',
    onInstallCopy: () => {},
    onOverwrite: () => {},
    onIgnore: () => {},
    onClose: () => {},
  }

  it('names, before updating, what a digital human will keep at the user’s version', () => {
    const html = render(StoreUpdateDialog, {
      ...base,
      preview: { status: 'ready', kept: ['system_prompt', 'subscriptions'], editsKnown: true },
    })

    expect(html).toContain('These differ from the author’s new version and will keep your current version: System Prompt and Run times')
    expect(html).toContain('Update in place')
    expect(html).not.toContain('Local edits to the app content are replaced.')
    expect(html).not.toMatch(/you changed/i)
  })

  it('keeps the replace wording for an app that is replaced by the new version', () => {
    const html = render(StoreUpdateDialog, base)

    expect(html).toContain('Local edits to the app content are replaced.')
    expect(html).not.toContain('will keep your current version')
  })
})
