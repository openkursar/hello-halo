import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { savedConfig } = vi.hoisted(() => ({ savedConfig: { value: {} as Record<string, unknown> } }))
vi.mock('../storage.ts', () => ({
  Database: class {
    getRun() {
      return { runId: 'fixture-run', config: JSON.stringify(savedConfig.value), createdAt: '2026-01-01' }
    }
    getRunResults() { return [] }
    getEvalScore() { return null }
    close() {}
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('evaluation report attribution', () => {
  it.each(['qwen-oauth', 'openrouter', 'deepseek'])('reports the recorded %s provider without a personal repository link', async providerType => {
    savedConfig.value = { providerType, modelName: 'fixture-model' }
    const { reportCommand } = await import('./report.ts')
    await reportCommand.parseAsync(['--run-id', 'fixture-run'], { from: 'user' })
    const output = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(output).toContain('using Halo Agent SDK.')
    expect(output).toContain(`via \`${providerType}\``)
    expect(output).not.toContain('github.com/')
    expect(output).not.toContain('via OpenRouter')
  })

  it('does not invent a provider for older records without one', async () => {
    savedConfig.value = { modelName: 'fixture-model' }
    const { reportCommand } = await import('./report.ts')
    await reportCommand.parseAsync(['--run-id', 'fixture-run'], { from: 'user' })
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('via `unknown`')
  })
})
