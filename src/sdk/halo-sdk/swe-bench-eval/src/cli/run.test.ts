import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../storage.ts', () => ({ Database: vi.fn() }))
vi.mock('../batch-runner.ts', () => ({ runBatch: vi.fn() }))
vi.mock('../dataset.ts', () => ({
  loadDataset: vi.fn(() => [{ instance_id: 'fixture-issue' }]),
  filterInstances: vi.fn(instances => instances),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  for (const name of ['QWEN_TOKEN', 'OPENROUTER_API_KEY', 'LLM_API_KEY', 'SWE_EVAL_PROVIDER', 'SWE_EVAL_MODEL']) {
    vi.stubEnv(name, '')
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function command() {
  const { runCommand } = await import('./run.ts')
  return runCommand.exitOverride().configureOutput({ writeErr: () => {} })
}

describe('explicit evaluation selection', () => {
  it.each([
    [[], '--model'],
    [['--provider', 'qwen-oauth'], '--model'],
    [['--model', 'coder-model'], '--provider'],
  ])('rejects incomplete selection %j before loading data', async (args, missing) => {
    vi.stubEnv('QWEN_TOKEN', 'fixture-oauth-token')
    vi.stubEnv('SWE_EVAL_PROVIDER', 'qwen-oauth')
    vi.stubEnv('SWE_EVAL_MODEL', 'coder-model')
    await expect((await command()).parseAsync([...args, '--dry-run'], { from: 'user' }))
      .rejects.toThrow(missing)
    const { loadDataset } = await import('../dataset.ts')
    expect(loadDataset).not.toHaveBeenCalled()
  })

  it.each([
    ['qwen-oauth', 'coder-model', 'QWEN_TOKEN'],
    ['openrouter', 'fixture/router-model', 'OPENROUTER_API_KEY'],
    ['deepseek', 'fixture-model', 'LLM_API_KEY'],
  ])('preserves explicitly selected %s without inference in dry-run', async (provider, model, variable) => {
    vi.stubEnv(variable, 'fixture-credential-not-for-output')
    await (await command()).parseAsync(['--provider', provider, '--model', model, '--dry-run'], { from: 'user' })
    const output = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(output).toContain(`Provider:    ${provider}`)
    expect(output).toContain(`Model:       ${model}`)
    expect(output).toContain('fixture-issue')
    expect(output).not.toContain('fixture-credential-not-for-output')
    const { runBatch } = await import('../batch-runner.ts')
    const { Database } = await import('../storage.ts')
    expect(runBatch).not.toHaveBeenCalled()
    expect(Database).not.toHaveBeenCalled()
  })
})
