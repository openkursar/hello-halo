import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

interface LegacyCustomAccount {
  provider: 'openai'
  apiKey: string
  apiUrl: string
  model: string
  availableModels: string[]
  id?: string
  name?: string
  type?: 'custom'
}

interface LegacySourceInput {
  api: LegacyCustomAccount
  aiSources: { current: 'custom'; custom: LegacyCustomAccount }
}

// Historical producer: 9fb7ab1929cddd8a9554c78738c30ab0daca0d08,
// SettingsPage.handleSaveCustomApi and ApiSetup; this input is independent of today's normalizer.
const source = readFileSync(new URL('./data/ai-sources-v1.json', import.meta.url), 'utf8')

export function legacyAiSourcesFixture(): LegacySourceInput {
  return JSON.parse(source)
}

export function legacyAiSourcesIdentity() {
  return { format: 'current/custom API account', sha256: createHash('sha256').update(source).digest('hex') }
}

export function installLegacyAiSources(profile: string, child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, apiUrl: string, apiKey: string, hasIdentity: boolean) {
  assert.ok(child.exitCode != null || child.signalCode != null, 'Historical configuration requires the owned application to have exited')
  const endpoint = new URL(apiUrl)
  assert.ok(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'The historical account must use an unauthenticated loopback URL')
  assert.ok(apiKey.startsWith('local-only-'), 'Only generated local fixture credentials may be installed')
  const file = join(profile, '.halo', 'config.json')
  const target = lstatSync(file)
  assert.ok(target.isFile() && !target.isSymbolicLink(), 'Historical configuration requires a real owned config file')
  const inside = relative(realpathSync(profile), realpathSync(file))
  assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`), 'Historical configuration must stay inside the owned profile')
  const current = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(current.aiSources?.version, 2, 'Review the fixture boundary before replacing a different current account format')
  const legacy = legacyAiSourcesFixture()
  for (const value of [legacy.api, legacy.aiSources.custom]) {
    value.apiUrl = apiUrl
    value.apiKey = apiKey
  }
  if (!hasIdentity) delete legacy.aiSources.custom.id
  const control = { appearance: current.appearance, permissions: current.permissions, imChannels: current.imChannels }
  writeFileSync(file, JSON.stringify({ ...current, ...legacy }, null, 2))
  const { apiKey: _credential, ...account } = legacy.aiSources.custom
  return { account, control, hasCredential: Boolean(legacy.aiSources.custom.apiKey) }
}

export function aiSourceMigrationCount(profile: string) {
  return readFileSync(join(profile, '.halo', 'logs', 'main.log'), 'utf8').split('Persisted v2 aiSources to disk:').length - 1
}

export function readAiSourceMigration(profile: string) {
  const config = JSON.parse(readFileSync(join(profile, '.halo', 'config.json'), 'utf8'))
  return {
    version: config.aiSources?.version,
    currentId: config.aiSources?.currentId,
    sources: (config.aiSources?.sources ?? []).map((account: Record<string, unknown>) => ({
      id: account.id, name: account.name, provider: account.provider, authType: account.authType,
      apiUrl: account.apiUrl, model: account.model, createdAt: account.createdAt,
      models: ((account.availableModels ?? []) as Array<{ id: string }>).map(model => model.id).sort(),
      hasCredential: Boolean(account.apiKey),
    })),
    control: { appearance: config.appearance, permissions: config.permissions, imChannels: config.imChannels },
  }
}
