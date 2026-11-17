import { describe, expect, it } from 'vitest'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { discoverCodexCandidates, resolveCodexCandidate } from '../../../src/main/services/external-runtime/providers/codex/local'
import { requiredComponents } from '../../../src/main/services/external-runtime/providers/codex/policy'

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('resolves a JS wrapper whose native npm alias is installed as a sibling package without executing JS', async () => {
  const root = join(globalThis.__HALO_TEST_DIR__, 'npm-sibling')
  const wrapper = join(root, 'node_modules/@openai/codex/bin/codex.js')
  const payload = join(root, 'node_modules/@openai/codex-darwin-arm64')
  await mkdir(join(wrapper, '..'), { recursive: true })
  await writeFile(wrapper, 'throw new Error("Never execute an npm discovery shim")')
  for (const component of requiredComponents('darwin-arm64')) {
    const path = join(payload, component)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, Buffer.from('cffaedfe', 'hex'), { mode: 0o755 })
  }
  expect((await resolveCodexCandidate(wrapper)).resolvedPath).toBe(await realpath(join(payload, requiredComponents('darwin-arm64')[0])))
})

describe('Codex Node version manager discovery declarations', () => {
  it('considers the home .fnm node-versions root using bounded child enumeration', async () => {
    const parents: Array<{ path: string; limit: number }> = []
    await discoverCodexCandidates({
      root: join(globalThis.__HALO_TEST_DIR__, 'managed'), signal: new AbortController().signal,
      childDirectories: async (path, limit) => { parents.push({ path, limit }); return { paths: [], truncated: false } }
    })
    expect(parents).toContainEqual({ path: join(homedir(), '.fnm/node-versions'), limit: 24 })
    expect(parents.every(parent => parent.limit <= 24)).toBe(true)
  })
})
