/**
 * Unit test: services/agent/dsh/options — what Halo pins on the runtime child.
 *
 * Two things the runtime cannot work out for itself converge here. Its DeepSeek
 * adapter assumes DeepSeek's own numbers (256K output, 1M window) for every
 * vendor, so an unstated cap means a GLM endpoint answers HTTP 400 before the
 * turn starts and compaction never fires inside the real window. And it builds
 * its own request headers around a single bearer, so unless it is pointed at
 * Halo's compat router the active source's headers and adapter never reach the
 * provider — which is how the runtime's own `User-Agent` came to be what
 * a provider gateway saw, and refused.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const getApiCredentials = vi.fn()
const buildDshLaunchSpec = vi.fn()
const ensureOpenAICompatRouter = vi.fn()

vi.mock('../../../../../src/main/services/agent/helpers', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../../src/main/services/agent/helpers')
  >()
  return {
    ...actual,
    getApiCredentials: (config: unknown) => getApiCredentials(config),
  }
})

vi.mock('../../../../../src/main/openai-compat-router', () => ({
  ensureOpenAICompatRouter: (options: unknown) => ensureOpenAICompatRouter(options),
  encodeBackendConfig: (config: unknown) =>
    Buffer.from(JSON.stringify(config)).toString('base64'),
}))

vi.mock('../../../../../src/main/services/agent/dsh/runtime', () => ({
  buildDshLaunchSpec: (options: Record<string, any>) => buildDshLaunchSpec(options),
}))

const { resolveDshOptions } = await import(
  '../../../../../src/main/services/agent/dsh/options'
)

const LAUNCH = { command: 'node', args: ['entry.js', 'config.yml'], env: {}, cwd: '/work' }

/** What `getApiCredentials` returns for a GLM route behind a custom gateway. */
function credentials(capabilities?: { maxOutputTokens: number; contextWindow: number }) {
  return {
    baseUrl: 'https://gateway.example.com/v1/chat/completions',
    apiKey: 'k',
    model: 'glm-4.7-zp',
    provider: 'openai' as const,
    ...(capabilities ? { capabilities } : {}),
  }
}

/** The descriptor the runtime was handed as its bearer token. */
function launchedBackendConfig(): Record<string, unknown> {
  const { apiKey } = buildDshLaunchSpec.mock.calls[0][0]
  return JSON.parse(Buffer.from(apiKey, 'base64').toString('utf-8'))
}

beforeEach(() => {
  getApiCredentials.mockReset()
  buildDshLaunchSpec.mockReset()
  buildDshLaunchSpec.mockReturnValue(LAUNCH)
  ensureOpenAICompatRouter.mockReset()
  ensureOpenAICompatRouter.mockResolvedValue({ baseUrl: 'http://127.0.0.1:51234', port: 51234 })
})

describe('resolveDshOptions egress', () => {
  it('sends the runtime to the compat router carrying the source descriptor', async () => {
    getApiCredentials.mockResolvedValue({
      ...credentials(),
      customHeaders: { 'User-Agent': 'ExampleIDE/1.0.0' },
      adapterId: 'tencent',
      apiType: 'chat_completions' as const,
    })

    await resolveDshOptions({ cwd: '/work' })

    expect(buildDshLaunchSpec.mock.calls[0][0].baseUrl).toBe('http://127.0.0.1:51234/v1')
    expect(launchedBackendConfig()).toMatchObject({
      url: 'https://gateway.example.com/v1/chat/completions',
      key: 'k',
      headers: { 'User-Agent': 'ExampleIDE/1.0.0' },
      adapterId: 'tencent',
      apiType: 'chat_completions',
    })
  })

  it('never hands the provider credential to the runtime directly', async () => {
    // The child inherits an allowlisted environment it can read; the only
    // credential in it must be one that is worthless outside this router.
    getApiCredentials.mockResolvedValue(credentials())

    await resolveDshOptions({ cwd: '/work' })

    expect(buildDshLaunchSpec.mock.calls[0][0].apiKey).not.toBe('k')
    expect(launchedBackendConfig().key).toBe('k')
  })
})

describe('resolveDshOptions model limits', () => {

  it('pins the runtime to the active model resolved capabilities', async () => {
    getApiCredentials.mockResolvedValue(
      credentials({ maxOutputTokens: 131_072, contextWindow: 200_000 })
    )

    const resolved = await resolveDshOptions({ cwd: '/work' })

    expect(resolved.init.maxTokens).toBe(131_072)
    expect(buildDshLaunchSpec.mock.calls[0][0].contextWindow).toBe(200_000)
  })

  it('bounds a capability the user drove out of range', async () => {
    // Settings lets a per-model override name any number; the runtime must
    // still be handed something a provider can accept.
    getApiCredentials.mockResolvedValue(
      credentials({ maxOutputTokens: 9_000_000, contextWindow: 1_024 })
    )

    const resolved = await resolveDshOptions({ cwd: '/work' })

    expect(resolved.init.maxTokens).toBe(1_000_000)
    expect(buildDshLaunchSpec.mock.calls[0][0].contextWindow).toBe(40_000)
  })

  it('states nothing when Halo resolved no capabilities for the model', async () => {
    // Silence leaves the runtime on its own defaults, which is right when Halo
    // has nothing better to offer — inventing a cap would break a model that
    // legitimately allows more.
    getApiCredentials.mockResolvedValue(credentials())

    const resolved = await resolveDshOptions({ cwd: '/work' })

    expect(resolved.init.maxTokens).toBeUndefined()
    expect(buildDshLaunchSpec.mock.calls[0][0].contextWindow).toBeUndefined()
  })

  it('lets an explicit caller cap win over the model preset', async () => {
    getApiCredentials.mockResolvedValue(
      credentials({ maxOutputTokens: 131_072, contextWindow: 200_000 })
    )

    const resolved = await resolveDshOptions({ cwd: '/work', maxTokens: 2_048 })

    expect(resolved.init.maxTokens).toBe(2_048)
  })
})
