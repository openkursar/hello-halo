/**
 * A build can say that a model provider's account comes with its organization
 * sign-in. That provider's own login is then marked, so every login list offers
 * the sign-in in its place; builds that say nothing keep their logins as they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const env = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getAppPath: () => env.root, isPackaged: true } }))

const login = (type: string) => ({ type, displayName: type, description: '', icon: 'cloud', iconBgColor: '#000000', recommended: false, enabled: true })

async function providersFor(product: Record<string, unknown>) {
  writeFileSync(join(env.root, 'product.json'), JSON.stringify({ authProviders: [login('cloud'), login('other')], ...product }))
  vi.resetModules()
  const { getEnabledAuthProviderConfigs } = await import('../../../src/main/services/ai-sources/auth-loader')
  return getEnabledAuthProviderConfigs().map(provider => [provider.type, provider.organizationSignIn ?? false])
}

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'halo-product-org-models-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(env.root, { recursive: true, force: true })
})

describe('model accounts that come with the organization sign-in', () => {
  it('marks only the declared provider', async () => {
    expect(await providersFor({
      enterpriseIdentity: { provider: './id.js', modelAccounts: [{ aiSourceType: 'cloud', capability: 'model', audience: 'cloud-model' }] },
    })).toEqual([['cloud', true], ['other', false]])
  })

  it('leaves every login alone without an organization sign-in or without model accounts', async () => {
    expect(await providersFor({})).toEqual([['cloud', false], ['other', false]])
    expect(await providersFor({ enterpriseIdentity: { provider: './id.js' } })).toEqual([['cloud', false], ['other', false]])
    expect(await providersFor({ enterpriseIdentity: { modelAccounts: [{ aiSourceType: 'cloud' }] } })).toEqual([['cloud', false], ['other', false]])
  })

  it('is declared in the product schema with the fields the sign-in needs', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../product.schema.json', import.meta.url), 'utf8'))
    expect(schema.properties.enterpriseIdentity.properties.modelAccounts.items).toMatchObject({
      required: ['aiSourceType', 'capability', 'audience'], additionalProperties: false,
    })
  })
})
