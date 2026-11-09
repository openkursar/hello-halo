import { describe, expect, it, vi } from 'vitest'
import type { RunConfig } from './types.ts'

vi.mock('better-sqlite3', () => ({ default: class {} }))
import { serializeRunConfig } from './storage.ts'

describe('saved evaluation configuration', () => {
  it('persists reproducible settings without credentials or URL secrets', () => {
    const config: RunConfig = {
      runId: 'sample', modelName: 'test-model', providerType: 'openai-compat',
      apiKey: 'credential-that-must-not-be-saved',
      apiUrl: 'https://user:password@example.com/v1?token=private#secret',
      concurrency: 1, maxTurns: 8, instanceIds: ['fixture'],
      datasetPath: '/fixtures', outputDir: '/results', repoCache: '/cache',
    }
    const serialized = serializeRunConfig({ ...config, futureCredential: 'another-secret' } as RunConfig)
    expect(JSON.parse(serialized)).toMatchObject({
      runId: 'sample', modelName: 'test-model', apiUrl: 'https://example.com/v1',
      instanceIds: ['fixture'], maxTurns: 8,
    })
    for (const secret of ['apiKey', 'credential-that-must-not-be-saved', 'password', 'token=', 'private', 'secret', 'futureCredential']) {
      expect(serialized).not.toContain(secret)
    }
    expect(config.apiKey).toBe('credential-that-must-not-be-saved')
  })
})
