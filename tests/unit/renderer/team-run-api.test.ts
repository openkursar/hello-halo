import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))
import { teamApi } from '../../../src/renderer/api/team.api'

const fields = new Set<string>()
function install(name: string, value: unknown): void {
  fields.add(name)
  ;(globalThis as Record<string, unknown>)[name] = value
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const name of fields) delete (globalThis as Record<string, unknown>)[name]
  fields.clear()
})

describe('team run result transport', () => {
  it('keeps the accepted work id and instruction through the desktop bridge', async () => {
    const result = { success: true, data: { epochId: 'requested-work' } }
    const run = vi.fn().mockResolvedValue(result)
    install('window', { halo: { teamRun: run } })
    expect(await teamApi.teamRun('team', 'Inspect the new issue.')).toBe(result)
    expect(run).toHaveBeenCalledWith('team', { type: 'manual' }, 'Inspect the new issue.')
  })

  it('marks a remote-browser user request as manual and keeps its explicit returned id', async () => {
    install('window', {})
    install('document', { baseURI: 'https://example.invalid/halo/' })
    install('localStorage', { getItem: () => 'fixture-token' })
    const result = { success: true, data: { epochId: 'requested-work' } }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(result)))
    expect(await teamApi.teamRun('team', 'Inspect the new issue.')).toEqual(result)
    expect(fetch).toHaveBeenCalledWith('https://example.invalid/halo/api/teams/team/run', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ trigger: { type: 'manual' }, instruction: 'Inspect the new issue.' }),
    }))
  })
})
