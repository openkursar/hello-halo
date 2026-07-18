import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(__dirname, '../../../src/renderer/components')

function readComponent(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
}

describe('model-fetch error UI wiring', () => {
  it('shows the structured service error in provider settings', () => {
    const source = readComponent('settings/ProviderSelector.tsx')

    expect(source).toContain(
      'formatModelFetchError(t, response.code, response.error)'
    )
    expect(source).not.toContain(
      "throw new Error(response.error || 'Failed to fetch models')"
    )
  })

  it('uses the shared API path and structured error in onboarding', () => {
    const source = readComponent('setup/ApiSetup.tsx')

    expect(source).toContain(
      'const response = await api.fetchModels(apiKey, apiUrl)'
    )
    expect(source).toContain(
      'formatModelFetchError(t, response.code, response.error)'
    )
    expect(source).not.toContain('const response = await fetch(url')
  })
})
