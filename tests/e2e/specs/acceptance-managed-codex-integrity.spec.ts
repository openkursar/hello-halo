import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-app'

for (const record of ['no-integrity', 'no-version', 'missing-helper', 'wrong-pin'] as const) {
  test(`reject a managed Codex record with ${record} before executing it`, acceptance('models.engines.managed-codex-integrity', { record }), async ({ acceptanceApp, model }, info) => {
    let selectedPath = ''
    const page = await acceptanceApp.restart(profile => {
      const root = join(profile, '.halo', 'runtimes', 'codex')
      const directory = join(root, 'versions', 'inert-integrity-fixture')
      const component = 'vendor/aarch64-apple-darwin/codex/codex'
      const helper = 'vendor/aarch64-apple-darwin/path/rg'
      selectedPath = join(directory, component)
      const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
      const checksum = createHash('sha256').update(bytes).digest('hex')
      mkdirSync(join(directory, 'vendor/aarch64-apple-darwin/codex'), { recursive: true })
      mkdirSync(join(directory, 'vendor/aarch64-apple-darwin/path'), { recursive: true })
      writeFileSync(selectedPath, bytes, { mode: 0o700 })
      writeFileSync(join(directory, helper), bytes, { mode: 0o700 })
      const installation = { path: selectedPath, version: record === 'no-version' ? undefined : '0.128.0', compatibility: 'verified', managed: true, recommended: true }
      const components = [{ path: component, checksum, size: bytes.length }, ...(record === 'missing-helper' ? [] : [{ path: helper, checksum, size: bytes.length }])]
      const integrity = { platform: 'darwin-arm64', directory, artifactIntegrity: record === 'wrong-pin' ? `sha512-${Buffer.alloc(64).toString('base64')}` : 'sha512-w+6zohfHx/kHBdles/CyFKaY57u9I3nK8QI9+NrdwMliKA0b7xn13yblRNkMpe09j6vL1oAWoxYsMOQ/vjBGug==', components }
      writeFileSync(join(root, 'catalog.json'), JSON.stringify({ version: 1, truncated: false, entries: [{ installation, ...(record === 'no-integrity' ? {} : { integrity }) }] }))
    })
    expect(await acceptanceApp.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const before = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8')).agent
    const status = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getExternalRuntimeStatus('codex'))
    expect(status.success).toBe(true)
    expect(status.data?.installations.find(item => item.path === selectedPath)).toMatchObject({ compatibility: 'unavailable', issue: 'checksum-mismatch' })
    const probe = await page.evaluate(path => (window as unknown as { halo: HaloAPI }).halo.probeExternalRuntime('codex', path), selectedPath)
    expect(probe).toMatchObject({ success: true, data: { compatibility: 'unavailable', issue: 'checksum-mismatch', managed: true } })
    const selection = await page.evaluate(path => (window as unknown as { halo: HaloAPI }).halo.selectExternalRuntime('codex', path), selectedPath)
    expect(selection).toMatchObject({ success: false, issue: 'checksum-mismatch' })
    const after = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8')).agent
    expect(after.sdkEngine).toBe(before.sdkEngine)
    expect(after.codexRuntime).toEqual(before.codexRuntime)
    expect(model.exchanges).toHaveLength(0)
    await info.attach('managed-codex-integrity-rejection', { body: JSON.stringify({ record, status, probe, selection }), contentType: 'application/json' })
  })
}
