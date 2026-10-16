import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const env = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getAppPath: () => env.root, isPackaged: true } }))

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'halo-product-federation-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(env.root, { recursive: true, force: true })
})

describe('packaged federation defaults', () => {
  it('reads the gateway from the packaged product, never the development override', async () => {
    writeFileSync(join(env.root, 'product.json'), JSON.stringify({
      authProviders: [], federation: { gatewayUrl: 'https://relay.example.test/' },
    }))
    writeFileSync(join(env.root, 'product.local.json'), JSON.stringify({
      authProviders: [], federation: { gatewayUrl: 'https://dev.example.test/' },
    }))
    vi.resetModules()
    const { getProductFederationGatewayUrl } = await import('../../../src/main/foundation/product-config')
    expect(getProductFederationGatewayUrl()).toBe('https://relay.example.test/')
  })

  it('provides no gateway when another build does not declare one', async () => {
    writeFileSync(join(env.root, 'product.json'), JSON.stringify({ authProviders: [] }))
    vi.resetModules()
    const { getProductFederationGatewayUrl } = await import('../../../src/main/foundation/product-config')
    expect(getProductFederationGatewayUrl()).toBeUndefined()
  })

  it('declares optional gateway defaults in the product schema', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../product.schema.json', import.meta.url), 'utf8'))
    expect(schema.properties.federation).toMatchObject({
      type: 'object', properties: { gatewayUrl: { type: 'string' } }, additionalProperties: false,
    })
    expect(schema.required).not.toContain('federation')
  })
})
