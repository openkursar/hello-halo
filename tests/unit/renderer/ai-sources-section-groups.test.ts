/**
 * Groups in the AI model settings: they sit in the provider list like any
 * provider, take the selection mark from the accounts when chosen, and are
 * reached from a quiet menu beside "Add AI Provider" — nothing is added to the
 * screen of someone who never makes one.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: { authGetProviders: vi.fn(), isRemoteMode: () => false } }))
vi.mock('../../../src/renderer/hooks/useOAuthLogin', () => ({ useOAuthLogin: () => ({ login: null, start: vi.fn(), cancel: vi.fn() }) }))
vi.mock('../../../src/renderer/components/settings/ProviderSelector', () => ({ ProviderSelector: () => null }))
vi.mock('../../../src/renderer/components/settings/OAuthAccountEditor', () => ({ OAuthAccountEditor: () => null }))
vi.mock('../../../src/renderer/components/settings/DelegatedLoginDialog', () => ({ DelegatedLoginDialog: () => null }))
vi.mock('../../../src/renderer/components/ai-config/OAuthRedirectLogin', () => ({ OAuthRedirectLogin: () => null }))
vi.mock('../../../src/renderer/components/icons/ProviderIconTile', () => ({ ProviderIconTile: () => null }))
vi.mock('../../../src/renderer/components/icons/BrandIcons', () => ({ getBrandIcon: () => null }))
// The real popover positions itself in a layout effect, which has no server rendering.
vi.mock('../../../src/renderer/components/ui/Popover', async () => {
  const { createElement } = await import('react')
  return {
    Popover: ({ children }: { children: unknown }) => children,
    PopoverTrigger: ({ children, ariaLabel }: { children: unknown; ariaLabel?: string }) => createElement('div', { role: 'button', 'aria-label': ariaLabel }, children as never),
    PopoverContent: () => null,
  }
})

import { AISourcesSection } from '../../../src/renderer/components/settings/AISourcesSection'
import type { AIGroup, AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { HaloConfig } from '../../../src/renderer/types'

function account(id: string): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} one` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const group: AIGroup = {
  id: 'g1', name: 'Daily', strategy: 'priority',
  members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'backup', modelId: 'backup-m1' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

function render(aiSources: AISourcesConfig): string {
  const config = { aiSources } as unknown as HaloConfig
  return renderToStaticMarkup(createElement(AISourcesSection, { config, setConfig: vi.fn() }))
}

const base: AISourcesConfig = { version: 2, currentId: 'main', sources: [account('main'), account('backup')] }
const selectedCards = (html: string) => html.match(/border-primary\/50/g)?.length ?? 0

describe('for someone who never makes a group', () => {
  it('shows no group and no mention of groups, only a small control beside Add AI Provider', () => {
    const html = render(base)
    expect(html).toContain('Add AI Provider')
    expect(html).toContain('aria-label="More ways to add"')
    expect(html).not.toContain('>Auto<')
    expect(html).not.toContain('Load-Balancing')
  })

  it('keeps the account in use marked as before', () => {
    expect(selectedCards(render(base))).toBe(1)
  })
})

describe('with groups', () => {
  it('lists a group after the accounts, like any provider, with its Auto mark', () => {
    const html = render({ ...base, groups: [group] })
    expect(html.indexOf('>backup<')).toBeLessThan(html.indexOf('>Daily<'))
    expect(html).toContain('>Auto<')
    expect(html).toContain('2 accounts')
  })

  it('shows the list even when groups are all there is', () => {
    const html = render({ version: 2, currentId: null, sources: [], groups: [group] })
    expect(html).toContain('>Daily<')
    expect(html).not.toContain('No AI sources configured')
  })

  it('marks only the group, not the account, once the group is chosen for new chats', () => {
    const html = render({ ...base, groups: [group], currentGroupId: 'g1' })
    expect(selectedCards(html)).toBe(1)
    expect(html).toContain('aria-checked="true"')
  })

  it('marks the account again when the chosen group no longer exists', () => {
    const html = render({ ...base, groups: [group], currentGroupId: 'gone' })
    expect(selectedCards(html)).toBe(1)
    expect(html).toContain('aria-checked="false"')
  })

  it('marks nothing on a group that is not chosen', () => {
    const html = render({ ...base, groups: [group] })
    expect(selectedCards(html)).toBe(1)
    expect(html).toContain('aria-checked="false"')
  })
})
