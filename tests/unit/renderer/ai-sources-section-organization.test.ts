/**
 * The organization sign-in in the AI model settings: one card in the list once
 * signed in, carrying the model account that came with it, and nothing of the
 * kind in a build without the sign-in.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OrgSignInState } from '../../../src/shared/types/enterprise-identity'

const env = vi.hoisted(() => ({ offered: true, state: null as OrgSignInState | null }))

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: { authGetProviders: vi.fn(), isRemoteMode: () => false } }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => true, orgSignInOffered: () => env.offered }))
vi.mock('../../../src/renderer/stores/org-sign-in.store', () => {
  const store = () => ({ state: env.state, readFailed: false, lastResult: null, start: () => {}, signIn: vi.fn(), signOut: vi.fn(), retry: vi.fn() })
  return { useOrgSignInStore: (select: (value: ReturnType<typeof store>) => unknown) => select(store()) }
})
vi.mock('../../../src/renderer/hooks/useOAuthLogin', () => ({ useOAuthLogin: () => ({ login: null, start: vi.fn(), cancel: vi.fn() }) }))
vi.mock('../../../src/renderer/components/settings/ProviderSelector', () => ({ ProviderSelector: () => null }))
vi.mock('../../../src/renderer/components/settings/OAuthAccountEditor', () => ({ OAuthAccountEditor: () => null }))
vi.mock('../../../src/renderer/components/settings/DelegatedLoginDialog', () => ({ DelegatedLoginDialog: () => null }))
vi.mock('../../../src/renderer/components/ai-config/OAuthRedirectLogin', () => ({ OAuthRedirectLogin: () => null }))
vi.mock('../../../src/renderer/components/icons/ProviderIconTile', () => ({ ProviderIconTile: () => null }))
vi.mock('../../../src/renderer/components/icons/BrandIcons', () => ({ getBrandIcon: () => null }))
vi.mock('../../../src/renderer/components/ui/Popover', async () => {
  const { createElement } = await import('react')
  return {
    Popover: ({ children }: { children: unknown }) => children,
    PopoverTrigger: ({ children, ariaLabel }: { children: unknown; ariaLabel?: string }) => createElement('div', { role: 'button', 'aria-label': ariaLabel }, children as never),
    PopoverContent: () => null,
  }
})

import { AISourcesSection } from '../../../src/renderer/components/settings/AISourcesSection'
import type { AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { HaloConfig } from '../../../src/renderer/types'

const own: AISource = {
  id: 'own', name: 'My key', provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
  model: 'own-model', availableModels: [{ id: 'own-model', name: 'Own' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const brought: AISource = { ...own, id: 'org', name: 'Cloud account', provider: 'cloud', authType: 'oauth', apiKey: '', managedBy: 'organization', model: 'org-model' }
const active: OrgSignInState = {
  status: 'active', name: 'Example Org', account: { displayName: 'Example Member' },
  capabilities: [{ id: 'model', label: 'Models', status: 'ready' }, { id: 'intranet', label: 'Internal systems', status: 'ready' }],
  boundTools: [], signingIn: false, canUnbindDevice: true,
}

function render(aiSources: AISourcesConfig): string {
  return renderToStaticMarkup(createElement(AISourcesSection, { config: { aiSources } as unknown as HaloConfig, setConfig: vi.fn() }))
}

describe('the organization sign-in among the AI model accounts', () => {
  it('shows the account it brought as its own card, chosen like any account, and not a second time', () => {
    env.offered = true
    env.state = active
    const html = render({ version: 2, currentId: 'org', sources: [own, brought] })
    expect(html.match(/data-testid="org-account-card"/g)).toHaveLength(1)
    expect(html).toContain('Example Org')
    expect(html).toContain('org-model')
    expect(html).toContain('Example Member')
    expect(html).not.toContain('Cloud account')
    expect(html).toContain('aria-label="Use Example Org for new chats"')
    expect(html.indexOf('org-account-card')).toBeLessThan(html.indexOf('data-ai-source-id="own"'))
  })

  it('summarises what works when no model account came with it', () => {
    env.state = active
    const html = render({ version: 2, currentId: 'own', sources: [own] })
    expect(html).toContain('Models and Internal systems connected')
    expect(html).not.toContain('Use Example Org for new chats')
  })

  it('names what needs signing in again on the card itself', () => {
    env.state = { ...active, capabilities: [active.capabilities[0], { id: 'mail', label: 'Mail', status: 'expired' }] }
    expect(render({ version: 2, currentId: 'own', sources: [own] })).toContain('Mail needs signing in again')
  })

  it('leaves the list unchanged in a build without the sign-in', () => {
    env.offered = false
    env.state = active
    const html = render({ version: 2, currentId: 'org', sources: [own, brought] })
    expect(html).not.toContain('org-account-card')
    expect(html).toContain('Cloud account')
  })
})
