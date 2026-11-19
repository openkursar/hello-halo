import { describe, expect, it } from 'vitest'
import { profileName, profilePurpose, targetKey, targetLabel } from '../../../src/renderer/components/subagent-models/model-presentation'
import { SUBAGENT_MODEL_DEFAULT_PURPOSES } from '../../../src/shared/subagent-models'
import type { AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { SubagentModelProfile } from '../../../src/shared/types/subagent-models'

const t = (value: string) => `translated:${value}`
const config: AISourcesConfig = { version: 2, currentId: null, sources: [] }
const builtin: SubagentModelProfile = { id: 'builtin:small', revision: 0, kind: 'builtin', slot: 'small', description: SUBAGENT_MODEL_DEFAULT_PURPOSES.small }

describe('model assignment presentation', () => {
  it('keeps fixed names and translates default purposes and empty targets', () => {
    expect(profileName(builtin)).toBe('Small')
    expect(profilePurpose(builtin, t)).toBe(`translated:${SUBAGENT_MODEL_DEFAULT_PURPOSES.small}`)
    expect(targetLabel(undefined, config, t)).toBe('translated:Not configured')
  })
  it('preserves user purposes and custom names as data', () => {
    expect(profilePurpose({ ...builtin, revision: 2, description: 'Review auth boundaries' }, t)).toBe('Review auth boundaries')
    expect(profileName({ id: 'custom', revision: 1, kind: 'custom', name: 'My reviewer', description: '', target: { kind: 'group', groupId: 'gone' } })).toBe('My reviewer')
  })
  it('reports invalid references rather than borrowing a current target', () => {
    expect(targetLabel({ kind: 'model', sourceId: 'gone', modelId: 'm' }, config, t)).toBe('translated:Unavailable account')
    expect(targetLabel({ kind: 'group', groupId: 'gone' }, config, t)).toBe('translated:Unavailable group')
    expect(config.currentId).toBeNull()
  })
  it('keeps withdrawn model names on existing assignments and marks them unavailable', () => {
    const withWithdrawn: AISourcesConfig = { ...config, sources: [{
      id: 'account', name: 'Account', provider: 'custom', authType: 'api-key', apiKey: 'synthetic-key', apiUrl: 'https://example.invalid',
      model: 'old', availableModels: [], withdrawnModels: [{ id: 'old', name: 'Old Model', at: '' }], createdAt: '', updatedAt: '',
    }] }
    expect(targetLabel({ kind: 'model', sourceId: 'account', modelId: 'old' }, withWithdrawn, t))
      .toBe('Account / Old Model · translated:Unavailable model')
  })
  it('keeps group and account model identities disjoint and collision free', () => {
    expect(targetKey({ kind: 'model', sourceId: 'a/b', modelId: 'c' })).not.toBe(targetKey({ kind: 'model', sourceId: 'a', modelId: 'b/c' }))
    expect(targetKey({ kind: 'group', groupId: 'm' })).not.toBe(targetKey({ kind: 'model', sourceId: 'group', modelId: 'm' }))
  })
})
